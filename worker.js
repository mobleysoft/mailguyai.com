/**
 * MailguyAI — Sovereign Edge Email Gateway
 *
 * Competes directly with Postmark/Resend, and long-term with Google
 * Workspace's email layer. Zero external API key dependency for sending —
 * mail is dispatched via the native Cloudflare `send_email` Worker binding.
 *
 * This file is a thin entry point: fetch() and email() route to modules,
 * they don't contain business logic themselves. See modules/*.js.
 *
 * Bindings required:
 *   - SEND_EMAIL      : Cloudflare send_email binding (wrangler.toml [[send_email]])
 *   - MAILGUY_KV       : KV namespace for mail logs and static assets
 *   - MAILGUY_DB       : D1 database — mailboxes + messages metadata
 *   - MAILGUY_R2       : R2 bucket — raw MIME bodies
 *   - MAILGUY_API_KEY  : Secret — callers must Bearer-auth all /api/* requests
 *   - CF_API_EMAIL/CF_API_KEY : Secrets — Cloudflare API auth, used by
 *                               provisioning.js to verify Email Routing
 *
 * API:
 *   GET    /                                  Landing page
 *   GET    /api/v1/health                     Health probe
 *   POST   /api/v1/send                       Send an email (authenticated)
 *   GET    /api/v1/mail/:id                   Legacy KV delivery log lookup
 *   POST   /api/v1/mailboxes                  Provision a mailbox (authenticated)
 *   DELETE /api/v1/mailboxes/:address         Deprovision a mailbox (authenticated)
 *   GET    /api/v1/mailboxes/:address/messages  List stored messages (authenticated)
 *   GET    /api/v1/messages/:id               Get one message incl. raw body (authenticated)
 *   DELETE /api/v1/messages/:id               Delete a stored message (authenticated)
 *
 *   Per-user (AuthFor-authenticated) routes — see modules/me-routes.js and
 *   AUTHFOR_MULTIUSER_SCOPE.md:
 *   GET    /api/v1/me
 *   GET    /api/v1/me/mailboxes/:address/messages
 *   GET    /api/v1/me/mailboxes/:address/outreach-log
 *   GET    /api/v1/me/messages/:id
 *   POST   /api/v1/me/mailboxes/:address/send
 *   POST   /api/v1/mailboxes/:address/access  Grant a user access (admin-key gated)
 */

import { sendViaCloudflareSMTP } from './modules/outbound.js';
import { handleInboundEmail } from './modules/inbound.js';
import { getMailboxByAddress, listMessages, getMessage, deleteMessage } from './modules/mailbox-store.js';
import { createMailbox, deleteMailbox } from './modules/provisioning.js';
import { handleMeRoutes } from './modules/me-routes.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(message, code = 'ERROR', status = 400) {
  return json({ error: message, code }, status);
}

function isAuthorized(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  return authHeader.startsWith('Bearer ') && authHeader.slice(7) === env.MAILGUY_API_KEY;
}

