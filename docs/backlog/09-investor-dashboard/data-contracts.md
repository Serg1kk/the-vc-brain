# Data contracts — the investor dashboard's read surfaces

> **Frozen 2026-07-19.** Everything the dashboard reads, with exact column names, types, value
> vocabularies and query examples. Companion to [`lovable-brief.md`](lovable-brief.md) (the build
> instruction) and [`scoring-ux.md`](scoring-ux.md) (why each number is rendered the way it is).
>
> **Base URL** `http://localhost:8000/rest/v1/` · **Auth** `apikey: $ANON_KEY` (also accepts
> `Authorization: Bearer $ANON_KEY`) · **Hard row cap** 1000 per request.
> All five views were verified returning HTTP 200 through the gateway — these are live over REST,
> not merely valid SQL.

---

## The three rules that override everything else

Each is stated independently by three or more features, in different files, by different authors.
A QA gate tests all three.

**1. Never render an axis value alone.** Confidence and the missing-data list travel with it.
`50` means both "middling market" and "we never researched it". `100` on a founder score can mean
one met criterion at 0.05 confidence. **Sort within confidence bands, never by value alone.**

**2. Absent ≠ zero.** No score row means *not assessed*. Rendering it as 0 *converts our honesty
about ignorance into a penalty against the founder* — the exact inversion of the invariant this
product exists to defend. **Every axis needs a distinct not-assessed visual state.**

**3. Never blend the axes.** There is deliberately no overall-score column anywhere in the schema
and none is to be added. Smoke tests actively raise on an axis named `overall`, `total` or
`combined`.

---

## 1. `api_founders` — one row per founder · 122 rows

| Column | Type | Null | Notes |
|---|---|---|---|
| `founder_id` | uuid | no | PK |
| `full_name` | text | no | **not unique** |
| `headline` | text | yes | **3 of 122 filled** |
| `is_synthetic` | boolean | no | must be badged; never rank unlabelled beside real people |
| `founder_score` | numeric(5,2) | yes | 0–100. **NULL ≠ 0** |
| `founder_score_trend` | text | yes | `improving` \| `stable` \| `declining` \| **NULL** |
| `founder_score_confidence` | numeric(3,2) | yes | 0–1 |
| `founder_score_missing` | text[] | no | `{}` when none |
| `score_assessed` | boolean | no | `false` = no score row exists |
| `scored_at` | timestamptz | yes | |
| `obscurity` | numeric(4dp) | yes | 0–1; 1 = maximally undiscovered |
| `obscurity_basis` | text[] | yes | `{gh_followers,hn_karma}`, one element, or NULL |
| `channel` | text | yes | source slug of the **earliest** signal |
| `first_seen_at` | timestamptz | yes | **use this, not `radar_candidates.freshness`** |
| `company_id` / `company_name` | uuid / text | yes | via current employment only |
| `application_id` | uuid | yes | most recent application of the current company |
| `founder_score_gaps` | jsonb | yes | **raw** `[{criterion_id, what_would_close_it}]` |

**Default order is baked into the view:** `founder_score DESC NULLS LAST, full_name, founder_id`.

⚠️ **Never default-sort by `obscurity`.** Inbound founders have NULL radar fields; an obscurity
sort floats them up as "maximally undiscovered" — the exact inversion the metric warns against.
Obscurity sort only behind an explicit control, always NULLS LAST.

Rows already filtered inside the view: opted-out and merged founders are excluded.

```
GET /api_founders?select=*&limit=25
GET /api_founders?score_assessed=eq.true&order=founder_score.desc.nullslast
GET /api_founders?obscurity=not.is.null&order=obscurity.desc.nullslast&limit=20
GET /api_founders?channel=eq.hn_algolia
```

---

## 2. `api_applications` — one row per application · 308 rows

