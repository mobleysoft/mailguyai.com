import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMeRoutes } from './me-routes.js';

function fakeFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

/**
 * A real-enough in-memory D1 fake covering every query pattern actually
 * used across authfor.js/mailbox-store.js when reached through
 * handleMeRoutes - a genuine integration test of the routing/permission/
 * storage wiring, not isolated per-function mocks.
 */
function fakeEnv({ mailboxes = [], users = [], access = [], messages = [] } = {}) {
  const state = {
    mailboxes: [...mailboxes],
    users: [...users],
    access: [...access],
    messages: [...messages],
  };
  const r2 = new Map();
  const sentEmails = [];

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql === 'SELECT id, email, name FROM users WHERE email = ?') {
                return state.users.find((u) => u.email === args[0]) || null;
              }
              if (sql === 'SELECT id FROM users WHERE email = ?') {
                const u = state.users.find((u) => u.email === args[0]);
                return u ? { id: u.id } : null;
              }
              if (sql.includes('SELECT role FROM mailbox_access')) {
                const [mailboxId, userId] = args;
                const row = state.access.find((a) => a.mailbox_id === mailboxId && a.user_id === userId);
                return row ? { role: row.role } : null;
              }
              if (sql === 'SELECT * FROM mailboxes WHERE address = ?') {
                return state.mailboxes.find((m) => m.address === args[0]) || null;
              }
              if (sql === 'SELECT * FROM messages WHERE id = ?') {
                return state.messages.find((m) => m.id === args[0]) || null;
              }
              if (sql.includes('to_addr = ?') && sql.includes("direction = 'outbound'")) {
                const [mailboxId, toAddr] = args;
                const matches = state.messages
                  .filter((m) => m.mailbox_id === mailboxId && m.direction === 'outbound' && m.to_addr === toAddr)
                  .sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
                if (!matches.length) return null;
                const m = matches[0];
                const u = state.users.find((u) => u.id === m.sent_by_user_id);
                return { to_addr: m.to_addr, subject: m.subject, sent_at: m.received_at, sent_by_name: u?.name || null, sent_by_email: u?.email || null };
              }
              return null;
            },
            async all() {
              if (sql.includes('FROM mailbox_access a JOIN mailboxes m')) {
                const userId = args[0];
                return {
                  results: state.access
                    .filter((a) => a.user_id === userId)
                    .map((a) => {
                      const mb = state.mailboxes.find((m) => m.id === a.mailbox_id);
                      return { id: mb.id, address: mb.address, domain: mb.domain, role: a.role };
                    }),
                };
              }
              if (sql.includes('FROM messages m LEFT JOIN users u') && !sql.includes('to_addr = ?')) {
                const mailboxId = args[0];
                return {
                  results: state.messages
                    .filter((m) => m.mailbox_id === mailboxId && m.direction === 'outbound')
                    .sort((a, b) => (a.received_at < b.received_at ? 1 : -1))
                    .map((m) => {
                      const u = state.users.find((u) => u.id === m.sent_by_user_id);
                      return { id: m.id, to_addr: m.to_addr, subject: m.subject, sent_at: m.received_at, sent_by_name: u?.name || null, sent_by_email: u?.email || null };
                    }),
                };
              }
              if (sql.includes('WHERE mailbox_id = ?') && sql.includes('FROM messages') && sql.includes('read_at')) {
                const mailboxId = args[0];
                return { results: state.messages.filter((m) => m.mailbox_id === mailboxId) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO users')) {
                const [id, email, name, created_at] = args;
                state.users.push({ id, email, name, created_at });
              } else if (sql.startsWith('INSERT INTO mailbox_access')) {
                const [mailbox_id, user_id, role, granted_at, granted_by] = args;
                const existing = state.access.find((a) => a.mailbox_id === mailbox_id && a.user_id === user_id);
                if (existing) Object.assign(existing, { role, granted_at, granted_by });
                else state.access.push({ mailbox_id, user_id, role, granted_at, granted_by });
              } else if (sql.startsWith('INSERT INTO messages')) {
                const [id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at, sent_by_user_id] = args;
                state.messages.push({ id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at, sent_by_user_id, read_at: null });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };

  return {
    MAILGUY_DB: db,
    MAILGUY_R2: {
      async put(key, body) { r2.set(key, body); },
      async get(key) { return r2.has(key) ? { text: async () => r2.get(key) } : null; },
    },
    SEND_EMAIL: { async send(message) { sentEmails.push(message); } },
    MAILGUY_API_KEY: 'admin-secret',
    _state: state,
    _sentEmails: sentEmails,
  };
}

function authedRequest(url, { method = 'GET', token = 'ron-token', body } = {}) {
  return new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// --- routing ---

test('handleMeRoutes: real behavior returns null for an unrelated path, letting worker.js fall through', async () => {
  const result = await handleMeRoutes(new Request('https://mailguyai.com/api/v1/health'), fakeEnv(), {});
  assert.equal(result, null);
});

// --- GET /api/v1/me ---

test('GET /api/v1/me: real happy path returns the identity plus real accessible mailboxes', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [{ id: 'u-ron', email: 'ron@example.com', name: 'Ron' }],
    access: [{ mailbox_id: 'mb1', user_id: 'u-ron', role: 'send' }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const resp = await handleMeRoutes(authedRequest('https://mailguyai.com/api/v1/me'), env, {});
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.user.email, 'ron@example.com');
    assert.equal(data.mailboxes.length, 1);
    assert.equal(data.mailboxes[0].role, 'send');
  } finally {
    restore();
  }
});

