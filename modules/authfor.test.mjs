import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateViaAuthFor,
  getMailboxRole,
  hasMailboxRole,
  grantMailboxAccess,
  listAccessibleMailboxes,
} from './authfor.js';

function fakeFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

// A minimal, real-enough in-memory D1 fake: tracks users/mailbox_access
// rows so grant/lookup round-trips are genuinely exercised, not just
// individually mocked per call.
function fakeDb({ users = [], access = [] } = {}) {
  const state = { users: [...users], access: [...access] };
  return {
    _state: state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT id, email, name FROM users WHERE email')) {
                const email = args[0];
                return state.users.find((u) => u.email === email) || null;
              }
              if (sql.includes('SELECT id FROM users WHERE email')) {
                const email = args[0];
                const u = state.users.find((u) => u.email === email);
                return u ? { id: u.id } : null;
              }
              if (sql.includes('SELECT role FROM mailbox_access')) {
                const [mailboxId, userId] = args;
                const row = state.access.find((a) => a.mailbox_id === mailboxId && a.user_id === userId);
                return row ? { role: row.role } : null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith('INSERT INTO users')) {
                const [id, email, name, created_at] = args;
                state.users.push({ id, email, name, created_at });
              } else if (sql.startsWith('INSERT INTO mailbox_access')) {
                const [mailbox_id, user_id, role, granted_at, granted_by] = args;
                const existing = state.access.find((a) => a.mailbox_id === mailbox_id && a.user_id === user_id);
                if (existing) {
                  existing.role = role;
                  existing.granted_at = granted_at;
                  existing.granted_by = granted_by;
                } else {
                  state.access.push({ mailbox_id, user_id, role, granted_at, granted_by });
                }
              }
              return { success: true };
            },
            async all() {
              if (sql.includes('FROM mailbox_access a JOIN mailboxes m')) {
                const userId = args[0];
                const rows = state.access
                  .filter((a) => a.user_id === userId)
                  .map((a) => ({ id: a.mailbox_id, address: `mailbox-${a.mailbox_id}`, domain: 'example.com', role: a.role }));
                return { results: rows };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

// --- authenticateViaAuthFor ---

test('authenticateViaAuthFor: no Authorization header returns null (not authenticated), not an error', async () => {
  const result = await authenticateViaAuthFor(new Request('https://mailguyai.com/api/v1/me'), { MAILGUY_DB: fakeDb() });
  assert.equal(result, null);
});

test('authenticateViaAuthFor: real behavior - a token AuthFor rejects returns null, not a throw', async () => {
  const restore = fakeFetchOnce(async () => ({ ok: false, status: 401 }));
  try {
    const req = new Request('https://mailguyai.com/api/v1/me', { headers: { Authorization: 'Bearer bad-token' } });
    const result = await authenticateViaAuthFor(req, { MAILGUY_DB: fakeDb() });
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('authenticateViaAuthFor: a verified identity with NO local account gets a real 404, not a silent pass', async () => {
  const restore = fakeFetchOnce(async (url, opts) => {
    assert.equal(url, 'https://authfor.com/api/v1/verify');
    assert.equal(opts.headers.Authorization, 'Bearer good-token');
    return { ok: true, json: async () => ({ email: 'stranger@example.com', name: 'Stranger' }) };
  });
  try {
    const req = new Request('https://mailguyai.com/api/v1/me', { headers: { Authorization: 'Bearer good-token' } });
    const result = await authenticateViaAuthFor(req, { MAILGUY_DB: fakeDb() });
    assert.equal(result.error.status, 404);
  } finally {
    restore();
  }
});

test('authenticateViaAuthFor: real happy path bridges a verified email to the local users row', async () => {
  const db = fakeDb({ users: [{ id: 'u1', email: 'ron@example.com', name: 'Ron' }] });
  const env = { MAILGUY_DB: db };
  const restore = fakeFetchOnce(async () => ({ ok: true, json: async () => ({ email: 'ron@example.com', name: 'Ron' }) }));
  try {
    const req = new Request('https://mailguyai.com/api/v1/me', { headers: { Authorization: 'Bearer ron-token' } });
    const result = await authenticateViaAuthFor(req, env);
    assert.deepEqual(result.user, { id: 'u1', email: 'ron@example.com', name: 'Ron' });
  } finally {
    restore();
  }
});

// --- role checks ---

test('getMailboxRole: real lookup returns null when no grant exists', async () => {
  const env = { MAILGUY_DB: fakeDb() };
  assert.equal(await getMailboxRole(env, 'mb1', 'u1'), null);
});

test('hasMailboxRole: real behavior checks against the actual granted role, not just presence', async () => {
  const env = { MAILGUY_DB: fakeDb({ access: [{ mailbox_id: 'mb1', user_id: 'u1', role: 'read' }] }) };
  assert.equal(await hasMailboxRole(env, 'mb1', 'u1', ['owner', 'send']), false);
  assert.equal(await hasMailboxRole(env, 'mb1', 'u1', ['read', 'send']), true);
});

// --- grantMailboxAccess ---

test('grantMailboxAccess: real behavior creates a new local user when the email is unseen', async () => {
  const db = fakeDb();
  const env = { MAILGUY_DB: db };
  const result = await grantMailboxAccess(env, { mailboxId: 'mb1', email: 'Ron@Example.com', name: 'Ron', role: 'send', grantedBy: 'u-john' });
  assert.equal(result.ok, true);
  assert.equal(result.email, 'ron@example.com'); // real behavior: lowercased
  assert.equal(db._state.users.length, 1);
  assert.equal(db._state.access.length, 1);
  assert.equal(db._state.access[0].role, 'send');
});

test('grantMailboxAccess: real behavior reuses an existing user and upgrades their role, not a duplicate grant', async () => {
  const db = fakeDb({ users: [{ id: 'u1', email: 'ron@example.com', name: 'Ron' }] });
  const env = { MAILGUY_DB: db };
  await grantMailboxAccess(env, { mailboxId: 'mb1', email: 'ron@example.com', role: 'read', grantedBy: 'u-john' });
  await grantMailboxAccess(env, { mailboxId: 'mb1', email: 'ron@example.com', role: 'send', grantedBy: 'u-john' });
  assert.equal(db._state.users.length, 1); // no duplicate user row
  assert.equal(db._state.access.length, 1); // no duplicate grant row
  assert.equal(db._state.access[0].role, 'send'); // real upgrade, not stuck at the first grant
});

// --- listAccessibleMailboxes ---

test('listAccessibleMailboxes: real behavior returns only mailboxes this user was actually granted', async () => {
  const db = fakeDb({
    access: [
      { mailbox_id: 'mb1', user_id: 'u1', role: 'owner' },
      { mailbox_id: 'mb2', user_id: 'u2', role: 'owner' },
    ],
  });
  const env = { MAILGUY_DB: db };
  const rows = await listAccessibleMailboxes(env, 'u1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'mb1');
  assert.equal(rows[0].role, 'owner');
});
