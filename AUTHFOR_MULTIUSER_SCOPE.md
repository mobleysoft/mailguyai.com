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

### Minimal UI (open question - see below)

A single static page (`inbox.html`), reusing the real
`AuthForStandard` client widget already built and working at
`weylandai.com/assets/authfor-integration-standard.js` (same
`clientId`/`ventureName` constructor pattern, new `clientId` value like
`af_mailguy_login`) for the login flow, then a plain fetch loop against
the new `/api/v1/me/*` routes to list and render messages. Genuinely
small - the widget and the API are both already real - but real scope,
not zero.

## Ordered implementation steps

1. Migration 0002 (`users`, `mailbox_access`) - no behavior change yet,
   safe to ship alone.
2. `modules/authfor.js` - port the verify+bridge logic, unit-testable
   against a fake `fetch` the same way this session's other AuthFor-
   adjacent tests have been written, no live AuthFor calls in tests.
3. The 4 new `/api/v1/me/*` routes wired into `worker.js`, gated by
   step 2's module instead of `isAuthorized()`.
4. The admin grant route (`POST /api/v1/mailboxes/:address/access`) -
   the actual mechanism for adding Ron, keyed by his email once he has
   a real AuthFor account, no password ever touches this app or this
   chat.
5. Provision `outreach@weylandai.com` for real via the *existing*
   `POST /api/v1/mailboxes` (needs Email Routing verified/enabled on
   weylandai.com's zone first - real prerequisite, not assumed).
6. Grant John `owner` and Ron `read` (or `send`, per whatever's
   decided) on that mailbox via step 4's route.
7. (Open question below) the minimal `inbox.html` UI, if wanted.

## Open questions - need a real decision before starting

- **Does Ron need a browsable UI, or is API access enough for now?**
  Changes whether step 7 is in scope for this pass.
- **What role does Ron actually need** - read-only visibility into
  outreach@, or does he also need to send from it? Changes whether the
  `send` route ships in the first pass.
- **Does Ron already have a real AuthFor account?** If not, that's the
  one remaining human step (he signs up himself, at whatever AuthFor's
  real signup surface is) - not something this app or I can do for
  him, and not blocking on the backend work above, which can be built
  and tested independently of any specific real person's account
  existing yet.
