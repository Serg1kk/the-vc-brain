# 07 · Thesis Engine — Handoff

> What other features need from 07, in one place. Authoritative detail lives in `design.md`
> (rev.3a); this file is the contract surface, not a summary of the design.
>
> Status: contract frozen as of the design; build in progress. Anything below marked ⚠️ is a
> change another terminal must absorb.

## 1 · Calling the gate

**Workflow** `f07-thesis-gate` (n8n). **Headless equivalent**: `node lib/f07/run.js <application_id>`
— same code path, usable without n8n and with `--recorded <dir>` to replay a saved extraction
instead of calling the LLM.

```jsonc
// in
{ "application_id": "uuid",
  "text": "deck text | HN post text | page text",   // 07 does NOT parse PDFs
  "mode": "full" | "keyword",
  "structured_hints": { "geography_country": "DE" }  // optional, any subset of §1.1 keys
}

// out
{ "verdict": "passed" | "borderline" | "failed" | "insufficient_evidence",
  "fit": 0-100,                 // null in keyword mode
  "coverage": 0-1,              // null in keyword mode
  "fired_rules": [ … ],         // shape in §3
  "missing_fields": ["stage_evidence"] }
```

**Modes.** `full` runs the extraction LLM call and the full claims write path. `keyword` makes
**no LLM call at all**, evaluates only `_text` rules and `structured_hints`, and **never returns
`passed`** — it is a cheap negative filter, not an endorsement. Keyword mode writes no
`scores(thesis_fit)` row and reports `coverage` as null.

## 2 · ⚠️ For feature 02 (sourcing radar) — read this before wiring the gate

1. **Call it with `mode: 'keyword'` in Tier 1.** That is the mode that honours your «no LLM, no
   GitHub token» constraint. `mode: 'full'` costs an LLM call per candidate.
2. **`applications.thesis_gate` can be NULL after a successful gate call.** This is new. When the
   gate cannot evaluate enough of the thesis it returns `insufficient_evidence` and writes
   `thesis_gate = NULL` — an actual write, not a skip. Your design branches on three values; NULL
   falls through all three. Until you handle it, a NULL-gated application simply does not advance
   to Tier 2, which is the safe direction, but it is silent — decide deliberately.
   *(07 chose NULL over adding a fourth enum value precisely so your CHECK and your branch would
   not break underneath you. The fall-through is the residual cost of that choice.)*
3. **Geography is matched at country level**, matching your GitHub-location normalization. Pass it
   as `structured_hints.geography_country` (ISO-3166-1 alpha-2). 07 derives the region itself.
4. **Failed verdicts are persisted in full** — you need them for base rates and the RSK-004
   survivorship defence, and they are there.
5. The `gated_out` counter is emitted to `events` per run.
6. ⚠️ **`failed` is rare by construction.** Every compiled mandate rule is `soft`, so only a
   hand-authored `hard` rule rejects — in the starting thesis, exactly one (gambling/adtech).
   Do not size your Tier-1 cost saving on a high rejection rate.

## 3 · For feature 06 (memo) — `fired_rules[]`

Read from `thesis_evaluations.fired_rules`. Element shape:

```jsonc
{ "id": "R1", "label": "Excluded sector: gambling",
  "kind": "deal_breaker" | "must_have" | "focus",
  "enforcement": "hard" | "soft",
  "outcome": "satisfied" | "missed" | "triggered" | "unknown",
  "field": "sector", "expected": ["gambling","adtech"], "observed": "gambling",
  "weight_applied": 0 }
```

The memo's recommendation is thesis-relative and should name the rules that fired.
`outcome: "unknown"` means the rule could not be evaluated — say so honestly rather than treating
it as a pass or a miss.

`weight_applied` is the weight actually contributed to `earned`: the rule's `weight` when a
`must_have`/`focus` is `satisfied`, otherwise 0. Deal-breakers always carry weight 0 by
construction, so for them it is always 0.

**Compiled mandate rule ids** (stable, safe to reference): `M_sector`, `M_geography`, `M_stage`,
`M_poskw`, `M_negkw`. Hand-authored rules keep whatever id the thesis config gives them.

## 3a · ⚠️ For whoever builds the gate workflow — one caller obligation

The evaluator (`lib/f07/rules.js`) is a pure function with no database access. D-03 says a field is
`unknown` if it is absent, null, in `missing_fields`, **or backed only by a `contradicted` claim** —
but only the first three are visible to the library. **The workflow must resolve contradicted
claims itself and fold those fields into `missing_fields` before calling.** Skip this and a
disproven attribute is treated as a good observation, which can fire a hard rule and reject an
application on evidence feature 05 has already refuted.

## 4 · For features 03 / 04 / 05 — the `company.*` claims

07 owns a new claim topic prefix and writes it on every `mode: 'full'` gate call:

`company.sector` · `company.business_model` · `company.geography_country` ·
`company.stage_evidence` · `company.what_is_built`

