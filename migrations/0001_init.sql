-- MailguyAI Phase 1 storage schema
-- mailboxes: provisioned addresses that can receive+store mail
-- messages: metadata for every stored inbound/outbound message; raw MIME body lives in R2 at r2_key

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  owner_type TEXT NOT NULL,      -- 'internal' | 'external'
  owner_ref TEXT,                 -- e.g. venture domain, user id, subsidiary name
  plan TEXT NOT NULL DEFAULT 'internal',  -- 'internal' (no billing) | a billed plan slug
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  r2_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
