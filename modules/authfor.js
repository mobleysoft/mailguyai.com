/**
 * MailguyAI — AuthFor-backed per-user identity.
 *
 * Ported from weylandai.com's src/lib/authfor-client.js (the only
 * verified-working server-side AuthFor integration in this estate) —
 * same real pattern, not a new mechanism: verify a Bearer token against
 * AuthFor's own API, then bridge the verified identity to a *local*
 * `users` row by email. AuthFor proves who someone is; this table
 * decides who's allowed into this app. No tenant_id concept here —
 * mailguyai.com isn't multi-tenant, unlike the app this was ported from.
 *
 * See AUTHFOR_MULTIUSER_SCOPE.md for the real design this implements,
 * including why Ron's actual AuthFor account creation is a Mobley-
 * triggered step, not something this module or app does.
 */

const AUTHFOR_VERIFY_URL = 'https://authfor.com/api/v1/verify';

/**
 * Verify a request's Bearer token against AuthFor, then bridge to a
 * local users row by email.
 *
 * Returns:
 *   - { user: { id, email, name } } on a successful verify + existing
 *     local account
 *   - { error: { status, message } } on a successful verify with NO
 *     matching local account — a real, user-facing error, not a
 *     fall-through (matches the source pattern's behavior exactly)
 *   - null if there's no usable token, or AuthFor didn't verify it, or
 *     the verify call itself failed — caller should treat this as
 *     "not authenticated", not as an error to surface
 */
export async function authenticateViaAuthFor(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  let identity;
  try {
    const verifyResp = await fetch(AUTHFOR_VERIFY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!verifyResp.ok) return null;
    identity = await verifyResp.json();
  } catch (e) {
    console.log('[MailguyAI] AuthFor verify error:', e?.message || e);
    return null;
  }

  if (!identity || !identity.email) return null;

  const localUser = await env.MAILGUY_DB
    .prepare('SELECT id, email, name FROM users WHERE email = ?')
    .bind(identity.email)
    .first();

  if (!localUser) {
    return { error: { status: 404, message: 'No MailguyAI account for this identity yet' } };
  }

  return {
    user: {
      id: localUser.id,
      email: localUser.email,
      name: localUser.name || identity.name || null,
    },
  };
}

/** The role a user has on a mailbox, or null if they have none at all. */
export async function getMailboxRole(env, mailboxId, userId) {
  const row = await env.MAILGUY_DB
    .prepare('SELECT role FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?')
    .bind(mailboxId, userId)
    .first();
  return row ? row.role : null;
}

/** True if the user's role on this mailbox is one of the allowed roles. */
export async function hasMailboxRole(env, mailboxId, userId, allowedRoles) {
  const role = await getMailboxRole(env, mailboxId, userId);
  return role !== null && allowedRoles.includes(role);
}

/**
 * Grant a role on a mailbox to a user, identified by email — upserts the
 * local users row if this is the first time this email has been granted
 * anything (this is the real "add Ron" mechanism: his email, never his
 * password, which this app never sees).
 */
export async function grantMailboxAccess(env, { mailboxId, email, name, role, grantedBy }) {
  email = email.toLowerCase();
  let user = await env.MAILGUY_DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();

  if (!user) {
    const id = crypto.randomUUID();
    await env.MAILGUY_DB
      .prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, email, name || null, new Date().toISOString())
      .run();
    user = { id };
  }

  await env.MAILGUY_DB
    .prepare(
      `INSERT INTO mailbox_access (mailbox_id, user_id, role, granted_at, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (mailbox_id, user_id) DO UPDATE SET role = excluded.role, granted_at = excluded.granted_at, granted_by = excluded.granted_by`
    )
    .bind(mailboxId, user.id, role, new Date().toISOString(), grantedBy)
    .run();

  return { ok: true, userId: user.id, email, role };
}

/** List every mailbox a user has access to, with their role on each. */
export async function listAccessibleMailboxes(env, userId) {
  const { results } = await env.MAILGUY_DB
    .prepare(
      `SELECT m.id, m.address, m.domain, a.role
       FROM mailbox_access a JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE a.user_id = ?
       ORDER BY m.address`
    )
    .bind(userId)
    .all();
  return results || [];
}