| Column | Type | Null | Vocabulary |
|---|---|---|---|
| `application_id` / `company_id` | uuid | no | |
| `company_name` | text | yes | |
| `company_domain` | text | yes | 86 of 198 |
| `stage` | text | no | `pre_seed` \| `seed` |
| `category` | text | yes | **7 of 198 filled** |
| `kind` | text | no | `inbound` \| `radar_activated` |
| `status` | text | no | `sourced` \| `screening` \| `diligence` \| `decision` \| `invest` \| `pass` |
| `submitted_at` | timestamptz | no | alias of created-at; there is no real submitted-at column |
| `artifact_links` | jsonb | no | |
| `score_founder` / `score_market` / `score_idea_vs_market` | jsonb | no | shape below |
| `thesis_id` / `thesis_name` | uuid / text | yes | |
| `thesis_verdict` | text | yes | `passed` \| `failed` \| `borderline` \| `insufficient_evidence` |
| `thesis_fit` | numeric(5,2) | yes | 0–100; **NULL when not assessed** |
| `thesis_coverage` | numeric(3,2) | yes | NULL in keyword mode |
| `thesis_missing_fields` | text[] | no | populated on **every** evaluation row |
| `thesis_fired_rules` | jsonb | no | element shape in §6 |
| `memo_version` | int | yes | |
| `memo_available` | boolean | no | **false on all 308 rows today** |

**Axis object shape** — identical for all three:

```jsonc
{ "value": 72.50 | null,
  "trend": "improving" | "stable" | "declining" | null,
  "confidence": 0.61 | null,
  "missing": ["gap_growth", "gap_why_now"],
  "assessed": true | false }     // false ⇒ value is null, NOT zero
```

**There is deliberately no `overall_score` column and none is to be added.**

```
GET /api_applications?status=eq.screening&order=submitted_at.desc
GET /api_applications?thesis_verdict=eq.passed&order=thesis_fit.desc.nullslast
GET /api_applications?thesis_verdict=eq.borderline          # lane 2, "Outside thesis"
GET /api_applications?kind=eq.radar_activated
GET /api_applications?score_market->>assessed=eq.true
```

---

## 3. `api_claims` — the traceability surface · 724 rows

**The only surface carrying `source_url`.**

| Column | Type | Null | Notes |
|---|---|---|---|
| `claim_id` / `card_id` | uuid | no | |
| `founder_id` | uuid | **yes** | NULL for company-scoped claims — retained, not dropped |
| `company_id` / `application_id` | uuid | yes | |
| `topic` | text | no | dotted slug, e.g. `founder.execution.provenance` |
| `axis` | text | yes | often NULL |
| `text_verbatim` | text | no | ⚠️ on `derived` claims this is an **assertion, not a quotation** — never render in quote marks |
| `value` | jsonb | yes | |
| `source_kind` | text | no | `self_reported` \| `public` \| `interview` \| `voice` \| `derived` |
| `base_confidence` | numeric(3,2) | yes | |
| `verification_status` | text | no | **stored and stale — do not render** |
| `created_at` | timestamptz | no | order fallback |
| `evidence` | jsonb | no | array, `[]` never NULL |

**Evidence element:**

```jsonc
{ "tier": "documented" | "discovered" | "inferred" | "missing",
  "relation": "supports" | "contradicts" | "context",
  "strength": 0.90,
  "quote_verbatim": "…",     // 377 of 672 filled
  "source_url": "https://…", // 633 of 672 filled
  "raw_signal_id": "uuid",
  "captured_at": "2026-07-15T11:05:00Z" }
```

Corpus: `founder.*` 615 · `company.*` 48 · `market.*` 48 · `competition.*` 13.
Relations: supports 565 · context 104 · **contradicts 3**.

```
GET /api_claims?founder_id=eq.<uuid>&order=created_at.desc
GET /api_claims?verification_status=eq.missing            # the honest-gap claims
GET /api_claims?claim_id=in.(<uuid>,<uuid>)               # resolve memo/search citations
```

---

## 4. `claim_trust` — per-claim trust, computed live · 724 rows

