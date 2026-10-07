// The legacy raw-MIME path (fallback send, and the copy me-routes.js stores) must label UTF-8
// honestly: quoted-printable bodies, RFC 2047 headers, no raw 8-bit bytes (2026-10-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMimeMessage, encodeHeaderValue, formatAddress, quotedPrintable, sendViaCloudflareSMTP } from './outbound.js';

function decodeQP(s) {
  const soft = s.replace(/=\r\n/g, '');
  const bytes = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-F]{2}$/.test(soft.slice(i + 1, i + 3))) { bytes.push(parseInt(soft.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(soft.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeWords(v) {
  return v.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

function header(mime, name) {
  const head = mime.split('\r\n\r\n')[0];
  const m = head.match(new RegExp('^' + name + ': (.*(?:\\r\\n .*)*)', 'm'));
  return m ? m[1] : null;
}

function parts(mime) {
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  return mime.split('--' + boundary).slice(1, -1).map((p) => {
    const [h, ...rest] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    return { headers: h, body: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
  });
}

const TEXT = 'Your code: 1234 5678 — expires in 15 minutes. Café 名\nSecond line with a trailing space ';
const HTML = '<p>' + 'x'.repeat(1200) + ' — café</p>';

test('UTF-8 bodies are quoted-printable, decode back exactly, and the message is pure 7-bit ASCII', () => {
  const mime = buildMimeMessage({ from: 'auth@weylandai.com', fromName: 'WeylandAI', to: 'a@example.com', subject: 'Hello', text: TEXT, html: HTML });
  assert.match(mime, /^[\x09\x0a\x0d\x20-\x7e]*$/);
  assert.doesNotMatch(mime, /7bit/i);
  const [plain, rich] = parts(mime);
  assert.match(plain.headers, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(plain.headers, /Content-Transfer-Encoding: quoted-printable/);
  assert.match(rich.headers, /Content-Transfer-Encoding: quoted-printable/);
  assert.equal(decodeQP(plain.body), TEXT.replace(/\n/g, '\r\n'));
  assert.equal(decodeQP(rich.body), HTML);
  for (const line of mime.split('\r\n')) assert.ok(line.length <= 78, 'line too long: ' + line.length);
});

test('a non-ASCII subject and sender name are RFC 2047 encoded and decode back', () => {
  const subject = 'Sign-in code — café ' + '名'.repeat(30);
  const mime = buildMimeMessage({ from: 'auth@weylandai.com', fromName: 'Renée WeylandAI', to: 'a@example.com', subject, text: 'x' });
  const subj = header(mime, 'Subject');
  assert.match(subj, /^=\?UTF-8\?B\?/);
  assert.equal(decodeWords(subj), subject);
  for (const word of subj.split('\r\n ')) assert.ok(word.length <= 75);
  const from = header(mime, 'From');
  assert.equal(decodeWords(from), 'Renée WeylandAI <auth@weylandai.com>');
});

test('ASCII stays readable; names with specials are quoted; CR/LF cannot inject a header', () => {
  const mime = buildMimeMessage({ from: 'auth@authfor.com', fromName: 'Smith, John', to: 'a@example.com', subject: 'Hi\r\nBcc: victim@example.com', text: 'Hello world' });
  assert.equal(header(mime, 'Subject'), 'Hi Bcc: victim@example.com');
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.equal(header(mime, 'From'), '"Smith, John" <auth@authfor.com>');
  assert.match(mime, /\r\n\r\nHello world\r\n/);
  assert.match(header(mime, 'Message-ID'), /^<[0-9a-f-]{36}@authfor\.com>$/);
  assert.equal(formatAddress('WeylandAI', 'auth@weylandai.com'), 'WeylandAI <auth@weylandai.com>');
  assert.equal(encodeHeaderValue('plain ascii'), 'plain ascii');
  assert.equal(quotedPrintable('a = b'), 'a =3D b');
  assert.equal(quotedPrintable('ends with space '), 'ends with space=20');
});

test('the legacy fallback sends that MIME when the binding refuses the structured form', async () => {
  const calls = [];
  const env = {
    SENDING_DOMAINS: 'mailguyai.com,weylandai.com',
    SEND_EMAIL: {
      async send(msg) {
        calls.push(msg);
        if (calls.length === 1) throw new TypeError('structured form not supported');
      },
    },
  };
  const r = await sendViaCloudflareSMTP(env, { from: 'auth@weylandai.com', fromName: 'WeylandAI', to: 'a@example.com', subject: 'Café', text: TEXT, html: HTML });
  assert.equal(r.api, 'legacy-email-message');
  const raw = calls[1].raw;
  const reader = raw.getReader();
  const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(...value); }
  const mime = new TextDecoder().decode(new Uint8Array(chunks));
  assert.match(mime, /^[\x09\x0a\x0d\x20-\x7e]*$/);
  assert.equal(decodeWords(header(mime, 'Subject')), 'Café');
  assert.equal(calls[1].from, 'auth@weylandai.com');
});

test('a caller Reply-To reaches the structured send and the legacy MIME header', async () => {
  const sent = [];
  const env = { SENDING_DOMAINS: 'mailguyai.com,weylandai.com', SEND_EMAIL: { async send(m) { sent.push(m); return { messageId: 'x' }; } } };
  await sendViaCloudflareSMTP(env, { from: 'auth@weylandai.com', fromName: 'WeylandAI', to: 'a@example.com', subject: 's', text: 't', replyTo: 'support@weylandai.com' });
  assert.equal(sent[0].replyTo, 'support@weylandai.com');
  await sendViaCloudflareSMTP(env, { from: 'auth@weylandai.com', fromName: 'WeylandAI', to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(sent[1].replyTo, undefined);
  const mime = buildMimeMessage({ from: 'auth@weylandai.com', fromName: 'WeylandAI', to: 'a@example.com', subject: 's', text: 't', replyTo: 'support@weylandai.com\r\nBcc: x@y.co' });
  assert.equal(header(mime, 'Reply-To'), 'support@weylandai.com Bcc: x@y.co');
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.equal(header(buildMimeMessage({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't' }), 'Reply-To'), null);
});
