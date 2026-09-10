# Scope: personalized outreach engine

Three real, separable features requested together. Scoping them as
three phases on the same foundation (the outreach tracker from
AUTHFOR_MULTIUSER_SCOPE.md) rather than one monolithic build - they
have very different risk profiles and none blocks the others.

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

## Phase 3: the personalized landing page (large - genuinely new infrastructure)

The most novel and highest-effort piece. Real sub-steps:

1. **Scrape the prospect's site** - fetch their homepage HTML, extract:
   dominant color palette (from CSS/inline styles on header/nav/CTA
   elements - a real, boundable computer-vision-adjacent problem, not
   full page cloning), logo (favicon / `og:image` / header `<img>`
   heuristics), and site title/tagline text. **Not** a pixel-perfect
   layout clone - that's a much harder problem than color/logo
   extraction and isn't what "their own shape and color" requires to
   be convincing.
2. **A real WeylandAI "proposed build" template** - this needs to
   exist as an actual design (colors, layout, copy) before anything
   can morph *into* it. Real design work, not something inferred from
   the prospect's site.
3. **The morph itself**: a single static page per prospect, built at
   generation time (not rendered live per-visitor) from the scraped
   palette/logo + the template, using CSS custom properties
   interpolated via `scroll-timeline`/`animation-timeline: scroll()`
   (or a scroll-percentage JS fallback for browsers without native
   support yet - real browser support is still partial) to shift
   `--brand-color`, `--bg-color`, etc. from the prospect's extracted
   values to WeylandAI's as the visitor scrolls.
4. **Hosting**: one static page per prospect at a real, sharable URL.
   Cloudflare Pages or R2+Workers (same pattern as `serveR2` elsewhere
   in this estate) - generated once when the outreach draft is created
   (Phase 2), not on-demand per email open.
5. **The email-embedded preview**: a static screenshot or short GIF of
   the effect, generated once (e.g. via Cloudflare's Browser Rendering
   binding taking a scroll-sequence of screenshots - the same real
   capability already used elsewhere in this estate, not a new
   dependency), embedded as an inline image with the live page linked
   underneath.

**Real open question, not a detail to skip**: scraping a prospect's
site without their knowledge, to build a page that visually references
their own branding, sits in a gray area worth a real decision before
building - not a legal read from me, but worth John explicitly deciding
the line (e.g. "generic color/logo extraction from a public homepage"
reads very differently from "we copied your layout" - the phase 3
scope above is deliberately the former, not the latter, but confirm
that's the intended line before this ships).

## Ordered plan across all three phases

1. `contacts` table (migration 0003) - the entity Phase 1 and 2 both
   need; Phase 1's stale-contacts query and Phase 2's personalization
   both read from it.
2. Phase 1 (stale-contacts route + UI view) - smallest, ships fastest,
   immediately useful even before Phase 2/3 exist.
3. Phase 2's capability-sheet content (real work, not code) - needed
   before `modules/outreach-gen.js` can produce anything honest.
4. Phase 2's generation module + draft route + review UI.
5. Phase 3's WeylandAI "proposed build" template (real design work).
6. Phase 3's scraper + morph-page generator + hosting + email-preview
   pipeline - the largest remaining piece, worth its own follow-up
   scope doc once 1-5 are real and the open question above is
   answered, rather than fully detailing implementation now.

Phases 1-2 don't depend on Phase 3 at all and can ship independently.
Phase 3 is the piece that turns this into something qualitatively
different from a normal outreach tool - real, but the highest-effort
and highest-judgment part, and the one with an open question that
needs your answer before implementation starts.
