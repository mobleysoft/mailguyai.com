# Outreach mailbox rollout: all 123 ventures as real mailguyai tenants

## The real gap this closes

John, directly: "The users table should not be empty for mail guy/salesfactor.
Each subsidiary that uses them should be in their users table, and all
subsidiaries should use them."

Before this pass: `mailguyai-com-db`'s `mailboxes` table had exactly 2 real
rows (`admin@mobleyhelms.com`, `outreach@weylandai.com`). Only 1 of the 123
real ventures (weylandai.com) had ever actually used this shared
email/outreach infrastructure. `users` (0 rows) is empty for a separate,
legitimate reason — it's AuthFor-backed *human* identity (John, Ron), gated
on Ron's real AuthFor registration, not a tenant table. See
`AUTHFOR_MULTIUSER_SCOPE.md` for that history — nothing about it changed
here.

## The real data-model decision: `mailboxes.owner_ref` IS the tenant signal

`users`/`mailbox_access` (migration 0002) model *human* access to a shared
mailbox — not "which venture owns this mailbox." Forcing 123 fake human rows
into `users` would have been wrong on its face and explicitly against
standing direction not to fabricate data.

The real, already-existing extension point is `mailboxes.owner_ref`
(`schema.sql`/migration 0001: `owner_ref TEXT -- e.g. venture domain, user
id, subsidiary name`) — and it's already precedented: the very first mailbox
row ever created, `admin@mobleyhelms.com`, already has `owner_ref =
'mobleyhelms.com'`. `outreach@weylandai.com` was the one gap (inserted with
`owner_ref = NULL` on 2026-09-11) — backfilled as part of this pass.

**Decided convention, now applied to every mailbox in the table**: for a
venture's own `outreach@<domain>` mailbox, `owner_type = 'internal'` and
`owner_ref = '<domain>'`. `owner_ref` holding a venture's own domain is the
real, queryable "this subsidiary is a tenant of mailguyai" signal —
`SELECT * FROM mailboxes WHERE owner_ref = 'weylandai.com'` now answers "does
this venture use mailguyai" directly. No new table needed; `schema.sql` and
`modules/provisioning.js` were annotated in place (see commit) so this
convention isn't lost to a future session.

## Survey (read-only, all 123 zones — the real Cloudflare state)

For all 123 zones (a 1:1 match against `ventures.json`'s 123 domains,
confirmed by exact set comparison), fetched real `MX`/`TXT` DNS records and
Email Routing status via the Cloudflare API. Classified:

| Category | Count | Meaning |
|---|---:|---|
| (a) no MX at all | 9 | nothing to conflict with — safe |
| (b) already Cloudflare Email Routing | 5 | `authfor.com`, `mailguyai.com`, `mobleyhelms.com`, `salesfactorai.com`, `weylandai.com` — safe to extend |
| (c) known-stale `mta.mailguyai.com` MX | 107 | confirmed dead pattern (resolves to Cloudflare's HTTP proxy IPs, not a real SMTP listener, never referenced in this codebase) — same as the documented weylandai.com/salesfactorai.com precedent — safe to remove and proceed |
| (d) genuine live third-party mail | 2 | `accountdrac.com`, `literacraft.com` — NOT touched |

121 domains (a+b+c) landed in the safe set. 2 landed in category (d).

### Category (d) — real evidence found, not just "MX looks foreign"

Per John's follow-up direction ("nothing should have any third-party email
whatsoever" — the long-term target is migrating these too, not a permanent
exemption), both domains were checked for *concrete* evidence of real,
current use rather than just "MX record points somewhere real-looking":

