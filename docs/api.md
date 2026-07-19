# API Reference — `api_*` PostgREST views

Machine-facing read surface for the VC Brain. Full design and rationale:
`docs/backlog/10-api-cli-skill/design.md` (§3 surface + auth, §4 the three views,
§8 invariants).

**Scope of this document.** This covers only the part of feature 10 that exists and has
been verified live against the running database right now: the three `api_*` PostgREST
views. The natural-language search endpoint and the `vcbrain` CLI are built by other
agents in parallel — see the placeholder at the bottom of this document.

Every value shown below was pulled from the live database on 2026-07-19. Where a column
is sparsely filled or empty across the corpus, that is stated with the measured count —
this is deliberate: an honest "we don't have this yet" is worth more to a consumer than a
column that looks populated in a schema diagram but is NULL on every row in practice.

---

## 1. Base URL, auth, and the honest security note

```
REST base:  http://localhost:8000/rest/v1/
Views:      api_founders, api_applications, api_claims
Header:     apikey: <VCBRAIN_TOKEN>
```

`VCBRAIN_TOKEN` is currently the Supabase `anon` key from `infra/supabase/.env`
(`ANON_KEY`).

> **This token has full read AND WRITE access to every table in the database, including
> `theses` (the fund's mandate) and `claims` (the evidence ledger). It is a demo
> credential, not production auth.** No per-fund keys, no scopes, no rotation, no rate
> limiting.

This is reproduced verbatim from `design.md` §3.2 — it is not softened here. Feature 10
itself performs no writes; the write capability is a property of the Supabase deployment
(schema-wide default privileges grant `anon` `SELECT/INSERT/UPDATE/DELETE` on every table
in `public`, and there is no RLS anywhere in this project — cross-cutting ruling). Verified
live, 2026-07-19: `anon` holds `SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER` on
every base table in `public`, plus `TRUNCATE` on most of them including `claims` and
`theses`.

`TRUNCATE` is the one privilege that *is* withheld, and only on the nine tables the schema
explicitly revokes it from: `scores`, `raw_signals`, `evidence`, `ai_runs`, `events`,
`memos`, `score_components`, `score_formulas`, `thesis_evaluations`. Verified live —
`has_table_privilege('anon','scores','TRUNCATE')` is `false` while
`has_table_privilege('anon','claims','TRUNCATE')` is `true`, because `claims` is not
append-only and was never in that list. Do not read this as meaningful protection: those
same nine tables are still `INSERT`/`UPDATE`-able by the token, and the append-only
guarantee on them comes from the `forbid_mutation` triggers, not from the grants.

**The `api_*` views are a documentation and convenience convention, not an enforcement
boundary.** They are owned by `postgres`, run with definer rights, and add no privilege
restriction whatsoever. The base tables (`founders`, `claims`, `scores`, `theses`, …)
remain fully readable and writable by the same token. Reading or writing them directly
bypasses the opt-out/tombstone filtering and the `missing_flags` normalisation documented
below.

**Row cap:** PostgREST is configured with `PGRST_DB_MAX_ROWS=1000`
(`infra/supabase/docker-compose.yml`, `infra/supabase/.env`). Any single request returns
at most 1000 rows regardless of `limit`; verified live — `Content-Range` on an unfiltered
`api_claims` fetch reports `0-733/734` (734 rows) inside that cap. None of the three views
is anywhere near the cap today.

---

## 2. The three views

### 2.1 `api_founders`

One row per founder. **124 rows live** (opted-out founders and merge tombstones are
excluded by the view itself — see §3).

| Column | Type | Meaning | Live example / fill rate |
|---|---|---|---|
| `founder_id` | `uuid` | Primary identity, stable across the founder's history | `03f00001-0000-0000-0000-000000000001` |
| `full_name` | `text` | Display name | `"Devon Ashworth"` |
| `headline` | `text` | Free-text self-description | **5 of 124 filled**; e.g. `"Founder & CEO, Fintrace AI (synthetic fixture — not a real person)"` |
| `is_synthetic` | `boolean` | `true` for seeded demo/test founders — never rank a synthetic founder unlabelled beside a real one | 4 of 124 are `true` |
| `founder_score` | `numeric(5,2)` | Persistent Founder Score, `axis='founder_score'` in `scores`. **NULL, never 0, when unscored** | **3 of 124 have a score.** `29.16` for the founder above |
| `founder_score_trend` | `text` | `improving` / `declining` / `stable` / NULL | `"improving"` on one scored founder, NULL on the other two |
| `founder_score_confidence` | `numeric(3,2)` | 0–1, travels with the score value | `0.53` |
| `founder_score_missing` | `text[]` | Normalised gap-criterion ids, plain string array (see §3) | `["L5","X1","X5","X6"]` |
| `score_assessed` | `boolean` | `true` only when a score row exists | `true` for the 3 scored founders, `false` for the other 121 |
| `scored_at` | `timestamptz` | `computed_at` of the latest score row | NULL when unscored |
| `obscurity` | `numeric` | Radar-sourcing signal from `radar_candidates`, LEFT JOINed | 118 of 124 filled |
| `obscurity_basis` | `text[]` | Which raw signals fed `obscurity` | `["gh_followers","hn_karma"]` |
| `channel` | `text` | Sourcing channel | 123 of 124 filled; values seen live: `hn_algolia`, `interview_answer`, `tavily_extract` |
| `first_seen_at` | `timestamptz` | Earliest `raw_signals.observed_at` for this founder, re-derived (not `radar_candidates.freshness`) | 123 of 124 filled |
| `company_id` | `uuid` | Current company: `founder_company.is_current` when present, otherwise the founder's own card (`cards.card_type='founder'`) | **123 of 124 filled** |
| `company_name` | `text` | Denormalised from `companies.name` | NULL when `company_id` is NULL |
| `application_id` | `uuid` | The application on the founder's own card | **118 of 124 filled** |
| `founder_score_gaps` | `jsonb` | Raw `missing_flags` array, `{criterion_id, what_would_close_it}` objects, unnormalised | see §4 example 1 |

**Default ordering:** `founder_score DESC NULLS LAST, full_name ASC, founder_id ASC`. Never
`obscurity` — a founder with no radar signal (e.g. every inbound applicant) has
`obscurity = NULL`, and sorting on it would float undiscovered founders to the top.

**PostgREST usage:**

```bash
# top 3 by founder_score
curl "http://localhost:8000/rest/v1/api_founders?select=founder_id,full_name,founder_score&order=founder_score.desc.nullslast&limit=3" \
  -H "apikey: $VCBRAIN_TOKEN"

# founders scored 60 or above
curl "http://localhost:8000/rest/v1/api_founders?founder_score=gte.60" -H "apikey: $VCBRAIN_TOKEN"

# a single row by id — PostgREST has no /resource/{id} path; filter on the PK column
curl "http://localhost:8000/rest/v1/api_founders?founder_id=eq.03f00001-0000-0000-0000-000000000001" \
  -H "apikey: $VCBRAIN_TOKEN"

# same, as a single JSON object instead of a one-element array (406 if 0 or >1 rows match)
curl "http://localhost:8000/rest/v1/api_founders?founder_id=eq.03f00001-0000-0000-0000-000000000001" \
  -H "apikey: $VCBRAIN_TOKEN" -H "Accept: application/vnd.pgrst.object+json"
```

### 2.2 `api_applications`

One row per application. **308 rows live.**

| Column | Type | Meaning | Live example / fill rate |
|---|---|---|---|
| `application_id` | `uuid` | Primary identity | `07f00002-0000-0000-0000-000000000004` |
| `company_id` | `uuid` | FK to `companies` | 308 of 308 filled |
| `company_name` | `text` | Denormalised | `"GameLoop"` |
| `company_domain` | `text` | Denormalised | 101 of 308 filled; `"gameloop-thesis07.example"` |
| `stage` | `text` | `companies.stage`, `NOT NULL` in the schema | only two values seen live: `pre_seed`, `seed` |
| `category` | `text` | | **4 of 308 filled**; e.g. `"consumer"` |
| `kind` | `text` | How the application entered the funnel | `inbound`, `radar_activated` |
| `status` | `text` | | `screening`, `sourced` |
| `submitted_at` | `timestamptz` | Aliased from `applications.created_at` — there is no `submitted_at` column in the schema | `2026-07-19T02:08:11.227482+00:00` |
| `artifact_links` | `jsonb` | Provenance of the sourcing artifact (e.g. the Show HN post) | see §4 |
| `score_founder` | `jsonb` | `{value, trend, confidence, missing, assessed}` — see §3 for what each field means and does not mean | `{"value": null, "assessed": false, ...}` on **all 308 rows** |
| `score_market` | `jsonb` | same shape | **assessed on 1 of 308** |
| `score_idea_vs_market` | `jsonb` | same shape | **assessed on 1 of 308** (the same application) |
| `thesis_id` | `uuid` | Active thesis this application was gated against | 191 of 308 filled |
| `thesis_name` | `text` | | `"default"` on every live row |
| `thesis_verdict` | `text` | From `thesis_evaluations.verdict`, **never** `scores` | 191 filled; values seen live: `borderline`, `failed` |
| `thesis_fit` | `numeric(5,2)` | NULL when `verdict='insufficient_evidence'` or `score_id IS NULL`, even though `thesis_verdict` is still reported | **3 of 308 filled** |
| `thesis_coverage` | `numeric(3,2)` | Fraction of thesis fields the gate could evaluate | e.g. `0.62` |
| `thesis_missing_fields` | `text[]` | Native `text[]` from `thesis_evaluations.missing_fields`, populated regardless of verdict | e.g. `["geography_country","stage_evidence"]` |
| `thesis_fired_rules` | `jsonb` | Array of `{id, kind, field, label, outcome, expected, observed, enforcement, weight_applied}` — every rule the gate evaluated, matched or not | see live sample in §4 |
| `memo_version` | `integer` | Latest `memos.version` for this application | NULL — `memos` is empty |
| `memo_available` | `boolean` | | **`false` on all 308 rows** — feature 06 (memo generation) is not built yet. This is a truthful column, not a placeholder. |

**PostgREST usage:**

```bash
# applications not at seed stage
curl "http://localhost:8000/rest/v1/api_applications?stage=neq.seed&select=application_id,stage&limit=2" \
  -H "apikey: $VCBRAIN_TOKEN"

# multi-value filter
curl "http://localhost:8000/rest/v1/api_applications?status=in.(screening,sourced)" \
  -H "apikey: $VCBRAIN_TOKEN"

# a single application by id
curl "http://localhost:8000/rest/v1/api_applications?application_id=eq.08f360ee-165d-4524-93d0-ec4c54d3f050" \
  -H "apikey: $VCBRAIN_TOKEN"
```

### 2.3 `api_claims` — the evidence ledger

One row per claim, evidence folded into an array. **This is the Agentic Traceability
deliverable.** 734 rows live (109 of them company-scoped — `founder_id IS NULL`, e.g. 04's
`market.*`/`competition.*` and 07's `company.*` claims).

| Column | Type | Meaning | Live example / fill rate |
|---|---|---|---|
| `claim_id` | `uuid` | Primary identity | `03f00006-0000-0000-0000-000000000102` |
| `card_id` | `uuid` | The card (person/company/application bundle) this claim was extracted onto | |
| `founder_id` | `uuid` | The card's `founder_id`, **when non-NULL** — a card with no founder is company-scoped evidence and is retained, not dropped | 625 of 734 filled; NULL on 109 company-scoped claims |
| `company_id` | `uuid` | | |
| `application_id` | `uuid` | | often NULL even when `founder_id`/`company_id` are set — a claim is not always tied to one specific application |
| `topic` | `text` | Dotted taxonomy, e.g. `founder.execution.tech`, `company.sector` | |
| `axis` | `text` | Which `scores` axis this claim was written against, when it feeds one directly. **NULL on the large majority (654 of 734 live)** — most claims support scoring indirectly through topic-based aggregation, not a per-claim axis link. Non-NULL values seen live: `market` (48), `founder_score` (19), `idea_vs_market` (13) | |
| `text_verbatim` | `text` | Human-readable claim text — populated even for `verification_status='missing'` rows | `"Business model: not disclosed."` |
| `value` | `jsonb` | Structured payload when the claim carries one | **255 of 734 filled**, 479 NULL; shapes vary by topic, e.g. `{"forks": 2, "stars": 850, "issues_enabled": false}` or `"b2b-software"` |
| `source_kind` | `text` | | values seen live: `derived`, `public`, `self_reported` |
| `base_confidence` | `numeric(3,2)` | | 113 of 734 NULL; range `0.30`–`0.90` where present |
| `verification_status` | `text` | `unverified` (698 live) or `missing` (36 live) — no `verified`/`contradicted` rows exist yet (05, the truth-gap feature, is still writing) | |
| `created_at` | `timestamptz` | Used as the tiebreak for "latest claim per topic" — `supersedes_claim_id` is NULL database-wide | |
| `evidence` | `jsonb[]` | Array of evidence objects, see below | `[]` when a claim has no evidence rows |

`evidence[]` item shape:

| Field | Meaning | Live fill / values |
|---|---|---|
| `tier` | `documented` \| `discovered` \| `inferred` \| `missing` | live counts (all evidence, 683 rows): `documented` 276, `discovered` 265, `missing` 103, `inferred` 39 |
| `relation` | `supports` \| `context` \| `contradicts` — **a `contradicts` row refutes its claim** | live counts: `supports` 572, `context` 104, `contradicts` 7 |
| `strength` | numeric confidence-in-evidence, 0–1 | e.g. `0.75` |
| `quote_verbatim` | Direct source quote | 388 of 683 filled — nullable, not faked |
| `source_url` | | 643 of 683 filled |
| `raw_signal_id` | FK to the raw capture | |
| `captured_at` | | evidence array is ordered `captured_at DESC, id DESC` |

**PostgREST usage:**

```bash
# claims for one founder, newest first
curl "http://localhost:8000/rest/v1/api_claims?founder_id=eq.03f00001-0000-0000-0000-000000000001&order=created_at.desc&limit=5" \
  -H "apikey: $VCBRAIN_TOKEN"

# company-scoped claims (no founder attached)
curl "http://localhost:8000/rest/v1/api_claims?founder_id=is.null&company_id=not.is.null" \
  -H "apikey: $VCBRAIN_TOKEN"

# the "we looked and found nothing" claims
curl "http://localhost:8000/rest/v1/api_claims?verification_status=eq.missing" \
  -H "apikey: $VCBRAIN_TOKEN"
```

---

## 3. Semantics a consumer must not get wrong

Each of these exists because a specific bug was found while building this feature. Getting
any one of them wrong produces output that looks plausible and is quietly false.

- **The three screening axes are three separate objects. There is deliberately no
  `overall_score`.** `api_applications` exposes `score_founder`, `score_market`,
  `score_idea_vs_market` independently (REQ-002 / invariant #1). Never average, sum, or
  otherwise blend them into one number — that collapses the disagreement between axes an
  investor needs to see, and no such column exists to compute even by accident.

- **An absent axis means "not assessed," never zero.** Check `assessed` before reading
  `value`. Live and load-bearing: `scores(axis='founder')` is empty database-wide — 04
  owns this axis and has not written it — so `score_founder.assessed` is `false` on **all
  308 applications** today, and `value` is `null` on every one, not `0`.

- **Never threshold on a score `value` alone.** An unmeasured attribute and a genuinely
  middling one both land near 50. Always read `confidence` and `missing` alongside `value`.
  Live example: application `08f360ee-165d-4524-93d0-ec4c54d3f050` has `score_market.value
  = 50.00` with `confidence = 0.00` — a value that would look like a neutral verdict is
  actually zero-confidence noise, and `missing` lists 7 reasons why.

- **`founder_score` is present for only 3 of 124 founders live.** No score is the normal
  case, not an error or a missing feature. Do not treat a NULL `founder_score` as "unranked
  = weak"; it means "not yet assessed."

- **`missing` is normalised to a plain string array by the view, but the base tables
  differ per axis** — anyone reading `scores.missing_flags` directly, not through the
  view, must branch on `axis`:
  - `founder_score`: array of **objects**, `{"criterion_id": "X1", "what_would_close_it":
    "..."}`  — not strings, despite what an earlier draft of the design assumed. Measured
    on all 14 live rows.
  - `market` / `idea_vs_market`: **object** of gap flags, e.g. `{"gap_growth": true,
    "search_failed": ["Q5"]}` — value is usually `true` but sometimes an array.
  - `thesis_fit`: object with `missing_fields` — moot for the views; `thesis_missing_fields`
    reads `thesis_evaluations.missing_fields` directly instead.

  The view collects the key name (object shape) or `criterion_id` (object-array shape)
  into one plain `text[]` so a consumer never has to branch. `_`-prefixed keys
  (writer-internal, e.g. `_f07_input_fingerprint`) are dropped.

- **`founder_score_gaps` carries the raw objects**, including `what_would_close_it` — the
  most investor-useful field in the structure (a concrete description of what evidence
  would close the gap). `founder_score_missing` throws that away for a uniform string id;
  read `founder_score_gaps` when you need the "why."

- **Thesis state comes from `thesis_evaluations`, never from `scores`.** A direct `scores`
  read for `axis='thesis_fit'` can return a stale value from a prior run — reproduced live
  during this build. `api_applications.thesis_verdict` / `thesis_fit` / `thesis_coverage`
  / `thesis_missing_fields` all resolve through the latest `thesis_evaluations` row per
  application.

- **`verification_status='missing'` claims are deliberate data, not empty rows.** 36 exist
  live. Each carries a human-readable `text_verbatim` such as `"Business model: not
  disclosed."` — the investor seeing "we looked and did not find X" is the product. These
  are served by the view, not filtered out.

- **`evidence[].relation` ∈ `supports | contradicts | context` — a `contradicts` row
  refutes its claim, it does not corroborate it.** Live counts: 572 `supports`, 104
  `context`, 7 `contradicts`. A consumer that reads evidence count or tier without checking
  `relation` will read refuting evidence as supporting. Live worked example in §4: a
  founder's own claim that a GitHub repo "contains the core fraud-detection engine that
  powers the product" is directly `contradicts`-linked to evidence quoting the same repo's
  README as `"core engine -- coming soon"`.

- **Opted-out founders and merge tombstones are excluded by the views themselves.**
  `founders.opt_out_at IS NOT NULL` or `merged_into_founder_id IS NOT NULL` removes a
  founder from `api_founders`, removes their claims from `api_claims` (via the founder_id
  they're attached to), and removes them from `api_applications`'s founder-linkage
  resolution. Both counts are 0 today, so this has not yet visibly filtered anything —
  querying the base tables directly bypasses the filter entirely.

**Corrected 2026-07-19 — an earlier revision of this document was wrong here.** It stated
that `application_id` was NULL on all 124 founders and `company_id` filled on only 5, and
explained this as a corpus-connectivity gap. That was a real measurement, but the cause was
a defect in the view, not a gap in the data: it resolved company and application through
`founder_company`, which holds 5 rows, all feature 03/05 test fixtures. Feature 02 produced
the entire 124-founder corpus and never writes that table — it records company and
application together on the founder's own card. The view now reads `cards`, preferring
`founder_company.is_current` when a row exists, and the columns are filled on **123** and
**118** of 124 founders respectively.

---

## 4. Worked examples

All pulled live, 2026-07-19.

**1. A scored founder with their gaps:**

```bash
curl "http://localhost:8000/rest/v1/api_founders?founder_id=eq.03f00001-0000-0000-0000-000000000001&select=founder_id,full_name,founder_score,founder_score_trend,founder_score_confidence,founder_score_missing,score_assessed,founder_score_gaps" \
  -H "apikey: $VCBRAIN_TOKEN"
```
```json
[{
  "founder_id": "03f00001-0000-0000-0000-000000000001",
  "full_name": "Devon Ashworth",
  "founder_score": 29.16,
  "founder_score_trend": null,
  "founder_score_confidence": 0.53,
  "founder_score_missing": ["L5", "X1", "X5", "X6"],
  "score_assessed": true,
  "founder_score_gaps": [
    {"criterion_id": "X1", "what_would_close_it": "A claim describing prior work history in fraud detection or banking."},
    {"criterion_id": "X5", "what_would_close_it": "A claim describing a named competitor's specific technical or operational weakness."},
    {"criterion_id": "X6", "what_would_close_it": "A claim evidencing sustained pre-funding work on fraud detection, e.g. an early open-source prototype or public writing predating incorporation."},
    {"criterion_id": "L5", "what_would_close_it": "A homepage or Show HN post to apply the stranger test against."}
  ]
}]
```
(Devon Ashworth / Fintrace AI is a labelled synthetic fixture — `headline` reads *"Founder
& CEO, Fintrace AI (synthetic fixture — not a real person)"* — used here deliberately as a
public-repo-safe example.)

**2. An application with all three axes:**

```bash
curl "http://localhost:8000/rest/v1/api_applications?application_id=eq.08f360ee-165d-4524-93d0-ec4c54d3f050&select=application_id,company_name,stage,score_founder,score_market,score_idea_vs_market" \
  -H "apikey: $VCBRAIN_TOKEN"
```
```json
[{
  "application_id": "08f360ee-165d-4524-93d0-ec4c54d3f050",
  "company_name": "Medows",
  "stage": "pre_seed",
  "score_founder": {"trend": null, "value": null, "missing": [], "assessed": false, "confidence": null},
  "score_market": {"trend": "stable", "value": 50.0, "missing": ["gap_growth","gap_size_bottom_up","gap_size_top_down","gap_why_now","no_thesis_geography","search_failed","thin_category_signal"], "assessed": true, "confidence": 0.0},
  "score_idea_vs_market": {"trend": null, "value": 50.0, "missing": ["founder_competition_view_absent","gap_founder_view_absent","gap_no_competitors_found","gap_no_funding_data","gap_no_status_quo_identified","gap_switching_cost_unsupported","gap_threat_level_unsupported"], "assessed": true, "confidence": 0.28}
}]
```
Note the trap this illustrates directly: `score_market.value` and `score_idea_vs_market.value`
both read `50.0` — a naive consumer sorting or filtering on `value` alone would treat this
as a middling company. `confidence` (`0.0` and `0.28`) and the 7-entry `missing` arrays say
the real story: neither axis found enough to say anything, and `score_founder` was never
even assessed.

**3. The evidence ledger for one founder — including a claim its own evidence contradicts:**

```bash
curl "http://localhost:8000/rest/v1/api_claims?founder_id=eq.03f00001-0000-0000-0000-000000000001&order=created_at.desc&limit=5&select=claim_id,topic,text_verbatim,verification_status,evidence" \
  -H "apikey: $VCBRAIN_TOKEN"
```
```json
[
  {
    "claim_id": "03f00006-0000-0000-0000-000000000102",
    "topic": "founder.execution.tech",
    "text_verbatim": "Our GitHub repository fintrace-ai/fintrace-shield contains the core fraud-detection engine that powers the product.",
    "verification_status": "unverified",
    "evidence": [{
      "tier": "documented", "relation": "contradicts", "strength": 0.75,
      "source_url": "https://github.com/fintrace-ai/fintrace-shield",
      "quote_verbatim": "Fintrace Shield core engine -- coming soon."
    }]
  },
  {
    "claim_id": "03f00006-0000-0000-0000-000000000104",
    "topic": "founder.execution.provenance",
    "text_verbatim": "The fintrace-ai/fintrace-shield GitHub repository has been under active development by our team since well before Fintrace AI was founded, demonstrating early conviction in the fraud-detection approach.",
    "verification_status": "unverified",
    "evidence": [{
      "tier": "documented", "relation": "contradicts", "strength": 0.85,
      "source_url": "https://github.com/fintrace-ai/fintrace-shield",
      "quote_verbatim": "first commit predates author account creation"
    }]
  }
]
```
This is the case §3's `relation` warning exists for: both claims describe the founder's
GitHub repo favourably, and both are refuted, not corroborated, by their own evidence
(`relation: "contradicts"`) — a repo README that says "coming soon" against a claim of a
production engine, and a first-commit timestamp that predates the author's account against
a claim of pre-founding conviction. A consumer that only counts evidence rows or reads
`tier` (`documented`, the highest tier) would score this founder's technical claims as
strongly backed. They are the opposite.

**4. The `missing` claims — deliberate absence, not empty rows:**

```bash
curl "http://localhost:8000/rest/v1/api_claims?verification_status=eq.missing&select=claim_id,topic,text_verbatim,verification_status&limit=3" \
  -H "apikey: $VCBRAIN_TOKEN"
```
```json
[
  {"claim_id": "07f00004-0000-0000-0000-000000000202", "topic": "company.business_model", "text_verbatim": "Business model: not disclosed.", "verification_status": "missing"},
  {"claim_id": "07f00004-0000-0000-0000-000000000203", "topic": "company.geography_country", "text_verbatim": "Headquarters location: not disclosed.", "verification_status": "missing"},
  {"claim_id": "07f00004-0000-0000-0000-000000000204", "topic": "company.stage_evidence", "text_verbatim": "Product stage: not disclosed.", "verification_status": "missing"}
]
```
36 rows like this exist live. None of them are a broken extraction — each is the system
having looked for a specific piece of information and recording that it was not there.

---

## 5. `POST /webhook/f10-nl-search`

**Under construction — built by a parallel agent.** This endpoint resolves a compound
natural-language query (e.g. *"technical founder, Berlin, AI infra, enterprise traction, no
prior VC backing, top-tier accelerator"*) into a ranked, evidence-backed list of founders in
one pass. Contract, ranking rules, and response shape: `docs/backlog/10-api-cli-skill/design.md`
§5.6. This document will be updated with verified live examples once that endpoint exists.