test('GET /api/v1/me: no local account yet is a real 404, not a silent empty result', async () => {
  const env = fakeEnv();
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'stranger@example.com' }) }));
  try {
    const resp = await handleMeRoutes(authedRequest('https://mailguyai.com/api/v1/me'), env, {});
    assert.equal(resp.status, 404);
  } finally {
    restore();
  }
});

// --- POST /api/v1/me/mailboxes/:address/send ---

test('POST .../send: real permission check rejects a read-only user', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [{ id: 'u-ron', email: 'ron@example.com', name: 'Ron' }],
    access: [{ mailbox_id: 'mb1', user_id: 'u-ron', role: 'read' }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const req = authedRequest('https://mailguyai.com/api/v1/me/mailboxes/outreach@weylandai.com/send', {
      method: 'POST', body: { to: 'lead@acme.com', subject: 'Hi', text: 'hello' },
    });
    const resp = await handleMeRoutes(req, env, {});
    assert.equal(resp.status, 403);
    assert.equal(env._sentEmails.length, 0); // real: nothing was actually dispatched
  } finally {
    restore();
  }
});

test('POST .../send: real happy path sends via SEND_EMAIL, persists to D1/R2 with sent_by_user_id, cannot spoof from', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [{ id: 'u-ron', email: 'ron@example.com', name: 'Ron' }],
    access: [{ mailbox_id: 'mb1', user_id: 'u-ron', role: 'send' }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const req = authedRequest('https://mailguyai.com/api/v1/me/mailboxes/outreach@weylandai.com/send', {
      method: 'POST',
      body: { to: 'lead@acme.com', subject: 'Intro', text: 'Hello there', from: 'someone-else@spoofed.com' },
    });
    const resp = await handleMeRoutes(req, env, {});
    assert.equal(resp.status, 201);

    assert.equal(env._sentEmails.length, 1); // real dispatch happened
    assert.equal(env._state.messages.length, 1);
    const stored = env._state.messages[0];
    assert.equal(stored.sent_by_user_id, 'u-ron');
    assert.equal(stored.from_addr, 'outreach@weylandai.com'); // NOT the spoofed from
    assert.equal(stored.to_addr, 'lead@acme.com');
    assert.equal(stored.direction, 'outbound');
  } finally {
    restore();
  }
});

// --- GET /api/v1/me/mailboxes/:address/outreach-log ---

