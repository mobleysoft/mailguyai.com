# Scope: personalized outreach engine

Three real, separable features requested together. Scoping them as
three phases on the same foundation (the outreach tracker from
AUTHFOR_MULTIUSER_SCOPE.md) rather than one monolithic build - they
have very different risk profiles and none blocks the others.

**Correction (2026-09-10, after this doc was written): Phase 1 is
redundant with real, already-shipped work - do not build it here.**
Later the same session as this doc, a product-split decision was made:
mailguyai.com stays the mailbox-hosting/creation product, and the
outreach-tracking/sales-engagement product (contacts, outreach log,
stale-contact follow-up) was built on **salesfactorai.com** instead -
its own dedicated D1 (`contacts`, `outreach_log` tables), a live
`GET /api/v1/stale?days=` route, and a real `dashboard.html` UI. That
is functionally identical to what Phase 1 below describes building on
mailguyai.com. Building it again here would be duplicate maintenance
for a decision already made, not net-new value. If mailguyai.com later
wants a "who have we contacted" view inside `inbox.html`, the right
move is calling salesfactorai.com's API (cross-venture, same as any
other shared-capability wiring in this portfolio - see mascom/CLAUDE.md's
"Build capability-first, not custom-first"), not re-implementing the
tables and routes. Phases 2-3 below are more naturally salesfactorai.com
features too, for the same reason (they're outreach/sales-engagement,
not mailbox hosting) - re-evaluate before starting either there instead
of here.

## Real technical constraint, stated up front

**A scroll-driven "your site morphs into our proposed design" effect
cannot run inside an email body.** Email clients (Gmail, Outlook, Apple
Mail) strip `<script>` entirely and support only a narrow, inconsistent
CSS subset - no `scroll-timeline`, no reliable JS-driven interpolation,
often no CSS custom properties. This has to be a real hosted page the
email *links to* (e.g. `weylandai.com/preview/<prospect-slug>`), not
literal inline content. The email itself can carry a static preview
(a screenshot or a short animated GIF of the effect) with a "see it
live" link. This isn't a workaround - it's the only way this kind of
experience can actually exist; scoping it as inline-in-email would be
building something that silently doesn't render for most recipients.

## Phase 1: Follow-up reminders (small, builds directly on the tracker)

Extends the outreach-log design already scoped in
AUTHFOR_MULTIUSER_SCOPE.md - no new infrastructure.

- Add `next_follow_up_at` (nullable) to a new `contacts` table (see
  Phase 2 - contacts need to exist as their own entity before "don't
  go stale" means anything; right now `messages.to_addr` is just a
  string with no relationship state attached to it).
- `GET /api/v1/me/mailboxes/:address/stale-contacts?days=14` - contacts
  with no outbound message in N days and no future `next_follow_up_at`.