| Column | Type | Null | Notes |
|---|---|---|---|
| `claim_id` | uuid | no | join key to `api_claims` |
| `card_id` | uuid | no | **the only subject column** |
| `topic` / `axis` / `text_verbatim` / `source_kind` | | | |
| `verification_status` | text | no | stored — **do not render** |
| `router_class` | text | no | `factual_static` \| `factual_dynamic` \| `qualitative` \| `forecast` \| `unverifiable` \| `precomputed` |
| `n_supports` / `n_contradicts` | bigint | no | |
| `n_contradicts_counting` | bigint | no | documented+discovered only — the count that moves the number |
| `n_independent` | bigint | no | distinct (source, host), supports-only, **excluding deck and interview** |
| `base` | numeric(4dp) | **yes** | NULL when no supports row exists |
| `independence_factor` | numeric(4dp) | no | 0.50–1.00 |
| `contradiction_penalty` | numeric(4dp) | no | 0–0.80 |
| `trust` | numeric(4dp) | no | **0–1**, never NULL |
| `derived_status` | text | no | **authoritative — render THIS** |

```
independence_factor = n_independent = 0 ? 0.50 : min(1.00, 0.70 + 0.15 × (n_independent − 1))
contradiction_penalty = min(0.80, 0.30 × n_contradicts_counting)
trust = clamp(coalesce(base,0) × independence_factor − contradiction_penalty, 0, 1)
```

**The verdict CASE, evaluated top-down — the order is load-bearing:**

1. status is `missing` → **`missing`**
2. class ∈ {qualitative, forecast, unverifiable} → **`unverified`** (pinned forever)
3. counting-contradictions > 0 **and** supports > 0 → **`partially_supported`**
4. class = precomputed **and** contradictions > 0 → **`partially_supported`** (cap)
5. documented contradictions > 0 → **`contradicted`**
6. discovered contradictions > 0 → **`partially_supported`**
7. documented/discovered supports > 0 **and** ≥1 independent → **`verified`**
8. else → **`unverified`**

Testing "already missing" *first* is what makes the honest-gap invariant hold structurally: a
declared gap can never be reclassified as an accusation, whatever a later verifier finds.

⚠️ **This view has no `founder_id`, `company_id`, `application_id` and no `source_url`.** Build the
ledger with two reads:

```
GET /api_claims?founder_id=eq.<uuid>&select=claim_id,topic,text_verbatim,evidence
GET /claim_trust?claim_id=in.(<ids>)&select=claim_id,trust,derived_status,router_class,n_independent,n_contradicts
```

⚠️ **Live divergence:** `claims.verification_status='verified'` is **0 database-wide**, while
`claim_trust.derived_status='verified'` is **135**. The stored column is stale; the view is live.

---

## 5. `radar_candidates` — the radar feed source

`founder_id` · `company_id` · `application_id` · `gh_followers` · `gh_notable_followers` ·
`hn_karma` (**can be negative** — one real founder has −2) · `hn_points` · `hn_comments` ·
`obscurity` (0–1) · `freshness` (**interval**) · `channel` · `obscurity_basis`

```
followers_term = 1 − clamp(log(1 + max(gh_followers,0))/3, 0, 1)   # 1000+ followers → 0
karma_term     = 1 − clamp(log(1 + max(hn_karma,0))/4,     0, 1)   # 10000+ karma   → 0
obscurity      = mean(OBSERVED terms only); NULL iff no term observed
```

**NULL, never 0, when a metric was never observed** — substituting 0 computes obscurity ≈ 1.0 and
floats exactly the founders with the least data to the top.

⚠️ `freshness` serialises as `"41 days 03:12:55"`. **Use `api_founders.first_seen_at` in any UI.**

⚠️ Channel values are raw source slugs, not the pair named in older docs:
`github_api` · `hn_algolia` · `tavily_extract` · `tavily_search` · `tavily_news` · `deck_parse` ·
`interview_answer` · `manual`.

---

## 6. `thesis_evaluations` — append-only

`id` · `application_id` · `thesis_id` · `thesis_version` · `input_fingerprint` ·
`evaluation_mode` (`full` \| `keyword`) · **`verdict` (NOT NULL, 4 values)** ·
`score_id` (**NULL = not assessed this run**) · `fired_rules` jsonb · `extracted_snapshot` ·
`thesis_config_snapshot` · `missing_fields` text[] · `coverage` (NULL in keyword mode) ·
`extraction_ai_run_id` · `formula_version` · `created_at`

