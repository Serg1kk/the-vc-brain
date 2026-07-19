# 11 · Demo Data & Ethics Layer

Status: **done** — QA gate PASSED 2026-07-19, zero blockers · Depends on: 02, 08
Closeout: [done.md](done.md) · Fixture map: [fixture-notes.md](fixture-notes.md) · QA: [qa-report-11.md](qa-report-11.md)

## Shipped (2026-07-19) — read this before the design narrative below

What actually shipped differs from the original "real + synthetic" plan below, and the
difference is deliberate:

- **The demo fixture is 10 FULLY synthetic applications** (`db/fixtures/11-demo-data.sql`),
  not "3-5 real + 1-2 synthetic". Every person and company is fictional, `is_synthetic=true`
  everywhere, all domains `.example`. 5 inbound (deck) + 5 radar (deckless), each engineered
  to force exactly one honest-UI state (documented contradiction, not-disclosed gap, outside-
  thesis lane, forecast claim, insufficient-evidence, searched-nothing-found provenance,
  HN-only identity, star-farming red flag R2, karma-only obscurity, cold-start).
- **Why fully synthetic, not real:** fabricating claims, contradictions or red flags *about a
  real founder* is exactly the defamation the entity gate exists to prevent. Real founders do
  still appear in the product — the ~150-founder live corpus from the feature-02 radar is
  browsable in the dashboard — but they are never given invented red flags. The seeded-
  contradiction demo scenarios therefore live entirely on synthetic people.
- **The ethics UI surfaces are delivered by other features**, by design: the SYNTHETIC badge
  and the opt-out button on the founder card ship in feature 09; the "what we collect"
  disclosure (`DisclosureBanner.tsx`) ships in feature 08. Feature 11 owns the **data**, the
  **read-path guarantees** (badge resolves for all 10), and the **ethics guarantees**
  (erasure works end-to-end, no Art.9 / minimisation fields, no real-person references).
- **Scenario reconciliations vs the original narrative** (both verified live, see
  `fixture-notes.md`): Kelpgrid lands "outside thesis" on **sector** (climate, off the fund's
  b2b-software/ai-infra/devtools mandate), not on geography — Denmark satisfies the EU/US geo
  rule; the "Outside thesis, never rejected" demo beat holds either way. Andrei (quietgpu) and
  Tomás (ferrofluid) now carry **real founder scores** (23.68 low-confidence / 71.62 with the
  R2 red flag visible on the scored row) rather than collapsing to insufficient-evidence.

The sections below are the original design/grooming intent, kept as context.

## What it is

The demo substrate and the compliance story: **3-5 REAL founders** discovered by our own
radar (fresh HN Show HN / GitHub) + **1-2 synthetic profiles with seeded contradictions**
(to safely demonstrate truth-gap and red flags on stage), plus the visible ethics layer:
public-data-only, opt-out, data minimisation, robots.txt respect.

## Why (rubric & evidence)

- Brief §5: no dataset provided — bring/synthesize your own; synthetic profiles with seeded
  contradictions explicitly suggested; **ingestion quality > dataset size**.
- Judges in a VC challenge will ask about legality (data-sources.md §legal): the plan is to
  answer BEFORE they ask — an ethics slide + visible product mechanics.
- Real founders found live = the strongest sourcing proof («not on Crunchbase — we found him»).
- Operator decision (Jul 19): real + 1-2 synthetics.

## Where the idea comes from

- `internal/research/data-sources.md` — the full legal/ethics plan: hiQ precedent both sides,
  EDPB 03/2026 + CNIL checklist, data minimisation as both compliance AND bias defense,
  «right to object» button, transparency of sources per score.
- due-diligence-agents examples (project-atlas) — synthetic-with-contradictions shape.
- RSK-004: synthetics also let us show calibration honesty without exposing a real person's
  weaknesses on stage (fairness optics).

## Implementation view

1. **Real founders**: run radar (02) on a fresh HN Show HN window at build time; pick 3-5
   with rich footprints (GitHub hub resolves, personal site crawls); pre-warm scoring so the
   demo is instant; keep raw snapshots as provenance.
2. **Synthetics**: 1-2 hand-crafted profiles via a small n8n generator or by hand: one
   «too good to be true» (claims 10k users, repo created last week from a copied source →
   provenance flag + contradiction) and one honest cold-start (thin footprint, high
   confidence-gaps → shows missing-handling). Marked `synthetic=true` in DB, visibly badged
   in UI (never presented as real — REQ-004 honesty).
3. **Ethics layer in product**: opt-out button on founder card + public «what we collect»
   note on the apply page + data minimisation (no age/photo/Art.9 fields anywhere) +
   robots.txt check visible in the crawl workflow. One slide in demo video: «Only public
   data, official APIs, no fake accounts, no CAPTCHA bypass; delete-on-request».

## Boundaries & stubs

No GDPR paperwork (a demo, stated as such: «for production in EU — documented legitimate
interest assessment per EDPB 03/2026»). Real founders: professional-signal data only.

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** synthetic-profile generator with seeded contradictions.
- **n8n (MANDATORY, two n8n agents):** radar pre-warm run on the fresh HN window (uses feature 02 workflows).
- **Data model:** @database-engineer — `synthetic` flag; reconcile with 01.
- **UX/Design:** small but visible — synthetic badge, opt-out button, «what we collect» note; @designer folds into 09.
- **QA:** @qa-engineer — synthetics NEVER render unbadged (REQ-004 honesty), opt-out actually deletes, no Art.9/minimisation violations in collected fields.

## Open questions

- Contact the real founders? (Nice-touch post-hackathon: «you were scored by our demo, here's
  your card + opt-out» — decide with operator later; NOT during the 24h.)
