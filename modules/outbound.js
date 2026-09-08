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
export async function sendViaCloudflareSMTP(env, { from, fromName, to, subject, text, html }) {
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
}
