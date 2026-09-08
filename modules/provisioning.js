/**
 * MailguyAI — mailbox provisioning.
 *
 * Two paths:
 *   - internal: no billing gate (subsidiaries / John himself)
 *   - external: billing-gated (paying customers) — Phase 1 does not yet wire
 *     real billing; `plan !== 'internal'` is accepted but not enforced against
 *     Stripe/vendyai here. That gate is later-phase work, deliberately not
 *     faked in this pass.
 *
 * Before claiming success, verifies the target domain actually has
 * Cloudflare Email Routing enabled — a mailbox row with no real routing
 * behind it would silently drop mail, so we check rather than assume.
 */

import { getMailboxByAddress } from './mailbox-store.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

function cfHeaders(env) {
  // Global API key auth — same pattern verified working against the
  // mailguyai.com/mobleyhelms.com zones directly (2026-09-08). Both
  // CF_API_EMAIL / CF_API_KEY are Worker secrets, never hardcoded.
  return {
    'X-Auth-Email': env.CF_API_EMAIL,
    'X-Auth-Key': env.CF_API_KEY,
    'Content-Type': 'application/json',
  };
}

/** Resolve a zone id for a domain via the Cloudflare API. Returns null if not found. */
async function getZoneId(env, domain) {
  const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, {
    headers: cfHeaders(env),
  });
  const data = await res.json();
  if (!data.success || !data.result || data.result.length === 0) return null;
  return data.result[0].id;
}

/**
 * Confirm the domain has Email Routing enabled and status "ready" — real
 * verification, not a registry field taken at face value.
 */
export async function verifyEmailRoutingEnabled(env, domain) {
  const zoneId = await getZoneId(env, domain);
  if (!zoneId) {
    return { ok: false, reason: `No Cloudflare zone found for ${domain}` };
  }
  const res = await fetch(`${CF_API}/zones/${zoneId}/email/routing`, {
    headers: cfHeaders(env),
  });
  const data = await res.json();
  if (!data.success || !data.result) {
    return { ok: false, reason: `Email Routing API call failed for ${domain}: ${JSON.stringify(data.errors || [])}` };
  }
  const { enabled, status } = data.result;
  if (!enabled || status !== 'ready') {
    return { ok: false, reason: `Email Routing not ready for ${domain} (enabled=${enabled}, status=${status})` };
  }
  return { ok: true, zoneId };
}

/**
 * Create a mailbox row. Does NOT configure the Cloudflare Email Routing rule
 * itself (that's a one-time, human-reviewed zone change per address — see
 * how admin@mobleyhelms.com was wired) — this validates that routing exists
 * and records the mailbox so inbound.js/mailbox-store.js can resolve it.
 */
export async function createMailbox(env, { address, domain, owner_type, owner_ref, plan }) {
  if (!address || !domain || !owner_type) {
    return { ok: false, error: 'address, domain, and owner_type are required' };
  }
  address = address.toLowerCase();

  const existing = await getMailboxByAddress(env, address);
  if (existing) {
    return { ok: false, error: `Mailbox ${address} already exists`, mailbox: existing };
  }

  const routing = await verifyEmailRoutingEnabled(env, domain);
  if (!routing.ok) {
    return { ok: false, error: `Cannot provision ${address}: ${routing.reason}` };
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const resolvedPlan = plan || (owner_type === 'internal' ? 'internal' : 'unbilled');

  await env.MAILGUY_DB
    .prepare(
      `INSERT INTO mailboxes (id, address, domain, owner_type, owner_ref, plan, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, address, domain, owner_type, owner_ref || null, resolvedPlan, createdAt)
    .run();

  return {
    ok: true,
    mailbox: { id, address, domain, owner_type, owner_ref: owner_ref || null, plan: resolvedPlan, created_at: createdAt },
  };
}

/** Delete a mailbox row by address. Does not delete its historical messages. */
export async function deleteMailbox(env, address) {
  address = address.toLowerCase();
  const existing = await getMailboxByAddress(env, address);
  if (!existing) return { ok: false, error: `Mailbox ${address} not found` };

  await env.MAILGUY_DB.prepare('DELETE FROM mailboxes WHERE address = ?').bind(address).run();
  return { ok: true, deleted: address };
}
