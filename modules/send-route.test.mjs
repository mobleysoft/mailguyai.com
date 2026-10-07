// POST /api/v1/send through the real worker: reply_to is passed on, or refused when it is not
// one plain address (2026-10-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

async function send(body, sent) {
  const env = {
    MAILGUY_API_KEY: 'fixture-key',
    SENDING_DOMAINS: 'mailguyai.com,weylandai.com',
    SEND_EMAIL: { async send(m) { sent.push(m); return { messageId: 'm1' }; } },
    MAILGUY_KV: { async get() { return null; }, async put() {} },
  };
  const pending = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  try {
    const res = await worker.fetch(new Request('https://mailguyai.com/api/v1/send', { method: 'POST', headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
    await Promise.allSettled(pending);
    return { status: res.status, json: await res.json() };
  } finally { globalThis.fetch = realFetch; }
}

test('reply_to is passed to the send binding', async () => {
  const sent = [];
  const r = await send({ from: 'auth@weylandai.com', from_name: 'WeylandAI', to: 'a@example.com', subject: 's', text: 't', reply_to: 'support@weylandai.com' }, sent);
  assert.equal(r.status, 200);
  assert.equal(sent[0].replyTo, 'support@weylandai.com');
  assert.deepEqual(sent[0].from, { email: 'auth@weylandai.com', name: 'WeylandAI' });
});

test('a reply_to that is not one plain address is refused and nothing is sent', async () => {
  for (const bad of ['Support <support@weylandai.com>', 'a@b.co, c@d.co', 'support@weylandai.com\r\nBcc: x@y.co', 42]) {
    const sent = [];
    const r = await send({ from: 'auth@weylandai.com', to: 'a@example.com', subject: 's', text: 't', reply_to: bad }, sent);
    assert.equal(r.status, 400, String(bad));
    assert.equal(sent.length, 0);
  }
});

test('without reply_to the send is as before', async () => {
  const sent = [];
  const r = await send({ from: 'auth@weylandai.com', to: 'a@example.com', subject: 's', text: 't' }, sent);
  assert.equal(r.status, 200);
  assert.equal(sent[0].replyTo, undefined);
});
