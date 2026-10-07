/**
 * MailguyAI — outbound send path.
 *
 * Relocated unchanged from the original monolithic worker.js (2026-09-08
 * modularization). Dispatches mail via Cloudflare's native `send_email`
 * binding — no external SMTP API, no API key dependency.
 */

import { EmailMessage } from 'cloudflare:email';

/**
 * Build a RFC 2822-compliant MIME message string using only Web APIs.
 * No npm dependency required — Cloudflare Workers support TextEncoder natively.
 */
export function buildMimeMessage({ from, fromName, to, subject, text, html }) {
  const boundary = `mailguy_${crypto.randomUUID().replace(/-/g, '')}`;
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const date = new Date().toUTCString();

  let mime = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text || '',
    ``,
    `--${boundary}`,
  ].join('\r\n');

  if (html) {
    mime += [
      ``,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      html,
      ``,
    ].join('\r\n');
  }

  mime += `\r\n--${boundary}--\r\n`;
  return mime;
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
export async function sendViaCloudflareSMTP(env, { from, fromName, to, subject, text, html }) {
  const sender = sendingAddress(env, from);
  const message = {
    to,
    from: fromName ? { email: sender.email, name: fromName } : sender.email,
    subject,
  };
  if (text) message.text = text;
  if (html) message.html = html;
  if (sender.replyTo) message.replyTo = sender.replyTo;
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
  return legacySend(env, { from: sender.email, fromName, to, subject, text, html });
}

async function legacySend(env, { from, fromName, to, subject, text, html }) {
  const mimeRaw = buildMimeMessage({ from, fromName, to, subject, text, html });
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