- `accountdrac.com` and `literacraft.com` both have:
  - A live Microsoft 365 MX record (`*.mail.protection.outlook.com`) at
    **priority 0** (highest priority — wins over the dead `mta.mailguyai.com`
    record at priority 10 that's also still present on both).
  - `v=spf1 include:spf.protection.outlook.com -all` — a hard-fail SPF
    record that only gets configured once a real M365 tenant is actually set
    up for outbound mail.
  - `"MS=ms########"` — Microsoft's own domain-verification TXT record,
    which Microsoft only issues once someone completes real domain
    verification inside a real M365 admin center. This is the strongest
    signal: it can't exist by accident or as registrar/domain-parking
    default.
  - An already-working DMARC record (`p=quarantine`).
  - Both ventures are past concept-stage — real deployed Workers
    (`accountdrac-com-worker`, `literacraft-com-worker`), `deployment_lock:
    true`, live Stripe wiring per `ventures.json`.
  - No code anywhere in the estate (`grep -r "@accountdrac.com\|@literacraft.com"`)
    references sending/receiving at these addresses — but the DNS-level
    evidence above is independently sufficient to call this real, live,
    currently-configured third-party email, not a leftover artifact.

This is different from the 107 "known-stale" domains, which have **only**
the dead `mta.mailguyai.com` MX with no working alternative behind it
(confirmed by the identical, uniform SPF fingerprint shared by 105 of
those 107 — see below) — nothing to lose by removing it. accountdrac.com/
literacraft.com have a real, currently-functioning alternative that outranks
it.

**One additional finding worth flagging**: `mobleysoft.com` (category c,
provisioned this pass) had an *orphaned* `v=spf1
include:spf.protection.outlook.com -all` fragment in its TXT records too —
but unlike accountdrac.com/literacraft.com, it had **no** MX record pointing
at Outlook at all (only the dead `mta.mailguyai.com`) and **no** `MS=`
verification TXT — instead an `openai-domain-verification=...` record. Read
as a stray leftover with no real mailbox ever behind it, not active
third-party mail. Removed as part of the standard cleanup (see below);
flagging here in case that read turns out to be wrong.

### Migration plan for the 2 genuinely-live domains (new follow-up task, not done here)

Per John's explicit long-term direction, third-party email on these two
should eventually move to mailguyai.com too. This pass deliberately does
**not** touch their DNS — a live cutover risks real mail loss if anyone
depends on the current `@accountdrac.com` / `@literacraft.com` M365
mailboxes, which the codebase can't confirm one way or the other (only DNS
evidence was checked, not actual mailbox contents/usage, since that would
require M365 admin access this session doesn't have). Real plan for a future
session:

1. **Confirm real usage before cutover.** Check with John/Ron directly
   whether either address is actively used for real inbound mail (client
   correspondence, notifications, etc.) — DNS evidence proves the tenant is
   configured, not that mail is flowing through it today.
2. **If genuinely unused**: this collapses to the same category (c) process
   already run 107 times — delete both MX records (the M365 one and the
   dead mailguyai one), delete both SPF TXT fragments, enable Cloudflare
   Email Routing, provision `outreach@<domain>`, create the routing rule.
   Low risk, same playbook.
3. **If genuinely used**: real low-risk cutover sequence —
   a. Provision `outreach@<domain>` (or whatever address structure is
      actually in use) in mailguyai first, in parallel, without touching
      the existing M365 MX/SPF (add-only — Cloudflare Email Routing can't
      coexist as a *second* MX destination for the same address without a
      real MX priority decision, so this step really just proves the
      target mailbox is ready, not that mail is flowing to it yet).
   b. Export/forward any real mail history worth keeping from M365
      (out of this codebase's reach — a manual M365 admin step).
   c. Only after (a)+(b): lower the M365 MX priority / remove it and let
      Cloudflare's routes take over, same DNS mechanics as the 107 already
      done, but scheduled for a real low-traffic window and announced to
      whoever currently sends/receives at the address, given DNS MX
      changes take real TTL time to propagate and a mid-propagation window
      exists where mail could route inconsistently.
   d. Cancel/downgrade the M365 subscription only after confirming zero
      mail has landed there for a full propagation-safe window (days, not
      hours).

Not attempted in this pass — flagging as a real, explicit follow-up task per
John's stated long-term goal, not silently dropped.

## Provisioning executed (121/121 succeeded, 0 failures)

For every domain in categories (a)/(b)/(c):

1. **DNS cleanup** (a/c only — b needed none): deleted the stale MX record
   pointing at `mta.mailguyai.com` (and, on `mobleysoft.com`, the orphaned
   Outlook SPF fragment described above) plus the stale SPF TXT record
   matching the confirmed-dead pattern
   (`v=spf1 ip4:178.156.184.118 ip4:5.161.253.15 ~all` — the same dead
   Hetzner/GravNova IPs already documented as dead in
   `reference_gravnova.md`). 105 of 107 category-(c) domains had this exact
   SPF string; `instantiability.com` had no SPF at all (nothing to delete);
   `mobleysoft.com` had 2 stale TXT fragments (both deleted).
2. **Enable Email Routing** (`POST /zones/:id/email/routing/enable`).
   Simpler than the original weylandai.com/salesfactorai.com precedent
   documented in `AUTHFOR_MULTIUSER_SCOPE.md` — once the stale MX was
   removed first, `enable` succeeded on the *first* attempt for every one
   of the 116 domains that needed it, and Cloudflare auto-created its own
   correct `route{1,2,3}.mx.cloudflare.net` MX records and the correct
   `v=spf1 include:_spf.mx.cloudflare.net ~all` SPF record on enable — no
   manual SPF re-add needed this time (verified directly on
   `abstergo.cc` before running the rest of the batch). Confirmed
   `enabled: true, status: "ready"` for all 116.
3. **`mailboxes` D1 row**: inserted directly via `wrangler d1 execute
   --remote` against `mailguyai-com-db` (same reason as the weylandai.com
   precedent — `MAILGUY_API_KEY` isn't available outside the deployed
   Worker). 120 new rows (`outreach@<domain>`, `owner_type: 'internal'`,
   `owner_ref: '<domain>'`) + 1 backfill (`outreach@weylandai.com`'s
   `owner_ref` NULL → `'weylandai.com'`). `weylandai.com` itself needed no
   new row, only the backfill, since it was already provisioned.
   Verified: `mailboxes` table now has 122 rows total (1 pre-existing
   `admin@`, 121 `outreach@`), zero missing, zero extras, zero rows with
   a null `owner_ref`.
4. **Cloudflare Email Routing rule**: created via
   `POST /zones/:id/email/routing/rules` — identical shape to the working
   `admin@mobleyhelms.com` rule used as the template in the original
   precedent (`literal` matcher on `to`, `worker` action →
   `mailguyai-com-worker`). 120 created (weylandai.com's rule already
   existed from the prior pass). Verified: 120/120 succeeded, re-fetched
   each zone's rule list to confirm.

### Correction to the precedent's own verification method

`AUTHFOR_MULTIUSER_SCOPE.md`'s step 7 write-up describes live-verifying
`outreach@weylandai.com` by checking that the authenticated messages
endpoint "returns 401 (auth-gated), not 404" for that address. Checked this
claim directly this pass: `worker.js`'s `isAuthorized()` gate runs *before*
the mailbox-existence lookup for `/api/v1/mailboxes/:address/messages` — so
**every** address returns 401 there, including addresses that were never
provisioned (confirmed against a made-up address that has never existed
anywhere). That check alone doesn't actually distinguish a real, provisioned
mailbox from a nonexistent one — it only proves the `mailguyai.com/api/*`
route reaches the real Worker (which was the real, narrower thing broken
and fixed on 2026-09-10).

Real verification used for this pass instead — three independent, address-
specific checks per domain, all of which *do* distinguish provisioned from
not:
1. Cloudflare Email Routing zone status: `enabled: true, status: "ready"`.
2. A real row in `mailguyai-com-db`'s `mailboxes` table for that exact
   address (checked via direct `SELECT`, not assumed from insert success).
3. A real, enabled Cloudflare Email Routing rule for that exact address
   (checked via `GET .../email/routing/rules`, not assumed from the POST
   response).

All 121 domains passed all three checks.

## Domains provisioned this pass (121)

abstergo.cc, agentropi.com, agentzaar.com, agewinder.com, aicossic.com,
aiopencommerce.com, alhena.cc, americanagi.cc, americnagi.cc, anattar.com,
animetrope.com, areshiva.com, audiovizai.com, authfor.com, bignice.cc,
bitdoggo.com, bloomagi.cc, bondwright.com, book2film.cc, bookclubs.cc,
bookeepr.cc, brocade.cc, brynhildai.com, conseiv.com, consenta.cc,
cryptosmart.cc, danzoa.com, devducky.com, devtoolai.com, devtoolbx.com,
dofura.com, domainwombat.com, draknir.com, draugr.cc, ecofixai.com,
emissionhub.cc, enablinghomes.com, encoverai.com, entoolize.com,
equifiant.com, extraterran.com, fedbank.cc, fedtalent.cc, femptocom.com,
filmline.cc, firmcreate.com, fundyai.com, fystz.com, galadul.com,
gamegob.com, glcx.cc, glyphyai.com, golfcad.cc, golfdad.cc, golflink.cc,
golfmind.cc, gravnova.com, greenhandcapital.com, greybeardai.com,
gurukle.com, halside.com, healspell.com, helmcorp.cc, helmdir.com,
helmscorp.cc, hildrai.com, industrize.com, instantiability.com, intfer.cc,
kubaki.cc, lawyik.com, leadersclub.cc, legibleweights.com, legionicai.com,
lovemaint.com, mailguyai.com, malathor.com, marketingium.com, meeva.io,
mobcoin.cc, mobcorp.cc, mobleybooks.com, mobleyhelms.com, mobleymetal.com,
mobleyreport.com, mobleysoft.com, newgameplus.cc, ownschool.cc,
paintedwhore.cc, pandorachat.cc, patentkin.com, powerhost.cc,
quanticfork.com, reasontodate.com, rebrief.me, recovai.com, roncorp.cc,
ronhelms.cc, salesfactorai.com, sanctuaryui.com, scalarflux.com,
selfcoin.cc, sentiantai.com, singularityui.com, syncropy.com,
talkingmind.cc, taskgridai.com, tenancyai.com, traceformer.com,
transcendantai.com, twill.finance, valdring.com, valkrai.com, vendyai.com,
ventraleye.com, warpdrive.cc, watchforce.cc, weylandai.com (backfill only),
workshrinker.com, youthmend.com, yutaniai.com

## Skipped this pass (2)

- `accountdrac.com` — real, live Microsoft 365 tenant (see evidence above).
  Migration plan above; not touched.
- `literacraft.com` — same, real, live Microsoft 365 tenant. Same plan.

## Exceptions / friction hit

None. All 121 safe-category domains completed the full 4-step provisioning
process (DNS cleanup where needed → enable routing → D1 row → routing rule)
on the first attempt, with all three post-hoc verification checks passing.
No rate limiting, no zones in an unusual state, no partial failures to
retry. This is an unusually clean result for a 121-domain batch — flagging
plainly rather than assuming it means the survey/classification was
insufficiently careful: the classification step *did* correctly pull 2 real
domains (accountdrac.com, literacraft.com) out of the batch and treat them
differently, and one domain (mobleysoft.com) got extra manual scrutiny for
its orphaned SPF fragment before being included.

## What's left for a follow-up pass

- The category-(d) migration plan above (accountdrac.com, literacraft.com)
  — not started, needs a real usage-confirmation step with John/Ron before
  any DNS change.
- `users`/`mailbox_access` (human AuthFor access) is unaffected by this
  pass and remains correctly empty pending Ron's real AuthFor registration
  — see `AUTHFOR_MULTIUSER_SCOPE.md`, step 8. Not conflated with the
  tenant model above.
- **Fixed (2026-09-13)**: `wrangler d1 migrations list mailguyai-com-db
  --remote` used to report both `0001_init.sql` and
  `0002_multiuser_and_outreach_log.sql` as still "to be applied" even
  though their tables demonstrably exist — both were originally applied
  via direct SQL execution rather than `wrangler d1 migrations apply`, so
  the `d1_migrations` bookkeeping table was never created. Fixed by
  creating `d1_migrations` (wrangler's own expected schema: `id INTEGER
  PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME`) and
  backfilling both real filenames with `datetime('now')` as their applied
  timestamp — the actual historical apply time isn't recorded anywhere,
  and wrangler only ever reads this table to decide what's pending, not
  to report a real historical audit trail, so an accurate-enough backfill
  timestamp is the correct fix, not a gap. Re-verified live:
  `wrangler d1 migrations list` now reports "No migrations to apply!" —
  a real future `0003_*.sql` will apply cleanly against this bookkeeping
  instead of wrangler trying to blindly replay 0001/0002 (0002's
  non-idempotent `ALTER TABLE ... ADD COLUMN` would have failed loudly
  the first time anyone ran `wrangler d1 migrations apply` for real).