async function landingPage(env) {
  return await env.MAILGUY_KV.get('static:index') ||
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>MailguyAI — Sovereign Edge Email</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Georgia',serif;background:#0a0a0a;color:#e8e2d4;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .wrap{max-width:540px;text-align:center;padding:3rem 2rem}
  h1{font-size:2.4rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.75rem}
  p{color:#888;line-height:1.7;margin-bottom:2rem}
  .badge{display:inline-block;padding:.35rem .85rem;border:1px solid #2a2a2a;border-radius:999px;font-size:.75rem;letter-spacing:.06em;color:#666;text-transform:uppercase}
</style></head>
<body><div class="wrap">
  <h1>MailguyAI</h1>
  <p>Sovereign edge email infrastructure. Zero third-party API dependency.<br>Built on Cloudflare's global SMTP backbone.</p>
  <span class="badge">Production · Edge-Native</span>
</div></body></html>`;
}

export default {
  // Real inbound handler — delegates entirely to modules/inbound.js.
  async email(message, env, ctx) {
    await handleInboundEmail(message, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // --- Landing page ---
    if (method === 'GET' && path === '/') {
      const html = await landingPage(env);
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // --- Health probe ---
    if (method === 'GET' && path === '/api/v1/health') {
      return json({ status: 'ok', version: '2.1.0', engine: 'cloudflare-native', timestamp: Date.now() });
    }

    // --- Per-user (AuthFor-authenticated) routes: own auth, dispatched
    // before the admin-key gate below. Returns null for anything it
    // doesn't recognize, so unmatched paths fall through unchanged. ---
    const meResponse = await handleMeRoutes(request, env, ctx);
    if (meResponse) return meResponse;

    // --- Auth gate for all other /api/* routes ---
    if (!isAuthorized(request, env)) {
      return err('Unauthorized', 'UNAUTHORIZED', 401);
    }

    // --- Send email ---
    if (method === 'POST' && path === '/api/v1/send') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 'INVALID_INPUT'); }

      const { to, subject, html, text, from_name, from } = body;
      if (!to || !subject || (!html && !text)) {
        return err('Missing required fields: to, subject, and html or text', 'INVALID_INPUT');
      }

      const fromAddr  = from || env.DEFAULT_FROM || `noreply@${env.FROM_DOMAIN || 'mailguyai.com'}`;
      const fromLabel = from_name || env.DEFAULT_FROM_NAME || 'MailguyAI';
      const mailId    = crypto.randomUUID();

      try {
        await sendViaCloudflareSMTP(env, {
          from: fromAddr,
          fromName: fromLabel,
          to,
          subject,
          text: text || '',
          html: html || '',
        });
      } catch (e) {
        console.error('[MailguyAI] Delivery failed:', e?.message || e);
        return err(`Delivery failed: ${e?.message || 'unknown'}`, 'SMTP_DELIVERY_FAILED', 502);
      }

      // Non-blocking KV log
      const logEntry = { id: mailId, status: 'sent', to, subject, sentAt: new Date().toISOString() };
      ctx.waitUntil(env.MAILGUY_KV.put(`mail:${mailId}`, JSON.stringify(logEntry), { expirationTtl: 86400 * 30 }));

      // Non-blocking billing event to VendyAI
      ctx.waitUntil(
        fetch('https://vendyai-com-worker.jmobleyworks.workers.dev/api/billing/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venture_id: 'mailguyai.com', user_id: to, event: 'email_sent', plan: 'sovereign' })
        }).catch(e => console.error('[MailguyAI] Billing event failed:', e))
      );

      return json({ success: true, id: mailId, engine: 'cloudflare-native' });
    }

    // --- Legacy KV delivery log lookup ---
    if (method === 'GET' && path.startsWith('/api/v1/mail/')) {
      const mailId = path.split('/api/v1/mail/')[1];
      if (!mailId) return err('Mail ID required', 'INVALID_INPUT');
      const logStr = await env.MAILGUY_KV.get(`mail:${mailId}`);
      if (!logStr) return err('Not found', 'NOT_FOUND', 404);
      return json(JSON.parse(logStr));
    }

    // --- Provision a mailbox ---
    if (method === 'POST' && path === '/api/v1/mailboxes') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 'INVALID_INPUT'); }
      const result = await createMailbox(env, body);
      return result.ok ? json(result, 201) : err(result.error, 'PROVISION_FAILED', 400);
    }

    // --- Deprovision a mailbox ---
    if (method === 'DELETE' && path.startsWith('/api/v1/mailboxes/') && !path.endsWith('/messages')) {
      const address = decodeURIComponent(path.split('/api/v1/mailboxes/')[1] || '');
      if (!address) return err('Address required', 'INVALID_INPUT');
      const result = await deleteMailbox(env, address);
      return result.ok ? json(result) : err(result.error, 'NOT_FOUND', 404);
    }

    // --- List messages for a mailbox ---
    const messagesMatch = path.match(/^\/api\/v1\/mailboxes\/([^/]+)\/messages$/);
    if (method === 'GET' && messagesMatch) {
      const address = decodeURIComponent(messagesMatch[1]);
      const mailbox = await getMailboxByAddress(env, address);
      if (!mailbox) return err('Mailbox not found', 'NOT_FOUND', 404);
      const limit = Number(url.searchParams.get('limit')) || 50;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const messages = await listMessages(env, mailbox.id, { limit, offset });
      return json({ mailbox: mailbox.address, count: messages.length, messages });
    }

    // --- Get / delete a single message ---
    if (path.startsWith('/api/v1/messages/')) {
      const messageId = path.split('/api/v1/messages/')[1];
      if (!messageId) return err('Message ID required', 'INVALID_INPUT');

      if (method === 'GET') {
        const msg = await getMessage(env, messageId);
        return msg ? json(msg) : err('Not found', 'NOT_FOUND', 404);
      }
      if (method === 'DELETE') {
        const deleted = await deleteMessage(env, messageId);
        return deleted ? json({ success: true, id: messageId }) : err('Not found', 'NOT_FOUND', 404);
      }
    }

    return err('Not found', 'NOT_FOUND', 404);
  },
};