Unique on `(application_id, thesis_id, input_fingerprint)`. Updates and deletes raise an error.

**`fired_rules[]` element:**

```jsonc
{ "id": "R1", "label": "Excluded sector: gambling",
  "kind": "deal_breaker" | "must_have" | "focus",
  "enforcement": "hard" | "soft",
  "outcome": "satisfied" | "missed" | "triggered" | "unknown",
  "field": "sector", "expected": ["gambling","adtech"], "observed": "gambling",
  "weight_applied": 0 }
```

`outcome: "unknown"` = the rule could not be evaluated. **Show it honestly, never as a pass or a
miss.** Stable compiled rule ids: `M_sector`, `M_geography`, `M_stage`, `M_poskw`, `M_negkw`.

**Verdict procedure, first match wins:**

```
1. any hard rule triggered/missed       → failed
2. coverage < fit.min_coverage (full)   → insufficient_evidence
2b. any soft deal_breaker triggered     → borderline
3. fit >= fit.strong_threshold (full)   → passed
4. otherwise                            → borderline
```

**Keyword mode never returns `passed`.** `failed` is rare by construction — only one hard rule ships.

### ⚠️ The stale-thesis trap — reproduced twice in QA

An application scored 100 (`passed`), was re-run, degraded to `insufficient_evidence`. No new score
row was written (correct), the gate went NULL (correct), and **a direct `scores` query still
returned 100.00** for an application the system can no longer assess.

**Correct resolution:** latest `thesis_evaluations` row per `(application_id, thesis_id)` → if
verdict is `insufficient_evidence` **or** `score_id IS NULL` → render *not assessed*, never fall
back to an older number → otherwise follow that row's `score_id`. `api_applications` already
implements this; use it rather than re-deriving.

---

## 7. `theses` — the config form's target

`id` · `name` · `config` jsonb · `version` · `active` (**defaults true**) · `is_default` ·
timestamps.

```
schema_version
mandate.{ stages[], geographies[], sectors[], risk_appetite,
          check_size_usd:{min,max}, ownership_target_pct }
geos[]                        // ISO 3166-1 alpha-2 country codes
positive_keywords[], negative_keywords[]
rules[]: { id, label, kind, enforcement, hard_justification?, weight, enabled,
           expr: { field, op, value, negate? } }
fit.{ base, mandate_weight, soft_deal_breaker_penalty, strong_threshold, min_coverage }
exceptional_lane.{ axis, aggregate, min_value }
```

Vocabularies: `kind ∈ deal_breaker | must_have | focus` · `enforcement ∈ hard | soft` ·
`hard_justification ∈ mandate_fatal | fraud` (**required** when enforcement is hard) ·
`expr.op ∈ eq | in | gte | lte | contains | exists`.

**Legal combinations only:** `deal_breaker × {hard, soft}` · `must_have × {hard, soft}` ·
`focus × {soft}`. The form must not offer `focus × hard`.

Gateable fields: `sector`, `business_model`, `geography_country`, `geography_region` (derived),
`stage` (derived), `stage_evidence`, `_text`. **`what_is_built` is not gateable.**

**`check_size_usd` and `ownership_target_pct` are stored but inert** — label them
*Recorded, not yet applied to scoring*.

### ⚠️ Publish protocol — mandatory

INSERT with **`active = false` explicitly** (the column defaults to `true`, so omitting it is a
deterministic unique-constraint violation), **then** call `POST /rpc/activate_thesis_version`.
Never raw-INSERT an active row; never flip `active` or `is_default` by hand — the RPC moves them
together in one transaction.

Seeded default: base 50, min_coverage 0.5, mandate_weight 20, strong_threshold 70,
soft_deal_breaker_penalty 30; geos DE/FR/NL/US; R1 hard deal-breaker on gambling and adtech;
R2 soft B2B focus at weight 25; exceptional lane on founder score, max aggregate, min value 75.

---

## 8. `events` — the "why not assessed" audit trail

