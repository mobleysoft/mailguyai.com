/**
 * MailguyAI — per-user (AuthFor-authenticated) routes.
 *
 * Kept separate from worker.js's existing MAILGUY_API_KEY-gated routes
 * (POST /api/v1/mailboxes, POST /api/v1/send, etc. - untouched, still
 * the service/agentic API) - these are the human end-user routes, gated
 * by a real AuthFor identity instead of the one shared admin key.
 *
 * See AUTHFOR_MULTIUSER_SCOPE.md for the design this implements.
 *
 * handleMeRoutes returns a Response for any route it recognizes, or
 * null if the path/method doesn't match anything here - worker.js
 * falls through to its own routing (and eventual 404) on null.
 */

import { authenticateViaAuthFor, hasMailboxRole, grantMailboxAccess, listAccessibleMailboxes } from './authfor.js';
import { getMailboxByAddress, listMessages, getMessage, storeMessage, getOutreachLog, checkOutreachContact } from './mailbox-store.js';
import { sendViaCloudflareSMTP, buildMimeMessage } from './outbound.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function err(message, code = 'ERROR', status = 400) {
  return json({ error: message, code }, status);
}

/** Authenticate via AuthFor, returning either a real user or an error Response to short-circuit with. Never returns null - a null token is a 401, matching every route here needing a real identity. */
async function requireUser(request, env) {
  const auth = await authenticateViaAuthFor(request, env);
  if (!auth) return { error: err('Unauthorized', 'UNAUTHORIZED', 401) };
  if (auth.error) return { error: err(auth.error.message, 'NO_ACCOUNT', auth.error.status) };
  return { user: auth.user };
}

async function requireMailboxRole(env, address, userId, allowedRoles) {
  const mailbox = await getMailboxByAddress(env, address);
  if (!mailbox) return { error: err('Mailbox not found', 'NOT_FOUND', 404) };
  const allowed = await hasMailboxRole(env, mailbox.id, userId, allowedRoles);
  if (!allowed) return { error: err('Forbidden', 'FORBIDDEN', 403) };
  return { mailbox };
}

