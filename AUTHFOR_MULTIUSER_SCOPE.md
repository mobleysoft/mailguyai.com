# Scope: AuthFor-backed multi-user mailbox access

## The actual problem this solves

The original ask was "a shared account for Ron, username mhslp, password
Arthur!818U, via AuthFor, for outreach@weylandai.com." That's the wrong
shape of solution even before the credential-handling question: one
shared password for two people is bad practice regardless of who types
it in. The real fix is what AuthFor is *for* — Ron gets his own real
AuthFor identity, with his own password that only he knows, and this app
grants *that identity* read access to the shared mailbox. No password
changes hands, nothing gets typed into a chat, and access can be revoked
per-person later without rotating a shared secret everyone else also
has to relearn.

## What exists today (verified against the running code, not assumed)

- `worker.js`'s only auth mechanism is one shared `MAILGUY_API_KEY`
  Bearer token, checked in `isAuthorized()` (worker.js:54-57) - gates
  every `/api/*` route identically. No per-user identity anywhere.
- `modules/provisioning.js`'s `createMailbox` already does real,
  agentic mailbox provisioning (verifies Cloudflare Email Routing is
  actually enabled before accepting) - this stays as the
  service/admin-level API, unchanged.
- No `users` table. `migrations/0001_init.sql` only has `mailboxes` and
  `messages`.
- No web UI at all - every read/write path is raw JSON API.

## The real AuthFor pattern to port (not invent)

Confirmed via `weylandai.com/src/lib/authfor-client.js` - the only
verified working AuthFor server-side integration in this estate:

1. Extract `Authorization: Bearer <token>` from the request.
2. `GET https://authfor.com/api/v1/verify` with that same Bearer token.
   AuthFor verifies it and returns `{ email, name, ... }` - an opaque
   token checked live against AuthFor's own API every request, no
   local JWT verification, no shared secret with AuthFor.
3. Bridge the verified `email` to a **local** `users` row (`SELECT ...
   FROM users WHERE email = ?`). AuthFor has no invite/role primitive -
   confirmed in the same research pass, `authfor-invite.js` explicitly
   voids any `role`/`operatorToken` params because "register has no
   operator concept" upstream. If no local row matches, real behavior
   is a 404, not an auto-created account - the local app is what
   decides who's allowed in, AuthFor only proves who someone is.

Nothing about *shared multi-user access to one resource* exists
anywhere in this AuthFor deployment yet - this is genuinely new design,
not a copy of an existing pattern.

## Design

### New tables (migration 0002)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE mailbox_access (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,  -- 'owner' | 'read' | 'send'
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,  -- user_id of whoever granted it
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX idx_mailbox_access_user ON mailbox_access(user_id);
```

`role` is deliberately a flat string, not a bitmask or a separate
permissions table - `mailboxes`/`messages` are the only two other
tables in this schema and neither needs finer granularity yet. Add it
later if a real need shows up, don't pre-build it.

### New module: `modules/authfor.js`

Direct port of `authenticateViaAuthFor`'s real logic (weylandai.com's
`src/lib/authfor-client.js:36-86`), adapted to this schema: verify
Bearer token against `https://authfor.com/api/v1/verify`, bridge by
email to `MAILGUY_DB`'s `users` table, return `{ user }` or `{ error:
404 }`. No `tenant_id` concept needed here (mailguyai.com has no
multi-tenant model) - the only real adaptation from the source.

### New routes (additive - existing `MAILGUY_API_KEY` routes untouched)

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/v1/me` | AuthFor Bearer | Real identity + list of mailboxes this user has `mailbox_access` to |
| `GET /api/v1/me/mailboxes/:address/messages` | AuthFor Bearer | Same as the existing admin route, but permission-checked: 403 unless a `mailbox_access` row exists for this user+mailbox |
| `GET /api/v1/me/messages/:id` | AuthFor Bearer | Same permission check, resolved via the message's `mailbox_id` |
| `POST /api/v1/me/mailboxes/:address/send` | AuthFor Bearer | Only if role is `owner` or `send` - real send via the existing `sendViaCloudflareSMTP`, `from` forced to the mailbox's own address (can't spoof `from`) |
| `POST /api/v1/mailboxes/:address/access` | `MAILGUY_API_KEY` (admin-only, existing gate) | Grant a `user_id` (by email, upserts into `users` if new) a role on a mailbox - this is how John grants Ron access, no password involved on either side |

The existing `MAILGUY_API_KEY`-gated routes (`POST /api/v1/mailboxes`,
`POST /api/v1/send`, etc.) stay exactly as they are - service/agentic
use keeps its own key, human end-users get their own identity. Two
separate, real auth paths for two separate real use cases, not a
replacement of one by the other.

### Decided: browsable UI, both John and Ron get `send`

Both need a real UI (not API-only), and both actively send from
outreach@ - that's *why* the outreach tracker matters (see below): two
people sending from the same address need visibility into what the
other already sent, not a read/write split between them.

A single static page (`inbox.html`), reusing the real
`AuthForStandard` client widget already built and working at
`weylandai.com/assets/authfor-integration-standard.js` (same
`clientId`/`ventureName` constructor pattern, new `clientId` value like
`af_mailguy_login`) for the login flow, then plain fetches against the
`/api/v1/me/*` routes to list/read/send messages and to check the
outreach log before sending. Three views: Inbox, Compose (with a live
"already contacted?" check), Outreach Log.

