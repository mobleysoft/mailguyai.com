/**
 * MailguyAI — inbound email handler.
 *
 * Cloudflare invokes this directly at the edge when Email Routing is
 * configured to route a domain/address to this Worker (no SMTP server on
 * our end). For each message: read the raw MIME stream, do a lightweight
 * header parse (Subject only — full RFC822 parsing is out of scope for
 * Phase 1), resolve which provisioned mailbox the `to` address belongs to,
 * store it (mailbox-store.js: metadata to D1, raw body to R2), and ALSO
 * keep forwarding to jmobleyworks@gmail.com as a safety net during this
 * storage transition — do not remove that fallback until storage has been
 * proven reliable over real use.
 */

import { getMailboxByAddress, storeMessage } from './mailbox-store.js';

const FALLBACK_FORWARD = 'jmobleyworks@gmail.com';

/**
 * Lightweight MIME header parse: everything up to the first blank line,
 * unfolding folded (indented continuation) header lines. Deliberately not
 * a full RFC822 parser — Phase 1 only needs Subject out of this.
 */
function parseHeaders(rawText) {
  const headerBlockEnd = rawText.search(/\r?\n\r?\n/);
  const headerBlock = headerBlockEnd === -1 ? rawText : rawText.slice(0, headerBlockEnd);
  const lines = headerBlock.split(/\r?\n/);

  const headers = {};
  let currentKey = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      // folded continuation of the previous header
      headers[currentKey] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1].trim().toLowerCase();
      headers[currentKey] = m[2].trim();
    }
  }
  return headers;
}

/** Read a ForwardableEmailMessage's raw stream into a string. */
async function readRawMessage(message) {
  return await new Response(message.raw).text();
}

export async function handleInboundEmail(message, env, ctx) {
  const mailId = crypto.randomUUID();
  const from = message.from;
  const to = message.to;

  let rawText = '';
  let subject = '';
  try {
    rawText = await readRawMessage(message);
    subject = parseHeaders(rawText).subject || '';
  } catch (e) {
    console.error('[MailguyAI] Failed to read/parse raw inbound message:', e);
  }

  // Storage path: only if `to` resolves to a provisioned mailbox.
  let stored = null;
  try {
    const mailbox = await getMailboxByAddress(env, to);
    if (mailbox && rawText) {
      stored = await storeMessage(env, {
        mailboxId: mailbox.id,
        direction: 'inbound',
        from,
        to,
        subject,
        rawMime: rawText,
        receivedAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('[MailguyAI] Inbound storage failed:', e);
  }

  // Safety-net forward — kept unconditionally during the storage transition,
  // regardless of whether storage above succeeded.
  try {
    await message.forward(FALLBACK_FORWARD);
    ctx.waitUntil(env.MAILGUY_KV.put(
      `inbound:${mailId}`,
      JSON.stringify({
        id: mailId,
        from,
        to,
        subject,
        forwardedTo: FALLBACK_FORWARD,
        status: 'forwarded',
        stored: !!stored,
        storedMessageId: stored ? stored.id : null,
        receivedAt: new Date().toISOString(),
      }),
      { expirationTtl: 86400 * 30 }
    ));
  } catch (e) {
    console.error('[MailguyAI] Inbound forward failed:', e);
    ctx.waitUntil(env.MAILGUY_KV.put(
      `inbound:${mailId}`,
      JSON.stringify({
        id: mailId,
        from,
        to,
        subject,
        status: 'forward_failed',
        error: String(e),
        stored: !!stored,
        storedMessageId: stored ? stored.id : null,
        receivedAt: new Date().toISOString(),
      }),
      { expirationTtl: 86400 * 30 }
    ));
    message.setReject('Delivery to destination failed');
  }
}