export async function handleMeRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // --- GET /api/v1/me ---
  if (method === 'GET' && path === '/api/v1/me') {
    const { user, error } = await requireUser(request, env);
    if (error) return error;
    const mailboxes = await listAccessibleMailboxes(env, user.id);
    return json({ user, mailboxes });
  }

  // --- GET /api/v1/me/mailboxes/:address/messages ---
  const messagesMatch = path.match(/^\/api\/v1\/me\/mailboxes\/([^/]+)\/messages$/);
  if (method === 'GET' && messagesMatch) {
    const { user, error: userErr } = await requireUser(request, env);
    if (userErr) return userErr;
    const address = decodeURIComponent(messagesMatch[1]);
    const { mailbox, error } = await requireMailboxRole(env, address, user.id, ['owner', 'read', 'send']);
    if (error) return error;
    const limit = Number(url.searchParams.get('limit')) || 50;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const messages = await listMessages(env, mailbox.id, { limit, offset });
    return json({ mailbox: mailbox.address, count: messages.length, messages });
  }

  // --- GET /api/v1/me/mailboxes/:address/outreach-log[?to=] ---
  const outreachLogMatch = path.match(/^\/api\/v1\/me\/mailboxes\/([^/]+)\/outreach-log$/);
  if (method === 'GET' && outreachLogMatch) {
    const { user, error: userErr } = await requireUser(request, env);
    if (userErr) return userErr;
    const address = decodeURIComponent(outreachLogMatch[1]);
    const { mailbox, error } = await requireMailboxRole(env, address, user.id, ['owner', 'read', 'send']);
    if (error) return error;

    const to = url.searchParams.get('to');
    if (to) {
      const contact = await checkOutreachContact(env, mailbox.id, to);
      return json({ mailbox: mailbox.address, to, alreadyContacted: !!contact, lastContact: contact });
    }
    const limit = Number(url.searchParams.get('limit')) || 100;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const log = await getOutreachLog(env, mailbox.id, { limit, offset });
    return json({ mailbox: mailbox.address, count: log.length, log });
  }

  // --- GET /api/v1/me/messages/:id ---
  const messageMatch = path.match(/^\/api\/v1\/me\/messages\/([^/]+)$/);
  if (method === 'GET' && messageMatch) {
    const { user, error: userErr } = await requireUser(request, env);
    if (userErr) return userErr;
    const messageId = decodeURIComponent(messageMatch[1]);
    const msg = await getMessage(env, messageId);
    if (!msg) return err('Not found', 'NOT_FOUND', 404);
    const allowed = await hasMailboxRole(env, msg.mailbox_id, user.id, ['owner', 'read', 'send']);
    if (!allowed) return err('Forbidden', 'FORBIDDEN', 403);
    return json(msg);
  }

  // --- POST /api/v1/me/mailboxes/:address/send ---
  const sendMatch = path.match(/^\/api\/v1\/me\/mailboxes\/([^/]+)\/send$/);
  if (method === 'POST' && sendMatch) {
    const { user, error: userErr } = await requireUser(request, env);
    if (userErr) return userErr;
    const address = decodeURIComponent(sendMatch[1]);
    const { mailbox, error } = await requireMailboxRole(env, address, user.id, ['owner', 'send']);
    if (error) return error;

    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON', 'INVALID_INPUT'); }
    const { to, subject, html, text } = body;
    if (!to || !subject || (!html && !text)) {
      return err('Missing required fields: to, subject, and html or text', 'INVALID_INPUT');
    }

    // The mailbox's own address, always - a per-user sender can't spoof
    // a different from address through this route.
    const fromAddr = mailbox.address;
    const fromLabel = body.from_name || user.name || 'WeylandAI Outreach';

    try {
      await sendViaCloudflareSMTP(env, { from: fromAddr, fromName: fromLabel, to, subject, text: text || '', html: html || '' });
    } catch (e) {
      return err(`Delivery failed: ${e?.message || 'unknown'}`, 'SMTP_DELIVERY_FAILED', 502);
    }

    // Real persistence (unlike the existing admin-key /api/v1/send path,
    // which only writes a KV log) - this is what makes the outreach log real.
    const rawMime = buildMimeMessage({ from: fromAddr, fromName: fromLabel, to, subject, text: text || '', html: html || '' });
    const stored = await storeMessage(env, {
      mailboxId: mailbox.id, direction: 'outbound', from: fromAddr, to, subject,
      rawMime, sentByUserId: user.id,
    });

    return json({ success: true, id: stored.id, mailbox: mailbox.address }, 201);
  }

  // --- POST /api/v1/mailboxes/:address/access (admin-key gated, not AuthFor) ---
  const accessMatch = path.match(/^\/api\/v1\/mailboxes\/([^/]+)\/access$/);
  if (method === 'POST' && accessMatch) {
    if (!isAdminAuthorized(request, env)) return err('Unauthorized', 'UNAUTHORIZED', 401);
    const address = decodeURIComponent(accessMatch[1]);
    const mailbox = await getMailboxByAddress(env, address);
    if (!mailbox) return err('Mailbox not found', 'NOT_FOUND', 404);

    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON', 'INVALID_INPUT'); }
    const { email, name, role, granted_by } = body;
    if (!email || !role || !['owner', 'read', 'send'].includes(role)) {
      return err('Required: email, role (owner|read|send)', 'INVALID_INPUT');
    }

    const result = await grantMailboxAccess(env, { mailboxId: mailbox.id, email, name, role, grantedBy: granted_by || 'admin' });
    return json(result, 201);
  }

  return null; // not one of ours - let worker.js fall through
}

function isAdminAuthorized(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  return authHeader.startsWith('Bearer ') && authHeader.slice(7) === env.MAILGUY_API_KEY;
}