### Outreach tracker (new - not in the original scope)

The actual goal: before either of you emails a new prospect via
outreach@weylandai.com, you can see whether the other already has -
so you don't both cold-email the same person.

**Real gap found while designing this**: the *existing* `POST
/api/v1/send` path never writes to `MAILGUY_DB.messages` at all today -
only a 30-day KV log entry and a billing event (worker.js:137-148).
Only *inbound* mail is persisted (`modules/inbound.js` →
`storeMessage`). So the tracker isn't just a new read view over
existing data - outbound sends need to start being persisted to D1
for the first time, with who-sent-it recorded.

- Add `sent_by_user_id TEXT REFERENCES users(id)` (nullable - the
  existing admin-key `/api/v1/send` path has no user identity to put
  there) to the `messages` table, in the same migration 0002.
- The new `POST /api/v1/me/mailboxes/:address/send` route (unlike the
  existing admin one) calls `storeMessage(..., direction: 'outbound',
  sent_by_user_id: user.id)` after a successful send - real
  persistence, not just a KV log.
- New route: `GET /api/v1/me/mailboxes/:address/outreach-log?to=<email>`
  - checks one address ("has anyone contacted this person before?",
  for the compose-screen live check) - and the bare `GET
  .../outreach-log` for the full sortable history (who, when, subject,
  to whom).

### Mobley-triggered step: Ron's real AuthFor account

Per direction: this app (and I, in this session) never handle Ron's
actual password. **Mobley** is what calls AuthFor's real registration
endpoint - confirmed via the same research pass that grounded the
rest of this doc (`weylandai.com`'s only real AuthFor integration):

```
POST https://authfor.com/api/v1/register
Content-Type: application/json

{
  "email": "<ron's real email>",
  "password": "<set by Ron or provisioned by Mobley - not this app>",
  "name": "Ron",
  "client_id": "af_mailguy_login",
  "venture_id": "mailguyai.com"
}
```

Once that real account exists, the only thing *this app* needs is
Ron's email - to insert his `users` row and grant `mailbox_access` via
step 4 below. This app's build (steps 1-3, 5-8) doesn't block on that
account existing yet - it can be built and tested with a fake email
today, and step 4 just runs once for real once Mobley confirms the
account is live.

## Ordered implementation steps

1. Migration 0002: `users`, `mailbox_access`, plus `sent_by_user_id` on
   `messages` - no behavior change yet, safe to ship alone.
2. `modules/authfor.js` - port the verify+bridge logic, unit-testable
   against a fake `fetch`, no live AuthFor calls in tests.
3. The 4 new `/api/v1/me/*` routes (`GET /me`, `GET
   /me/mailboxes/:address/messages`, `GET /me/messages/:id`, `POST
   /me/mailboxes/:address/send` - the last one now also persisting to
   `messages` with `sent_by_user_id`) wired into `worker.js`.
4. The 2 outreach-log routes
   (`GET /me/mailboxes/:address/outreach-log[?to=]`).
5. The admin grant route (`POST /api/v1/mailboxes/:address/access`) -
   how John grants Ron access once Mobley confirms Ron's real AuthFor
   account exists (email only, no password touches this app).
6. `inbox.html` - Inbox / Compose (with the live outreach-log check) /
   Outreach Log views, using the real `AuthForStandard` widget.
7. Provision `outreach@weylandai.com` for real via the *existing*
   `POST /api/v1/mailboxes` (needs Email Routing verified/enabled on
   weylandai.com's zone first - real prerequisite, not assumed).
8. Grant John and Ron `send` access on that mailbox via step 5's route,
   once Mobley's registration call (above) has run for real.

**Status (2026-09-10): steps 1-5 are done** - migration 0002 applied
to the live D1 database, `modules/authfor.js` + `modules/me-routes.js`
built and wired into `worker.js`, 26/26 tests passing, deployed via
`wrangler deploy`. **Correction, same day**: the original "live-verified"
claim above only ever checked `mailguyai-com-worker.johnmobley99.workers.dev`
directly - the real `mailguyai.com` domain's Cloudflare route pointed at
`mascom-edge` (a static GitHub-Pages landing page), which was silently
serving that same static page for `/api/*` too via its own 404-fallback
logic, not this worker at all. Nobody could actually reach any of this
at the real domain. Fixed by adding a narrow `mailguyai.com/api/*` route
to `mailguyai-com-worker` (the landing page keeps serving `/` via
mascom-edge, untouched) - now genuinely live-verified at the real domain
(`/api/v1/health` returns real JSON, `/api/v1/me` returns a real 401).
**Step 6 done (2026-09-10)**: `inbox.html` built and deployed - mailbox
list with role, message list, compose form, and the live outreach-log
"already contacted?" check inline in compose (blur the `to` field).
Live-verified at the real domain. Steps 7-8 remain: provisioning
`outreach@weylandai.com` and granting real access are gated on Email
Routing verification and Mobley's
registration call for Ron, per below.

Steps 1-4 and 6 have no dependency on Ron's account existing and can
be built, tested, and deployed now. Steps 7-8 are the real-world
activation steps, gated on Email Routing verification and Mobley's
registration call respectively.
