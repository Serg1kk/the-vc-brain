# 11 · Demo Data & Ethics — DONE

**Status: done · QA gate PASSED (2026-07-19), zero blockers.**
Read alongside: [fixture-notes.md](fixture-notes.md) (scenario map) · [qa-report-11.md](qa-report-11.md) (adversarial gate).

## What shipped

A **10-company fully-synthetic demo fixture** plus the product's ethics/compliance guarantees.
Not the original "3-5 real + 1-2 synthetic" plan — see README's "Shipped" section for why
(fabricating red flags about a real person is defamation; the entity gate exists to prevent
exactly that, so seeded-contradiction scenarios live entirely on fictional people). Real
founders still appear in the product via the ~150-founder live feature-02 radar corpus; they
are never given invented flags.

### The fixture — `db/fixtures/11-demo-data.sql`
- 10 applications: **5 inbound** (deck) + **5 radar** (deckless). Reserved UUID range `11f0…`,
  every INSERT `ON CONFLICT (id) DO NOTHING`, one transaction, idempotent, applies clean and
  `db/tests/smoke.sql` is green before and after.
- Inserts **source-of-truth rows only** (founders, companies, identities, cards, claims,
  evidence, raw_signals, metric_observations, events) — no `scores`/`memos`/
  `thesis_evaluations` rows are seeded. The pipelines produce the numbers (same stance as
  fixture 07).
- Every person/company fictional, `is_synthetic=true` everywhere, all domains `.example`.

### The 10 scenarios (each verified live through the real pipelines, not as inert seed rows)

| # | Company / founder | Demonstrates | Live-verified outcome |
|---|---|---|---|
| 1 | Voltaic Labs / Jonas Reiter | Documented contradiction | `claim_contradicted` event with full payload; `claim_trust` shows trust 0.0, contradiction_penalty 0.3, `partially_supported` |
| 2 | Cassia Health / Femke de Winter | Not-disclosed gap | `stage_evidence` first-class `verification_status='missing'` |
| 3 | Kelpgrid / Nikolaj Brandt | "Outside thesis", never rejected | `thesis_evaluations.verdict='borderline'`. **Driver is sector** (climate, off mandate), NOT geo — DK satisfies EU/US. `rejected` is not even a valid CHECK value |
| 4 | Ledgerline / Claire Bosquet | Forecast claim never verdict-eligible | `market.size_tam` → `router_class='forecast'`, permanently `unverified` |
| 5 | Playdrift / Marcus Vale | Insufficient-evidence by construction | `verdict='insufficient_evidence'`, exactly 3/5 attributes missing |
| 6 | tracewire / Mila Sørensen | Documented radar execution + searched-nothing-found | founder_score **82.80**; provenance row `tier='missing'`, `quote_verbatim=NULL` |
| 7 | quietgpu / Andrei Balan | HN-only identity, honest low-confidence score | founder_score **23.68 / conf 0.22** (added this pass); zero github identity rows |
| 8 | saltmarsh / Priya Raman | Low-obscurity strong execution | founder_score **82.44** |
| 9 | ferrofluid / Tomás Aguiar | **Star-farming red flag R2, visible on a scored row** | founder_score **71.62**; `E5` demoted `self_asserted`/`missing`/`demoted_by='R2'` in `score_components` on the real `scores` row |
| 10 | patchbay / Yuki Andersen | Cold-start honesty | **0 score rows** (correct insufficient_evidence, REQ-003) + `founder_score_insufficient_evidence` event |

### Ethics guarantees (feature 11's core deliverable — all PASS in the QA gate)
- **REQ-004 badge honesty:** all 10 records resolve `is_synthetic=true` with working
  `company_name`/`application_id` via both `api_founders` and `api_applications`, confirmed over
  live PostgREST. The earlier "missing founder card → NULL company_name" bug class does not
  recur on any of the 10.
- **Right to erasure:** `purge_founder()` runs clean on a synthetic founder (tested inside
  `BEGIN…ROLLBACK`, incl. an attached `interviews` row to exercise the recently-fixed
  interviews-before-cards ordering) — removes founder/company-scoped rows, leaves exactly one
  anonymised audit event, FK-error-free.
- **Data minimisation:** zero Art.9-style fields (age/DOB/photo/gender/ethnicity/religion/
  health/orientation/nationality) anywhere in the fixture or schema. Professional-capability
  signals only.
- **No real-person resemblance:** all fictional, all `.example`.

### The ethics UI surfaces are owned by other features (by design)
Feature 11 owns the data and the guarantees above. The visible UI lives elsewhere:
- SYNTHETIC badge + opt-out button on the founder card → **feature 09** dashboard.
- "What we collect" disclosure (`DisclosureBanner.tsx`) → **feature 08**.

## Work done this closeout pass
1. **Two radar founders promoted to real scores (operator decision "Option A").** Andrei and
   Tomás were collapsing to insufficient-evidence because their fixture coverage sat below the
   `min_coverage=0.25` floor — correct behaviour, but it hid Tomás's marquee R2 red flag from
   the dashboard entirely. Added 1–2 synthetic claims each (Andrei: HN-derived self-reported
   L2/X6, HN-only narrative preserved; Tomás: documented E1 merged-PR + X1/X6 pre-funding from
   repos *separate* from the star-farmed snapshot, so R2 still fires). Re-ran `lib/f03/run.js`
   live; both now score. Yuki deliberately left at insufficient-evidence.
2. **Independent adversarial QA gate** (`qa-report-11.md`) — all 10 scenarios + 4 ethics
   invariants PASS, zero blockers.
3. **Doc reconciliation** — README/README.ru status → done + "Shipped" section; fixture-notes
   corrected for the Kelpgrid geo→sector reality and the Andrei/Tomás scores.

## Known-open / non-blocking
- **Kelpgrid "outside thesis" reads as sector, not geography.** The demo beat ("strong company,
  Outside-thesis lane, never rejected") holds. If the demo narration specifically needs a
  *geographic* miss, Kelpgrid's location would have to move outside EU/US (a ~2-line fixture
  change) — flagged to the operator, not actioned.
- **The 5 radar applications have no `thesis_evaluations` rows.** Not required by any of the 10
  scenarios; noted for future awareness only.
- **Score reproducibility:** the f03 extractor picks different verbatim quotes per run
  (`gpt-5.6-luna` rejects `temperature:0`, so it is omitted) — the same fixture founder can
  score slightly differently on a fresh `--record` run. The recorded replays under
  `lib/f03/recorded/11-demo-fixture/` pin the demo values. A judge re-running a live score may
  see variance; this is a project-wide property (see TRACKER), not specific to 11.
- **`purge_founder()` does not delete Supabase Storage objects** (feature-08 finding): an
  uploaded deck survives an erasure request and becomes unfindable once the `applications` row
  is gone. Out of scope for the synthetic fixture (radar rows are deckless; inbound decks are
  fixture text, not uploaded files), but it is the one real gap in the erasure story for a
  production deck upload.

## Files
- `db/fixtures/11-demo-data.sql` — the fixture (modified this pass: +6 rows for Andrei/Tomás).
- `lib/f03/recorded/11-demo-fixture/{andrei,tomas}/` — recorded sub-scorer replays (untracked).
- `docs/backlog/11-demo-data-ethics/{README,README.ru,fixture-notes,qa-report-11,done}.md`.