`id` · `event_type` · `entity_type` (`founder` \| `company` \| `application`) · `entity_id` ·
`payload` jsonb · `actor` · `created_at`

**Emitted today — five types only:** `founder_score_insufficient_evidence` ·
`thesis_gate_insufficient_evidence` · `trust_rollup_insufficient_evidence` ·
`crawl_skipped_robots` · `radar_scan_completed`

**Specified but NOT emitted:** `claim_verification_attempted` (mandatory per design, zero rows) ·
`claim_contradicted` (fixture only).

**`claim_contradicted` payload — the richest UI object in the system:**

```jsonc
{ "claim_id","class","check","verdict_before","verdict_after","source_url","checked_at","run_id",
  "nature":   "factual" | "definitional" | "methodological" | "temporal" | "scope",
  "severity": "minor" | "moderate" | "material",     // DETERMINISTIC, not model-judged
  "founder_claim": "Tomasz has spent over 8 years working in retail-analytics…",
  "found_reality": "director appointments on file: Brightline Logistics Ltd…",
  "question": "Can you walk us through your work history in retail…prior to 2021?",
  "entity_match": { "resolved_by": "raw_signal_fk" | "domain" | "llm_quote",
                    "quote": "…", "disambiguator": "Tomasz Wieckowski" } }
```

⚠️ Contradictions on *company* claims are still written with `entity_type='founder'`, with an
`entity_type='application'` fallback. **Query both shapes** or company-scoped contradictions vanish.

**Copy rule:** neutral framing, never editorialise on intent. Provenance findings must read
*"consistent with a rewritten or imported history"* — never an accusation.

---

## 9. `score_components` — the founder-score drill-down

The table that makes the founder score auditable per criterion.

`id` · `score_id` (**NULL on the insufficient-evidence branch** — the breakdown is kept even when no
score row was written) · `founder_id` · `run_id` · `subscorer` · `criterion_id` ·
`verdict` (`met` \| `self_asserted` \| `not_met` \| `cannot_assess`) · `weight` numeric(6,5) ·
`credit` · `contribution` (percentage points) · `evidence_tier` · `claim_ids` uuid[] ·
`quote_verbatim` (**substring-verified; NULL if verification failed**) ·
`rationale` (**LLM interpretation, kept deliberately separate from the quote**) ·
`what_would_close_it` · **`demoted_by`** (red-flag id, if the verdict was demoted) · `created_at`

**A NULL `quote_verbatim` beside a non-NULL `rationale` is the visible signature of the backend
rejecting the model's quote. Surface it — that is a feature, not a blank.**

```
GET /score_components?founder_id=eq.<uuid>&order=run_id.desc,subscorer.asc
GET /score_components?verdict=eq.cannot_assess&founder_id=eq.<uuid>
GET /score_components?demoted_by=not.is.null
```

---

## 10. NL-search — `POST http://localhost:5678/webhook/f10-nl-search`

Request: `{"query": "<natural language>", "limit": 10}`

```jsonc
{ "query": "technical founder, Berlin, AI infra, no prior VC backing",
  "plan": {
    "attributes": [ /* echoed, with the weights the executor applied */ ],
    "unresolvable": [ { "label": "no prior VC backing", "reason": "no_data_source" } ] },
  "items": [
    { "founder_id": "…", "full_name": "…", "is_synthetic": false,
      "company_id": "…", "company_name": "…", "application_id": "…",
      "rank_score": 72,             // 0-100; null when nothing was assessed
      "confidence": 0.61,
      "confidence_bucket": "high",  // "high" | "mid" | "low" | null
      "coverage": 0.75,             // COUNT-based, not weight-based
      "evidence_quality": 0.85,     // sibling of rank_score, NEVER folded in
      "founder_score": 64, "founder_score_assessed": true,
      "attributes": [
        { "id": "technical_founder", "state": "matched", "weight": 25, "tier_credit": 1.0,
          "evidence": { "claim_id": "…", "quote_verbatim": "…",
                        "source_url": "…", "tier": "documented" } },
        { "id": "geo_berlin", "state": "matched_broadened", "weight": 20,
          "tier_credit": 0.7, "broadening": "city→country",
          "resolved_as": "company.geography_country = DE",
          "evidence": { … } },
        { "id": "sector_ai_infra", "state": "unknown", "weight": 20,
          "note": "no data — lowers confidence, not rank" } ] } ],
  "low_confidence": [ /* same shape, confidence < 0.25, NEVER interleaved */ ],
  "total": 14, "truncated": false, "low_confidence_only": false, "note": "…" }
```