- Surfaced in the UI (inbox.html's Outreach Log view) as a real,
  queryable list - not a notification/push system in this pass (that's
  a distinct, larger piece - cron trigger + a real delivery channel -
  worth scoping separately once the query itself is proven useful).

## Phase 2: Personalized email generation (medium - needs real content grounding)

Requires a `contacts` table that doesn't exist yet - promotes
"someone we've emailed" from a bare string into a real entity with
attributes to personalize against:

```sql
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  website_url TEXT,
  industry TEXT,           -- e.g. 'construction'
  sub_industry TEXT,       -- e.g. 'door_hardware_distributor', 'general_contractor', 'architect'
  created_at TEXT NOT NULL,
  next_follow_up_at TEXT
);
```

**Real risk to design against, not skip**: an LLM asked to write
personalized sales copy with no grounding will drift toward generic or
fabricated claims about what WeylandAI actually does - the same
failure mode this whole codebase has been explicit about avoiding
elsewhere (mailguyai.com's own landing page is honestly labeled as a
rules engine, not the full product its spec describes). The generation
prompt needs a **real, maintained capability sheet per sub-industry**
- what WeylandAI's actual products (SubX/TakeoffX/CutsheetX/etc, per
weylandai.com's own `products_v2`) genuinely do for *that specific*
sub-industry - not a generic "AI-powered construction platform" pitch.
That capability sheet is real content work, not something to
auto-generate from nothing.

- New module `modules/outreach-gen.js`: given a `contacts` row, builds
  a subject + body from a per-sub-industry template + the real
  capability sheet, calling Claude for the specific personalization
  pass (name, company, likely pain points for that sub-industry) -
  not for inventing what the product does.
- Pregenerated, not generated-on-send: a `POST
  /api/v1/me/contacts/:id/generate-draft` route that produces a
  reviewable draft (stored, not sent) - human-in-the-loop review
  before send stays the model, matching mailguyai.com's own venture
  spec ("review-and-send rather than full autopilot... full autopilot
  response-sending carries real liability").

## Phase 3: the personalized before/after landing page (large - genuinely new infrastructure)

Revised design (2026-09-10): instead of morphing abstract colors
between a generic template and their site, this is an honest **"here's
your site, here's our redesign, here's specifically what we'd
improve"** comparison - a real, well-established agency-pitch pattern,
not a cosmetic reskin. This also directly resolves the open question
the first draft of this doc raised: a labeled before/after critique is
categorically different from silently reproducing someone's design -
there's nothing to confirm a line on here, the honesty *is* the pitch.

Real sub-steps:

1. **Capture the prospect's real homepage as a screenshot** - via
   Cloudflare's Browser Rendering binding (`env.BROWSER`), the exact
   same real capability `mailguyai.com`'s own sibling venture
   `cutsheetx`/discovery-engine work already uses elsewhere in this
   estate, not a new dependency. Full-page screenshot at a fixed
   viewport. This is the real "before" - a faithful capture, not a
   reconstruction, so nothing about it can misrepresent their actual
   site.
2. **A real WeylandAI "after" redesign template** - one real, well-
   designed template (or a small set of variants per sub-industry) in
   WeylandAI's actual house style, with slots for the prospect's real
   logo, company name, and tagline (scraped via favicon/`og:image`/
   header-`<img>` heuristics - lightweight, not full-page parsing).
   This is real design work that has to exist before anything can
   compare against it - not inferred from the prospect's page, and not
   a redraw of their actual layout.
3. **The specific improvement callouts** - generated per-prospect by
   giving the real before-screenshot to Claude's vision capability
   (already used extensively elsewhere in this estate for real
   document/image analysis - e.g. the hardware-extraction pipeline)
   and asking for 3-5 concrete, defensible, checkable critique points
   grounded in what's actually visible (e.g. "no clear call-to-action
   above the fold", "dense text-only hero", "nav buried in a hamburger
   menu on desktop") - not generic marketing copy, not fabricated
   stats. Each callout should be something the prospect could look at
   their own real site and verify is true.
4. **The comparison mechanic**: a scroll-pinned section that
   crossfades/wipes between the two real images (their real screenshot
   → the real redesign) via `clip-path` or opacity, driven by
   `scroll-timeline`/`animation-timeline: scroll()` (JS scrollY
   fallback for browsers without native support yet), with each
   improvement callout fading in as a labeled annotation at its own
   scroll checkpoint, pointing at the specific redesigned region it
   describes. A real, standard scroll-reveal technique - just applied
   to two real screenshots instead of a live-rendered page.
5. **Hosting**: one static page per prospect at a real, sharable URL
   (Cloudflare Pages or R2+Workers, same `serveR2` pattern used
   elsewhere in this estate) - generated once when the outreach draft
   is created (Phase 2), not on-demand per email open.
6. **The email-embedded preview**: a static image or short GIF of the
   effect (Browser Rendering can capture a scroll-sequence the same
   way it captures the initial screenshot), embedded inline with the
   live page linked underneath.

## Ordered plan across all three phases

1. `contacts` table (migration 0003) - the entity Phase 1 and 2 both
   need; Phase 1's stale-contacts query and Phase 2's personalization
   both read from it.
2. Phase 1 (stale-contacts route + UI view) - smallest, ships fastest,
   immediately useful even before Phase 2/3 exist.
3. Phase 2's capability-sheet content (real work, not code) - needed
   before `modules/outreach-gen.js` can produce anything honest.
4. Phase 2's generation module + draft route + review UI.
5. Phase 3's WeylandAI "after" redesign template(s) (real design work -
   this has to exist before step 6 can compare against it).
6. Phase 3's screenshot capture + callout generation + comparison-page
   builder + hosting + email-preview pipeline - the largest remaining
   piece, worth its own follow-up scope doc with real implementation
   detail once 1-5 are real, rather than fully detailing now.

Phases 1-2 don't depend on Phase 3 at all and can ship independently.
Phase 3 is the piece that turns this into something qualitatively
different from a normal outreach tool - real, still the highest-effort
part, but no longer blocked on an open question - the before/after
framing is honest by construction.
