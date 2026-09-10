-- MailguyAI Phase 2 — AuthFor-backed multi-user access + outreach tracker
-- See AUTHFOR_MULTIUSER_SCOPE.md for the real design this implements.

-- Local identity, bridged to a verified AuthFor email on each request
-- (see modules/authfor.js) — AuthFor proves who someone is, this table
-- decides who's allowed into this app.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);

-- Per-user, per-mailbox permission grants. AuthFor has no invite/role
-- primitive of its own — this is where that's actually decided.
CREATE TABLE IF NOT EXISTS mailbox_access (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,        -- 'owner' | 'read' | 'send'
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,  -- user_id of whoever granted it
  PRIMARY KEY (mailbox_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_access_user ON mailbox_access(user_id);

-- Records who sent an outbound message, for the outreach tracker
-- (nullable: the existing admin-key /api/v1/send path has no user
-- identity to attach — only the new per-user send route populates this).
ALTER TABLE messages ADD COLUMN sent_by_user_id TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_messages_to_addr ON messages(to_addr);