### The five-state matching vocabulary — and why it matters to this dashboard

| State | Meaning | Effect on rank | Effect on confidence |
|---|---|---|---|
| `matched` | evidence satisfies the attribute as asked | + weight × tier credit | raises assessed |
| `matched_broadened` | satisfied only after widening (city→country) | + weight × credit × 0.75 | raises assessed |
| `mismatch` | evidence contradicts the attribute | 0 | raises assessed |
| `unknown` | **we never looked / nothing recorded** | **0 — genuinely free** | lowers confidence only |
| `unknown_searched` | **we looked and found nothing** | **0, identical to unknown** | lowers confidence only |

**This is the one place in the product where "searched and found nothing" is already fully
implemented and queryable.** It is display-only and deliberately stays out of the denominator —
counting a recorded absence would re-break the missing-data invariant.

**Ranking maths, all deterministic:**

```
assessed         = Σ weight where state ∈ {matched, matched_broadened, mismatch}
credit(a)        = tier_credit × (broadened ? 0.75 : 1.0)
rank_score       = Σ (weight × credit) over matched states ÷ assessed × 100
confidence       = assessed ÷ Σ weight(all attributes)
evidence_quality = mean(tier_credit) over matched states
coverage         = count(assessed) / count(resolvable)
bucket           = coverage >= 0.75 ? high : coverage >= 0.5 ? mid : low
```

Frozen constants, never model-supplied: weights `{provenance: 25, structural: 20}` · tier credit
`{documented: 1.0, discovered: 0.7, inferred: 0.4}` (**`missing` deliberately absent**) ·
broadening credit 0.75 · confidence floor 0.25 · candidate cap 200.

**List order:** `bucket_ordinal DESC, rank_score DESC NULLS LAST, founder_id ASC` where
`{high:3, mid:2, low:1}`.

⚠️ **Sort the ordinal integer, never the bucket string.** Alphabetically `'high' < 'low' < 'mid'`,
so a naive descending string sort yields mid → low → high — silently inverted.

⚠️ `truncated` refers to the 200-candidate cap **only**. `total > limit` is normal and is **not**
truncation.

**Error envelope:** `{"error": {"kind", "message", "hint", "retryable"}}` with kinds
`empty_query`(false) · `resolver_failed`(true) · `invalid_target`(false) ·
`unresolvable_query`(false) · `upstream_timeout`(true) · `limit_exceeded`(false).

---

## 11. Registries — seeded vocabularies

**`score_axes`** — 6 rows: `founder`✓ · `market`✓ · `idea_vs_market`✓ · `trust` · `founder_score` ·
`thesis_fit` (✓ = screening axis).

**`signal_sources`** — `github_api`/documented · `hn_algolia`/documented · `tavily_extract`/discovered
· `tavily_search`/discovered · `tavily_news`/discovered · `deck_parse`/documented ·
`interview_answer`/discovered · `manual`/documented.

**`card_types`** — company · founder · team.

**`metric_kinds`** — `gh_stars` · `gh_commit_weeks` · `gh_merged_prs` · `gh_followers` ·
`gh_notable_followers` · `gh_forks` · `gh_dependents` · `hn_points` · `hn_karma` · `hn_comments` ·
`hn_author_replies` · `site_updated`.

---

## 12. `missing_flags` has a different JSON type per axis

| Axis | Type | Shape | Rows |
|---|---|---|---|
| `founder_score` | **array** | `[{criterion_id, what_would_close_it}]` — **objects, not strings** | 14 |
| `market`, `idea_vs_market` | **object** | `{"gap_growth":true,"search_failed":["Q5"]}` | 6 / 8 |
| `thesis_fit` | **object** | `{missing_fields:[…], _f07_input_fingerprint:"…"}` | 11 |
| `trust` | **object** | `{topics:[], not_assessable_count:int, coverage:0-1\|null}` | 0 |

