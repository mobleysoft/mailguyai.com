/**
 * MailguyAI — outbound send path.
 *
 * Relocated unchanged from the original monolithic worker.js (2026-09-08
 * modularization). Dispatches mail via Cloudflare's native `send_email`
 * binding — no external SMTP API, no API key dependency.
 */

import { EmailMessage } from 'cloudflare:email';

const CRLF = '\r\n';
const utf8 = (s) => new TextEncoder().encode(String(s));

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** One header line's worth of text: no CR/LF (a caller's value can never start a new header). */
function oneLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
}

/**
 * A header value safe to put on the wire: ASCII stays as is; anything else becomes RFC 2047
 * encoded-words (=?UTF-8?B?...?=), each at most 75 characters and never splitting a character.
 */
export function encodeHeaderValue(value) {
  const s = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (chunk && utf8(chunk + ch).length > 45) { words.push(chunk); chunk = ch; } else chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => '=?UTF-8?B?' + bytesToBase64(utf8(w)) + '?=').join(CRLF + ' ');
}

/** "Display Name <addr>" with the name quoted or encoded as RFC 5322 / 2047 require. */
export function formatAddress(name, address) {
  const addr = oneLine(address).trim();
  const n = oneLine(name).trim();
  if (!n) return addr;
  if (!/^[\x20-\x7e]*$/.test(n)) return encodeHeaderValue(n) + ' <' + addr + '>';
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(n)) return n + ' <' + addr + '>';
  return '"' + n.replace(/["\\]/g, '\\$&') + '" <' + addr + '>';
}

/**
 * Quoted-printable (RFC 2045 section 6.7) of UTF-8 text with CRLF line ends: ASCII text stays
 * readable, every other byte becomes =XX, no line is longer than 76 characters, and trailing
 * spaces are encoded so no relay can strip them.
 */
export function quotedPrintable(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n|\r|\n/g, '\n').split('\n');
  return lines.map((line) => {
    const bytes = utf8(line);
    let out = '';
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const tok = plain ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0');
      if (cur.length + tok.length > 75) { out += cur + '=' + CRLF; cur = ''; }
      cur += tok;
    }
    return out + cur;
  }).join(CRLF);
}

/**
 * Build an RFC 5322 MIME message (the legacy raw send, and the copy me-routes.js stores).
 * Before 2026-10-07 this declared "Content-Transfer-Encoding: 7bit" for UTF-8 bodies and put
 * a raw UTF-8 subject and sender name in the headers, so any non-ASCII character (a dash, an
 * accented name, the thin space in a sign-in code) was sent as 8-bit data labelled 7-bit.
 * Now: bodies are quoted-printable, non-ASCII header text is RFC 2047 encoded, CR/LF in
 * header values is flattened, and the message carries a Message-ID.
 */
export function buildMimeMessage({ from, fromName, to, subject, text, html, replyTo }) {
  const boundary = `mailguy_${crypto.randomUUID().replace(/-/g, '')}`;
  const fromAddr = oneLine(from).trim();
  const domain = (fromAddr.split('@')[1] || 'mailguyai.com').replace(/[^A-Za-z0-9.-]/g, '') || 'mailguyai.com';
  const toHeader = Array.isArray(to) ? to.map(oneLine).join(', ') : oneLine(to);

  const lines = [
    `From: ${formatAddress(fromName, fromAddr)}`,
    `To: ${toHeader}`,
    ...(replyTo ? [`Reply-To: ${oneLine(replyTo).trim()}`] : []),
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `MIME-Version: 1.0`,
    // Folded (RFC 5322 2.2.3) so the line stays within 78 characters.
    `Content-Type: multipart/alternative;`,
    ` boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    quotedPrintable(text || ''),
  ];
  if (html) {
    lines.push(
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      quotedPrintable(html),
    );
  }
  lines.push(`--${boundary}--`, ``);
  return lines.join(CRLF);
}

/**
 * Dispatch email via Cloudflare's native send_email binding.
 * This is the sovereign path — no Resend, no Postmark, no API keys.
 */
/**
 * Domains onboarded to Cloudflare Email Sending. Mail "from" any other domain is sent from
 * the same local part on the first onboarded domain, keeping the caller's display name and
 * putting the caller's address in Reply-To. Without this, a send "from" a domain that is not
 * onboarded only reaches addresses verified in Email Routing ("destination address is not a
 * verified address"), which is why AuthFor's sign-in codes never reached a customer.
 * mailguyai.com was onboarded 2026-10-07 (EMAIL_SENDING_DNS.md).
 */
export function sendingAddress(env, from) {
  const domains = String(env.SENDING_DOMAINS || 'mailguyai.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const addr = String(from || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  const local = at > 0 ? addr.slice(0, at).replace(/[^a-z0-9._+-]/g, '') || 'noreply' : 'noreply';
  const domain = at > 0 ? addr.slice(at + 1) : '';
  if (domains.includes(domain)) return { email: addr, replyTo: null };
  return { email: local + '@' + domains[0], replyTo: at > 0 ? addr : null };
}

/**
 * Send one message. Uses Email Service's structured send() (any recipient, from an onboarded
 * domain); falls back to the legacy raw EmailMessage form only if the binding rejects the
 * structured form itself. Returns the provider's message id. Errors keep Cloudflare's code.
 */
export async function sendViaCloudflareSMTP(env, { from, fromName, to, subject, text, html, replyTo }) {
  const sender = sendingAddress(env, from);
  const message = {
    to,
    from: fromName ? { email: sender.email, name: fromName } : sender.email,
    subject,
  };
  if (text) message.text = text;
  if (html) message.html = html;
  // The caller's own Reply-To wins; otherwise a From that had to move to an onboarded domain
  // keeps the caller's address as Reply-To.
  const reply = replyTo || sender.replyTo;
  if (reply) message.replyTo = reply;
  try {
    const result = await env.SEND_EMAIL.send(message);
    return { messageId: result && result.messageId ? result.messageId : null, from: sender.email, api: 'email-service' };
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    // Only a binding that cannot take the structured form falls back; a real delivery
    // refusal (unverified sender, recipient not allowed, rate limit) is reported as is.
    if (code || !(e instanceof TypeError)) {
      const err = new Error((code ? code + ': ' : '') + (e && e.message ? e.message : String(e)));
      err.code = code;
      throw err;
    }
  }
  return legacySend(env, { from: sender.email, fromName, to, subject, text, html, replyTo: reply });
}

async function legacySend(env, { from, fromName, to, subject, text, html, replyTo }) {
  const mimeRaw = buildMimeMessage({ from, fromName, to, subject, text, html, replyTo });
  const encoder = new TextEncoder();
  const encoded = encoder.encode(mimeRaw);
  // CF EmailMessage requires a ReadableStream for the body
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    }
  });
  const message = new EmailMessage(from, to, stream);
  await env.SEND_EMAIL.send(message);
  return { messageId: null, from, api: 'legacy-email-message' };
}
