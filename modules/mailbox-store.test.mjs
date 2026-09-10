import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeMessage, getOutreachLog, checkOutreachContact } from './mailbox-store.js';

// Minimal, real-enough in-memory D1 + R2 fake so storeMessage's real
// INSERT and the outreach-log queries' real JOIN/filter/order logic are
// genuinely exercised end-to-end, not individually mocked per call.
function fakeEnv() {
  const messages = [];
  const users = [
    { id: 'u-john', email: 'john@weylandai.com', name: 'John' },
    { id: 'u-ron', email: 'ron@example.com', name: 'Ron' },
  ];
  const r2 = new Map();

  return {
    MAILGUY_R2: {
      async put(key, body) { r2.set(key, body); },
      async get(key) { return r2.has(key) ? { text: async () => r2.get(key) } : null; },
      async delete(key) { r2.delete(key); },
    },
    MAILGUY_DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                if (sql.startsWith('INSERT INTO messages')) {
                  const [id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at, sent_by_user_id] = args;
                  messages.push({ id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at, sent_by_user_id, read_at: null });
                }
                return { success: true };
              },
              async all() {
                if (sql.includes('FROM messages m LEFT JOIN users u') && sql.includes("direction = 'outbound'") && !sql.includes('to_addr = ?')) {
                  const mailboxId = args[0];
                  const rows = messages
                    .filter((m) => m.mailbox_id === mailboxId && m.direction === 'outbound')
                    .sort((a, b) => (a.received_at < b.received_at ? 1 : -1))
                    .map((m) => {
                      const u = users.find((u) => u.id === m.sent_by_user_id);
                      return {
                        id: m.id, to_addr: m.to_addr, subject: m.subject, sent_at: m.received_at,
                        sent_by_user_id: m.sent_by_user_id,
                        sent_by_name: u ? u.name : null, sent_by_email: u ? u.email : null,
                      };
                    });
                  return { results: rows };
                }
                return { results: [] };
              },
              async first() {
                if (sql.includes('to_addr = ?') && sql.includes("direction = 'outbound'")) {
                  const [mailboxId, toAddr] = args;
                  const matches = messages
                    .filter((m) => m.mailbox_id === mailboxId && m.direction === 'outbound' && m.to_addr === toAddr)
                    .sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
                  if (!matches.length) return null;
                  const m = matches[0];
                  const u = users.find((u) => u.id === m.sent_by_user_id);
                  return { to_addr: m.to_addr, subject: m.subject, sent_at: m.received_at, sent_by_name: u ? u.name : null, sent_by_email: u ? u.email : null };
                }
                return null;
              },
            };
          },
        };
      },
    },
    _messages: messages,
  };
}

test('storeMessage: real behavior persists sent_by_user_id when provided', async () => {
  const env = fakeEnv();
  await storeMessage(env, {
    mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'lead@acme.com',
    subject: 'Hi', rawMime: 'From: ...', sentByUserId: 'u-john',
  });
  assert.equal(env._messages.length, 1);
  assert.equal(env._messages[0].sent_by_user_id, 'u-john');
});

test('storeMessage: real behavior defaults sent_by_user_id to null (the existing admin-key send path)', async () => {
  const env = fakeEnv();
  await storeMessage(env, {
    mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'lead@acme.com',
    subject: 'Hi', rawMime: 'From: ...',
  });
  assert.equal(env._messages[0].sent_by_user_id, null);
});

test('getOutreachLog: real behavior returns outbound messages newest-first, joined with who sent them', async () => {
  const env = fakeEnv();
  await storeMessage(env, { mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'a@acme.com', subject: 'First', rawMime: '', receivedAt: '2026-09-01T00:00:00Z', sentByUserId: 'u-john' });
  await storeMessage(env, { mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'b@acme.com', subject: 'Second', rawMime: '', receivedAt: '2026-09-05T00:00:00Z', sentByUserId: 'u-ron' });
  await storeMessage(env, { mailboxId: 'mb1', direction: 'inbound', from: 'c@acme.com', to: 'outreach@weylandai.com', subject: 'Reply', rawMime: '', receivedAt: '2026-09-06T00:00:00Z' });

  const log = await getOutreachLog(env, 'mb1');
  assert.equal(log.length, 2); // inbound message correctly excluded
  assert.equal(log[0].to_addr, 'b@acme.com'); // newest first
  assert.equal(log[0].sent_by_name, 'Ron');
  assert.equal(log[1].to_addr, 'a@acme.com');
  assert.equal(log[1].sent_by_name, 'John');
});

test('checkOutreachContact: real behavior finds a prior contact and reports who reached out', async () => {
  const env = fakeEnv();
  await storeMessage(env, { mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'lead@acme.com', subject: 'Intro', rawMime: '', receivedAt: '2026-09-01T00:00:00Z', sentByUserId: 'u-john' });

  const result = await checkOutreachContact(env, 'mb1', 'lead@acme.com');
  assert.ok(result);
  assert.equal(result.sent_by_name, 'John');
  assert.equal(result.subject, 'Intro');
});

test('checkOutreachContact: real behavior returns null for a prospect never contacted - the actual "safe to send" signal', async () => {
  const env = fakeEnv();
  const result = await checkOutreachContact(env, 'mb1', 'never-contacted@acme.com');
  assert.equal(result, null);
});

test('checkOutreachContact: real behavior is case-insensitive on the recipient address', async () => {
  const env = fakeEnv();
  await storeMessage(env, { mailboxId: 'mb1', direction: 'outbound', from: 'outreach@weylandai.com', to: 'lead@acme.com', subject: 'Intro', rawMime: '', receivedAt: '2026-09-01T00:00:00Z', sentByUserId: 'u-john' });
  const result = await checkOutreachContact(env, 'mb1', 'Lead@ACME.com');
  assert.ok(result);
});
