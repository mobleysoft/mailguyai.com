import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftReply } from './ai-draft.js';

function fakeFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

test('draftReply: throws a real error when the LLM bridge secrets are not configured, not a silent fake draft', async () => {
  await assert.rejects(
    () => draftReply({}, { from_addr: 'a@b.com', subject: 'hi', raw: 'body' }),
    /LLAMA_ACCESS_CLIENT_ID\/SECRET missing/
  );
});

test('draftReply: real happy path calls the shared llama.mobleysoft.com bridge with CF-Access headers and returns the draft', async () => {
  let capturedUrl, capturedInit;
  const restore = fakeFetchOnce(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '  Thanks for reaching out, I will follow up tomorrow.  ' } }] }),
    };
  });
  try {
    const env = { LLAMA_ACCESS_CLIENT_ID: 'id123', LLAMA_ACCESS_CLIENT_SECRET: 'secret456' };
    const message = { from_addr: 'prospect@example.com', subject: 'Question about pricing', raw: 'From: prospect@example.com\nSubject: Question about pricing\n\nWhat does the Pro plan cost?' };
    const result = await draftReply(env, message);

    assert.equal(capturedUrl, 'https://llama.mobleysoft.com/v1/chat/completions');
    assert.equal(capturedInit.headers['CF-Access-Client-Id'], 'id123');
    assert.equal(capturedInit.headers['CF-Access-Client-Secret'], 'secret456');
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.messages[1].content.includes('prospect@example.com'), true);
    assert.equal(body.messages[1].content.includes('What does the Pro plan cost?'), true);

    assert.deepEqual(result, { draft: 'Thanks for reaching out, I will follow up tomorrow.', needsReply: true });
  } finally {
    restore();
  }
});

test('draftReply: real behavior treats NO_REPLY_NEEDED as no draft, not an empty string to send', async () => {
  const restore = fakeFetchOnce(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'NO_REPLY_NEEDED' } }] }),
  }));
  try {
    const env = { LLAMA_ACCESS_CLIENT_ID: 'id', LLAMA_ACCESS_CLIENT_SECRET: 'secret' };
    const result = await draftReply(env, { from_addr: 'newsletter@spam.com', subject: 'Weekly digest', raw: 'unsubscribe here' });
    assert.deepEqual(result, { draft: null, needsReply: false });
  } finally {
    restore();
  }
});

test('draftReply: real behavior surfaces a bridge HTTP error rather than returning a fake draft', async () => {
  const restore = fakeFetchOnce(async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }));
  try {
    const env = { LLAMA_ACCESS_CLIENT_ID: 'id', LLAMA_ACCESS_CLIENT_SECRET: 'secret' };
    await assert.rejects(
      () => draftReply(env, { from_addr: 'a@b.com', subject: 'hi', raw: 'body' }),
      /HTTP 503/
    );
  } finally {
    restore();
  }
});