`source_kind = 'self_reported'`, low base confidence, `axis` NULL, each with a real
`text_verbatim` quote and a supporting `evidence` row pointing at the `raw_signals` extraction.
Gaps use the `*.gap` convention with `verification_status = 'missing'`.

**Feature 05:** these are unverified self-reported claims by construction — they are yours to
verify. When you flip one to `contradicted`, 07's re-evaluation treats that attribute as
**`unknown`**, never as a rejection, so a contradicted sector cannot fire a hard rule.

**Feature 04:** 07 reads `theses.config.geos` for you — the key is present in the seeded thesis.
It holds **country codes**, not regions, because you interpolate them into search queries.
`applications.thesis_id` remains nullable; your `missing_flags.no_thesis_geography` fallback stays
valid.

## 5 · For feature 09 (dashboard) — feed lanes and the config form

**07 owns the lane spec; 09 owns the query and the UI.** Three lanes:

1. `passed`, sorted `thesis_fit desc`.
2. `borderline` → «Outside thesis», down-ranked, **never hidden**.
3. «Off-thesis but exceptional», **pinned above both**: verdict `borderline` **and** a
   `founder_score` at or above `exceptional_lane.min_value`. Lane-3 rows are **removed from**
   lane 2, not duplicated.

The lane-3 join crosses a subject-type boundary and is easy to get wrong: `founder_score` is
**founder-scoped** (`founder_id` set, `application_id` NULL), while the lane filters applications.

```
applications → companies → founder_company (is_current) → founders → scores(axis='founder_score')
aggregate: max over current founders   (configurable via exceptional_lane.aggregate)
```

**An absent `founder_score` excludes from the lane without implying a low score** — feature 03
writes no row at all for insufficient-evidence founders, and an absent axis row means «not
assessed», never zero.

**Config form:** to publish a new thesis version, INSERT with **`active = false` explicitly** (the
column defaults to `true`, so omitting it is a deterministic 23505 against
`uq_theses_active_name`), then call `POST /rpc/activate_thesis_version`. Never raw-INSERT an
active row, and never flip `active`/`is_default` by hand — the RPC moves them together in one
transaction, and splitting them can leave the gate with no thesis to load.

## 6 · For feature 10 (API/CLI)

`theses` and `thesis_evaluations` are exposed as-is via PostgREST. `thesis_evaluations` is
**append-only**: UPDATE and DELETE raise `P0001`, TRUNCATE is revoked for all three roles.

⚠️ **Do NOT read `scores` directly for the current thesis fit. Go through `thesis_evaluations`.**

This corrects an earlier version of this document. `scores` is append-only and has no uniqueness on
`(application_id, axis)` — for any axis — so «latest row» is not the same as «current verdict». QA
reproduced the failure: an application scored 100 (`passed`), was re-run, and degraded to
`insufficient_evidence`. No new `scores` row was written (correct — an absent row means «not
assessed»), `thesis_gate` went NULL (correct), and a direct `scores` query **still returned
100.00** for an application the system can no longer assess.

Correct resolution:

1. Take the latest `thesis_evaluations` row for `(application_id, thesis_id)`.
2. If `verdict = 'insufficient_evidence'` or `score_id IS NULL` → **not assessed**. Render it as
   such; do not fall back to an older number.
3. Otherwise follow that row's `score_id`.

The `thesis_id` term matters because several theses can be active at once — a naive
«latest per (application, axis)» silently mixes theses *and* resurrects retracted verdicts.

## 6a · ⚠️ Reading `missing_flags` on a `thesis_fit` score row

**Read `missing_flags.missing_fields`. Do not iterate `missing_flags` itself.**

07's score rows carry `missing_flags = { missing_fields: [...], _f07_input_fingerprint: "..." }`.
The list of things the system did not know is the **nested `missing_fields` array**. The
fingerprint is writer-internal: it exists so the score write can be select-first, and without it a
crash between the score write and the evaluation write orphans a `scores` row permanently (`scores`
has no unique key by design, so nothing at the database level would catch it).

**Two rules, either one sufficient:**
- Read `missing_flags.missing_fields`, not the object's keys.
- Any key in `missing_flags` prefixed with `_` is writer-internal and must never be rendered.

A consumer that enumerates `missing_flags` and renders every key as a gap would show an investor a
hash as a missing data point. Feature 01 specifies the column's meaning but not its shape, so both
readings were defensible until now — hence the explicit rules.

## 7 · Invariants other features must not break

- `thesis_fit` is **not** a screening axis and never blends into Founder / Market / Idea-vs-Market.
  There is no overall blended number anywhere in the schema, deliberately.
- **07 is the sole writer of `axis='thesis_fit'`.** Exactly one feature may write a given axis —
  `scores` has no uniqueness, so two writers race silently.
- Missing data lowers **coverage**, never `fit`. An application with coverage below
  `fit.min_coverage` is removed from the ranking entirely rather than ranked low.
- A `hard` rule fires only on a confirmed `match`. An unextracted field can never cause a
  rejection.
