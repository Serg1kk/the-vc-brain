# 04 · Market, Trend & Competition Intel — Handoff

> For features **05 (truth-gap)**, **06 (memo)**, **09 (dashboard)** and **10 (API/CLI)**.
> Status: feature complete, QA gate PASSED (`qa-report-04.md`). Spec: `design.md` rev.3.

## What 04 writes

Per application run, into the feature-01 schema. **Zero migrations** — competitors live as
`claims` with a structured `value`, per 01 design §9.

| Table | Rows | Notes |
|---|---|---|
| `scores` | up to 3 | `axis` ∈ `market`, `idea_vs_market`, `founder`. Subject is `application_id`; `founder_id` stays NULL even on the founder axis — it is the *application's* founder axis, not the person's persistent score (03 owns that). |
| `claims` | ~12-25 | vocabulary below |
| `evidence` | 1+ per sourced claim | `tier` ∈ documented/discovered/inferred/missing, `strength` populated from the tier table |
| `raw_signals` | 0-N | `source` ∈ `tavily_search`, `tavily_news`; `company_id` always set |
| `ai_runs` | 3+ | one per LLM call, written **before** validation ("model proposes, backend decides") |

## Claim topic vocabulary

`market.category` · `market.size_bottom_up` · `market.size_top_down` · `market.growth` ·
`market.venture_scale_check` · `market.trend` · `market.why_now` · `market.tailwind` ·
`market.headwind` · `market.shadow_market_hypothesis` · `market.outlook` ·
`competition.competitor` · `competition.status_quo_alternative` ·
`competition.founder_claim_mismatch`

## Contracts you must honour

### 1. Never threshold on `scores.value` alone

An **unmeasured** market and a **measured, middling** market both score **50**. That is
deliberate (§6.0/§6.3): an unknown TAM band contributes the same base as WATCH, because absence
must never score worse than a verified negative (REQ-003). The two are distinguishable only by
`confidence` and `missing_flags`.

A decision node that reads `value >= 50` treats "we could not research this category" as
equivalent to "this market is adequate". Read `confidence` and `missing_flags` alongside it,
always.

### 2. An absent axis row means "not assessed", never zero

Two paths legitimately write no row:
- **all searches returned nothing** → no `scores(market)` row at all (§4: a score with no
  evidence is worse than no score);
- **no `founder_score` exists yet** for anyone on the application → no `scores(founder)` row
  (§6.6; 03's `insufficient_evidence` branch).

Rendering a missing row as 0 inverts REQ-003 — it converts our honesty about ignorance into a
penalty against the founder.

### 3. `market.outlook` has four values, not three

`bullish` / `neutral` / `bear` / **`undetermined`**. The fourth exists because an unresearched
market scores exactly 50, and a naive threshold would print a confident "neutral" on zero
evidence. If you render outlook, render `undetermined` distinctly — it is the difference between
"we assessed this as middling" and "we could not assess this".

### 4. A `missing` claim is data, not an absence

`verification_status='missing'` claims are written deliberately (REQ-004) with human-readable
`text_verbatim` — e.g. *"Bottom-up TAM: not established."*, *"Why-now: no typed, cited catalyst
established."* Feature 06 should surface these as the memo's honest-gaps section rather than
filtering them out; a memo that states its gaps scores **more** trusted, not less.

## Specifically for feature 05 (truth-gap)

- `competition.founder_claim_mismatch` claims carry `reporting`'s `contradiction_record`
  vocabulary: `nature` ∈ factual/definitional/methodological/temporal/scope, `severity` ∈
  minor/moderate/material. Severity is **deterministic** (§8), not an LLM judgement.
- The same mismatch also writes an `evidence` row with `relation='contradicts'` against the
  founder's own competition claim — 01 §4.4 says a contradiction is data, not a flag, and your
  recompute path reads `evidence`, not claims.
- When the deck has no competition slide, 04 first writes a `self_reported` competition claim
  with `verification_status='missing'` so that contradiction has a target (`evidence.claim_id`
  is NOT NULL).
- `evidence.strength` is populated (0.90/0.80/0.60/0.30/0.00 by tier) so your
  `f(tier, relation, strength)` rollup works.
- 04 **never** computes a Trust number. Per-claim trust stays computed-live (invariant #3).

## Specifically for feature 06 (memo)

- Market sizing: `market.size_bottom_up` carries `assumptions[]` and its per-number
  `source_url`s — the brief requires stated assumptions.
- Competition: `competition.competitor` records carry `company_mentioned`. **Competitors the
  founder did NOT name are the highest-value output** — surface them as their own block.
- `market.venture_scale_check.scenarios[]` holds the founder-standard 10% and 20% cases beside
  our calibrated share, so the memo can show what the founder's own assumption would imply.
- Cite `claim_id`s only; the renderer resolves them to sources.

## Known gaps (QA-verified, deliberately not fixed)

| Gap | Why not fixed |
|---|---|
| Intermittent duplicate `scores(idea_vs_market)` in one execution | Harmless under append-only semantics — "current" resolves by max `computed_at`, so it costs a row, not a wrong answer. The proper fix is a `content_hash` guard on `scores`, i.e. a schema change. |
| `supersedes_claim_id` NULL on all claims **DB-wide** | Shared gap across features, not 04's alone. Consumers fall back to `ORDER BY created_at DESC`. |
| `evidence.quote_verbatim` sparse | Being closed at time of writing; see tracker. |

## Reproducibility

`end_date` is **pinned** on every Tavily call. Without it the same scoring run returns different
evidence tomorrow — a demo recording and the repo would disagree. Pass it explicitly for anything
you need to reproduce.