test('GET .../outreach-log?to=: real behavior reports a genuine prior contact, not a false negative', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [
      { id: 'u-ron', email: 'ron@example.com', name: 'Ron' },
      { id: 'u-john', email: 'john@weylandai.com', name: 'John' },
    ],
    access: [{ mailbox_id: 'mb1', user_id: 'u-ron', role: 'send' }],
    messages: [{
      id: 'm1', mailbox_id: 'mb1', direction: 'outbound', from_addr: 'outreach@weylandai.com',
      to_addr: 'lead@acme.com', subject: 'Intro from John', received_at: '2026-09-01T00:00:00Z', sent_by_user_id: 'u-john',
    }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const req = authedRequest('https://mailguyai.com/api/v1/me/mailboxes/outreach@weylandai.com/outreach-log?to=lead@acme.com');
    const resp = await handleMeRoutes(req, env, {});
    const data = await resp.json();
    assert.equal(data.alreadyContacted, true);
    assert.equal(data.lastContact.sent_by_name, 'John'); // this is the actual "don't butt heads" signal
  } finally {
    restore();
  }
});

test('GET .../outreach-log?to=: a genuinely new prospect reports alreadyContacted:false', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [{ id: 'u-ron', email: 'ron@example.com', name: 'Ron' }],
    access: [{ mailbox_id: 'mb1', user_id: 'u-ron', role: 'send' }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const req = authedRequest('https://mailguyai.com/api/v1/me/mailboxes/outreach@weylandai.com/outreach-log?to=new-lead@acme.com');
    const resp = await handleMeRoutes(req, env, {});
    const data = await resp.json();
    assert.equal(data.alreadyContacted, false);
    assert.equal(data.lastContact, null);
  } finally {
    restore();
  }
});

test('GET .../outreach-log: real behavior denies a user with no grant at all on this mailbox', async () => {
  const env = fakeEnv({
    mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }],
    users: [{ id: 'u-stranger', email: 'stranger@example.com', name: 'Stranger' }],
  });
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'stranger@example.com', name: 'Stranger' }) }));
  try {
    const req = authedRequest('https://mailguyai.com/api/v1/me/mailboxes/outreach@weylandai.com/outreach-log');
    const resp = await handleMeRoutes(req, env, {});
    assert.equal(resp.status, 403);
  } finally {
    restore();
  }
});

// --- POST /api/v1/mailboxes/:address/access (admin grant) ---

test('POST .../access: real behavior requires the admin key, not an AuthFor token', async () => {
  const env = fakeEnv({ mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }] });
  const req = new Request('https://mailguyai.com/api/v1/mailboxes/outreach@weylandai.com/access', {
    method: 'POST', headers: { Authorization: 'Bearer some-authfor-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ron@example.com', role: 'send' }),
  });
  const resp = await handleMeRoutes(req, env, {});
  assert.equal(resp.status, 401);
});

test('POST .../access: real happy path grants Ron access by email, never touching a password', async () => {
  const env = fakeEnv({ mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }] });
  const req = new Request('https://mailguyai.com/api/v1/mailboxes/outreach@weylandai.com/access', {
    method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ron@example.com', name: 'Ron', role: 'send', granted_by: 'u-john' }),
  });
  const resp = await handleMeRoutes(req, env, {});
  assert.equal(resp.status, 201);
  assert.equal(env._state.users.length, 1);
  assert.equal(env._state.access.length, 1);
  assert.equal(env._state.access[0].role, 'send');
});

test('POST .../access: real validation rejects an unrecognized role', async () => {
  const env = fakeEnv({ mailboxes: [{ id: 'mb1', address: 'outreach@weylandai.com', domain: 'weylandai.com' }] });
  const req = new Request('https://mailguyai.com/api/v1/mailboxes/outreach@weylandai.com/access', {
    method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ron@example.com', role: 'superadmin' }),
  });
  const resp = await handleMeRoutes(req, env, {});
  assert.equal(resp.status, 400);
});