**The `api_*` views normalise all of this to a plain string array. Read the views.**

⚠️ Any key prefixed `_` is writer-internal and must never render — *a consumer that enumerates
these keys and renders every one as a gap would show an investor a hash as a missing data point.*

---

## 13. What is NOT available — check this before designing any screen

| The 09 README assumes | Reality |
|---|---|
| 4 axis mini-bars (Founder / Market / Idea-vs-Market / Trust) | **2 of 4 are empty.** The founder axis has 0 rows (cascade from 3-of-122 founder-score coverage); the trust axis has 0 rows (no inserter exists yet). Only market and idea-vs-market have data, both thin |
| Trend arrows on feed rows and card hero | The radar deliberately does **not** compute velocity — *"a derivative over n=1 is noise dressed as insight"*. The trust rollup has no trend formula. Founder-score trend was **null on every QA run** |
| Memo view | **Feature 06 is README-only.** The memos table exists and is empty; `memo_available` is false on all 308 rows |
| Interview tab with transcript and voice players | Tables exist, no writer has landed |
| Watchlist sidebar | Table exists, **no writer anywhere** |
| Manager notes on the card | **No table exists at all** — absent, not empty |
| Evidence ledger: claim → source → confidence → status | Buildable, but requires the two-read join in §4 |
| Source badge + freshness | Available, but NULL for all inbound founders, and freshness is an interval |
| Evidence-on-click for every number | Works for claims and founder-score criteria; the trust click-through events have no writer yet |

**Zero rows / no writer:** trust rollup · all three truth-gap workflows · founder axis ·
`claims.verification_status='verified'` · memos · `claim_verification_attempted` events ·
the flagship competitor-mismatch claim (**never fired live — the demo must not depend on it**) ·
GitHub provenance (returns *insufficient data* on every real claim; the beat rests on a fixture) ·
quote guard (**no call site — nothing may claim this check runs, not the memo, not the video**) ·
Storage bucket for the investor side.

**Data-coverage limits that constrain the UI:** founder city and country **0 of 122**; headline
3 of 122; company country **0 of 198**, category 7 of 198, one-liner 8 of 198. The founder and
company full-text indexes are generated from empty columns and are effectively **name-only**. There
is **no funding-related claim topic** — any "no prior VC backing" filter resolves as unresolvable by
design, since a bare NOT-EXISTS would award all 122 founders a fabricated match.

### ✅ Memo recommendation vocabulary — RESOLVED 2026-07-19 ~12:20 (operator ruling)

This section previously documented a conflict between the shipped constraint and feature 06's
README. **The conflict is closed: the constraint was migrated to match the README.** Build the memo
banner against these four values and no others:

```sql
memos.recommendation IN ('proceed', 'proceed-with-conditions', 'pass', 'watchlist')
```

The old three-value list `('invest','pass','watch')` **no longer exists** and the database will now
reject every one of `invest` and `watch`. Anything still rendering the old vocabulary is stale.

Migration was idempotent (the same `pg_constraint`-guard pattern used elsewhere in `db/schema.sql`),
the inline `CREATE TABLE` definition was updated too so a fresh clone is correct without replaying
it, and `memos` held 0 rows so no data needed migrating. Verified by watching the new constraint
**reject** `'invest'` and accept `'proceed-with-conditions'` inside a rolled-back transaction —
not merely by reading it back. One consequence was fixed in the same pass: `db/tests/smoke.sql`'s
Task-8 fixture hardcoded `'watch'` and was correctly rejected; it now uses `'watchlist'`.

⚠️ Unrelated and deliberately NOT changed: `applications.status` also contains `'invest'` and
`'pass'` (`db/schema.sql:204`). Different table, different column, different meaning — an
application's lifecycle stage, not a memo's recommendation. Features 02 and 08 write it. Leave it
alone.
