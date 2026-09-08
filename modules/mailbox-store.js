/**
 * MailguyAI — mailbox/message storage layer.
 *
 * D1 (env.MAILGUY_DB) holds mailbox + message metadata.
 * R2 (env.MAILGUY_R2) holds raw MIME bodies, keyed by message id.
 *
 * Schema (migrations/0001_init.sql):
 *   mailboxes(id, address, domain, owner_type, owner_ref, plan, created_at)
 *   messages(id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at, read_at)
 */

function r2KeyFor(messageId) {
  return `messages/${messageId}.eml`;
}

/** Look up a mailbox by its address (e.g. "admin@mobleyhelms.com"). Returns null if not provisioned. */
export async function getMailboxByAddress(env, address) {
  const row = await env.MAILGUY_DB
    .prepare('SELECT * FROM mailboxes WHERE address = ?')
    .bind(address.toLowerCase())
    .first();
  return row || null;
}

/** Look up a mailbox by its id. */
export async function getMailboxById(env, id) {
  const row = await env.MAILGUY_DB
    .prepare('SELECT * FROM mailboxes WHERE id = ?')
    .bind(id)
    .first();
  return row || null;
}

/**
 * Store a received (or sent) message: raw MIME body to R2, metadata to D1.
 * Returns the stored message's id and r2_key.
 */
export async function storeMessage(env, { mailboxId, direction, from, to, subject, rawMime, receivedAt }) {
  const id = crypto.randomUUID();
  const r2Key = r2KeyFor(id);

  await env.MAILGUY_R2.put(r2Key, rawMime, {
    httpMetadata: { contentType: 'message/rfc822' },
  });

  await env.MAILGUY_DB
    .prepare(
      `INSERT INTO messages (id, mailbox_id, direction, from_addr, to_addr, subject, r2_key, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, mailboxId, direction, from, to, subject || '', r2Key, receivedAt || new Date().toISOString())
    .run();

  return { id, r2Key };
}

/** List messages for a mailbox, newest first. */
export async function listMessages(env, mailboxId, { limit = 50, offset = 0 } = {}) {
  const { results } = await env.MAILGUY_DB
    .prepare(
      `SELECT id, mailbox_id, direction, from_addr, to_addr, subject, received_at, read_at
       FROM messages WHERE mailbox_id = ?
       ORDER BY received_at DESC LIMIT ? OFFSET ?`
    )
    .bind(mailboxId, limit, offset)
    .all();
  return results || [];
}

/**
 * Get one message's full content: D1 metadata + the raw MIME body from R2.
 * Marks read_at if not already set. Returns null if the message doesn't exist.
 */
export async function getMessage(env, messageId) {
  const meta = await env.MAILGUY_DB
    .prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId)
    .first();
  if (!meta) return null;

  const obj = await env.MAILGUY_R2.get(meta.r2_key);
  const raw = obj ? await obj.text() : null;

  if (!meta.read_at) {
    await env.MAILGUY_DB
      .prepare('UPDATE messages SET read_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), messageId)
      .run();
  }

  return { ...meta, raw };
}

/** Delete a message: removes both the D1 row and the R2 object. */
export async function deleteMessage(env, messageId) {
  const meta = await env.MAILGUY_DB
    .prepare('SELECT r2_key FROM messages WHERE id = ?')
    .bind(messageId)
    .first();
  if (!meta) return false;

  await env.MAILGUY_R2.delete(meta.r2_key);
  await env.MAILGUY_DB.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();
  return true;
}
