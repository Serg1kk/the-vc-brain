# Feature 10 — API, CLI & Claude Skill · Design

> Status: **rev.4**, after spec review round 3 · 2026-07-19 ~09:35
>
> **rev.4 changelog** — round 3 caught one defect that inverts the product's own logic:
> **F4 `tier_credit` took `max(tier)` across ALL evidence rows regardless of `relation`, so a
> `documented` row with `relation='contradicts'` RAISED the match score** — refuting evidence
> increasing a founder's rank. Live DB already holds 3 `contradicts` and 104 `context` rows, and 05
> is writing more right now. Credit now counts `supports` only; `contradicts` forces `mismatch`
> (§5.5) · **F1 the "global rule" was an inner join in disguise** — it would have dropped every
> company-scoped claim (`cards.founder_id IS NULL`) from the traceability view and every
> founderless application; now an anti-join with per-view subject resolution (§4) ·
> **F2 `matched_broadened` sat in the denominator but not the numerator**, scoring identically to a
> mismatch; numerator fixed and `BROADENING_CREDIT = 0.75` added so widening costs something real
> (§5.5) · F3 `low_confidence_only` banner — Q2's confidence lands at 0.294 or 0.238 depending on
> one resolver classification, and 0.238 would have emptied `items[]` on the flagship honesty demo
> (§5.5) · F5 `evidence_quality` split out of `rank_score` (collapsing two signals into one number
> is what invariant #1 forbids) · F6 `unknown_searched` — "we looked and found nothing" no longer
> collapses into "we never looked" (§5.5) · F7 `negative` dropped as a `kind`; `polarity` is the
> sole negation marker (§5.3) · **`velocity` and `text` kinds CUT from this build** · S1–S6 applied,
> incl. `founder.*` claims corrected to **615**, not 724 (724 is all claims).
>
> Status: rev.3, after spec review round 2 · 2026-07-19 ~09:40
> Scope option **A** (operator, ~08:40): NL-search deep, CLI and skill thin-but-real.
> Owner terminal: 10. Depends on: 01 (schema, live), 03/04/07 (score contracts, landed).
> No frontend surface → root hard rule #10 (`lovable-brief.md`) does not apply; considered, N/A.
>
> **rev.3 changelog** — two of these were fatal:
> **B1 the global view filter was INVERTED** (`opt_out_at IS NOT NULL`) — all three views would have
> returned zero rows and, given any opt-out, served only the people who asked to be excluded (§4) ·
> **B2 `rank_score` divided by total weight, making `unknown` penalise exactly as much as
> `mismatch`** — REQ-003 inverted in the section §8.1 cites as enforcing it; denominator is now
> `assessed`, plus a confidence floor and a `low_confidence[]` bucket (§5.5) ·
> B3 topic coverage measured — `founder.expertise.*` covers nearly everyone, so bare `exists`
> cannot rank; credit is now graded by **evidence tier** (§4.0, §5.5) · M1 `DISTINCT` on a
> radar_candidates subselect, dropping an unwritable tiebreak (§4.1) · M2 `first_seen_at`
> re-derived, it was not projected (§4.1) · M3 04's `missing_flags` key shape measured and the
> normalisation rule written (§4.2) · M4 negative rule generalised from global-zero to
> per-candidate (§5.4) · M5 scope broadening declared, new `matched_broadened` state (§5.3, §5.5) ·
> S1–S5 applied · build order parallelised (§10).
>
> **rev.2 changelog** — every item is a review round-1 finding or a live-database measurement:
> B1 corpus reality measured, demo reframed (§4.0, §5.7) · B2 executor path corrected to
> PostgREST-fetch + in-memory scoring (§5.1, §5.4) · B3 `submit` **cut**, feature is now
> read-only (§1, §6) · B4 weights moved from the LLM to a fixed table (§5.3, §5.4) ·
> M1 `missing_flags` shape documented **per axis**, measured (§4.2) · M2 thesis missing-fields
> read from `thesis_evaluations` (§4.2) · M3/M4 dedup + tombstone guards (§4) · M5 token
> write-scope disclosed honestly (§3) · M6 candidate gathering specified (§5.4) · M7 exclusion
> deleted (§5.5) · M8 error envelope defined (§5.8) · S1 `api_search_index` cut · S2–S6 applied.

---

## 1. What this feature is, and what it honestly is not

The machine-facing half of the product: a stable **read contract** (PostgREST views), a
**multi-attribute natural-language search** resolved in one pass, a thin **CLI** (`vcbrain`), and a
**Claude skill** documenting the surface so a fund's own agents plug in a token and work.

**Framing that must not be lost (from the intel base):** the project's intel base contains **no
sponsor requirement for an API, CLI, MCP or agent access at all**. Feature 10 is an
operator-driven differentiator. The one part the rubric *does* score is **Multi-Attribute
Reasoning** — brief §"MVP should demonstrate" item 3 and FAQ-12:

> Резолвить compound-запрос «technical founder, Berlin, AI infra, enterprise traction, no prior
> VC backing, top-tier accelerator» **в один проход**, а не 5 ручных фильтров.

Effort is therefore deliberately unbalanced: §5 carries the feature; §4, §6 and §7 are the
smallest honest implementations that make §5 reachable and demonstrable.

Secondary rubric hook: FAQ-13 names **Agentic Traceability** the single highest-leverage stretch
goal. `api_claims` (§4.3) and the per-attribute evidence in every search hit (§5.6) are that
traceability, in machine-readable form.

### 1.1 Feature 10 is read-only (rev.2 decision, review B3)

`vcbrain submit` is **cut**. Three independent reasons, any one sufficient:

1. `companies.stage` is `NOT NULL` with **no default** (verified live) — the insert fails with
   23502 on every call. The command as specified never worked.
2. `deck_storage_path` is a Supabase Storage path, and deck upload is explicitly 08's. Writing a
   pointer to a file nothing can read satisfies the `applications_deck_required_for_inbound` CHECK
   with an assertion the system cannot back — exactly what REQ-004 forbids, and exactly what §6.4
   gets right for `memo`.
3. 08 has offered `POST /webhook/f08-intake-submit` as the single write path. Cutting `submit`
   makes that coordination moot rather than provisional.

Consequence, and it is an improvement: **feature 10 writes nothing.** The token it documents needs
no write scope, the two-owners problem with 08 disappears, and "a read surface for agents" is a
cleaner story than a half-write one.

### 1.2 Non-goals

MCP server · rate limiting · per-fund API keys · **any write path** · deck upload/parsing ·
founder-facing intake UI · card pre-fill · interview endpoints · outreach endpoints
(SCOPE-002/003) · `purge_founder()` exposure in any form (GDPR deletion surface belongs to
feature 11 — confirmed with the 08 terminal).

---

## 2. Sources consulted (phase 0)

| Source | What it changed |
|---|---|
| Intel base (`internal/Meetings/*`) | No API mandate exists → §1 framing. REQ-002/003/004/009/010 → §8. SCOPE-002/003 → no outreach endpoints. |
| `internal/challenge-brief.md` | FAQ-12 verbatim (one-pass compound query) → §5. FAQ-13 (Agentic Traceability) → §4.3, §5.6. |
| NotebookLM (project notebook, 2 asks) | Negatives must not go through FTS; boolean AND returns zero; weighted matrix + three-state attributes; Precision@K over recall; "enterprise traction" ≠ revenue at pre-seed → §5.3–§5.6. Consumer failure modes (claim drift, certainty inflation, source laundering, one-sided label noise) → §5.6, §7. |
| Exa: IETF `draft-gaikwad-agent-friendly-http-api-profile`, clispec.dev | §5.7 error envelope, §6 CLI contract (schema command, envelope, structured errors, no silent truncation). |
| OSS: sieve-mcp (MIT) | Evidence-tier vocabulary, single-header auth, `sections`-style field control. |
| OSS: venture-capital-intelligence (MIT) | SKILL.md frontmatter shape. |
| Handoffs 02/03/04/07 | §8.2 inherited gotchas. |
| **Live database, measured 2026-07-19 ~08:55 and ~09:10** | §4.0 — the single largest influence on rev.2. |
| **Spec review round 1** | The rev.2 changelog above. |

---

## 3. Surface architecture

```
agent / CLI
   │
   ├── READ  →  http://localhost:8000/rest/v1/api_*      (PostgREST, apikey header)
   │
   └── SEARCH → http://localhost:5678/webhook/f10-nl-search   (n8n, this feature)

   (f03-score-founder and f07-thesis-gate exist and are documented in the skill
    for agents that want to trigger work; the CLI does not wrap them — §6.3.)
```

### 3.1 Why curated views

The project has **no RLS anywhere** (cross-cutting ruling, TRACKER.md:175) and Supabase's
schema-wide default privileges give `anon` SELECT/INSERT/UPDATE on every table in `public`.
Enforcement consists only of the 8 `forbid_mutation` triggers, per-table `REVOKE TRUNCATE`, and
CHECK constraints.

Fixing RLS at T-6h is a cross-cutting change touching every other terminal's assumptions. What we
do instead is refuse to *publish* the raw surface as the contract:

1. The documented contract is `api_*` views only. Internal columns (`content_hash`,
   `input_fingerprint`, `prompt_version`, any `_`-prefixed `missing_flags` key) never appear.
2. Invariants a consumer could violate by reading the wrong column are resolved inside the view
   (§4), **so the documented path cannot get them wrong.** The base tables remain fully readable:
   **the views are a documentation and convenience convention, not an enforcement boundary.** They
   are owned by `postgres` and run with definer rights; they add no privilege restriction whatever.
   (rev.2 — review M5. The earlier phrasing "so they cannot be forgotten" was itself the
   certainty-inflation failure §5.6 exists to counter.)

### 3.2 Auth, stated honestly

Single service token in `VCBRAIN_TOKEN`, sent as PostgREST's `apikey` header.

**This token has full read AND WRITE access to every table in the database, including `theses`
(the fund's mandate) and `claims` (the evidence ledger). It is a demo credential, not production
auth.** That sentence appears verbatim in the skill and in `api.md`. No per-fund keys, no scopes,
no rotation, no rate limiting.

Feature 10 itself performs no writes (§1.1); the write capability is a property of the deployment,
not of this feature — and under a rubric whose top line is honesty about what the system knows, an
undisclosed weak posture costs more than a disclosed one.

---

## 4. Read views (`api_*`)

**Three** views (rev.2: `api_search_index` cut — review S1). All are `CREATE OR REPLACE VIEW`,
additive, appended to `db/schema.sql` under a `-- Feature 10:` marker per the shared-file
convention.

**Global rule for all views — two clauses, both cheap insurance:**

Expressed as an **anti-join, never an inner join to `founders`** (rev.4 — review round 3 F1):

```sql
AND NOT EXISTS (
  SELECT 1 FROM founders f
  WHERE f.id = <this row's founder_id>
    AND (f.opt_out_at IS NOT NULL OR f.merged_into_founder_id IS NOT NULL)
)
```

An inner join would work for `api_founders` and silently gut the other two. `cards` carries
`founder_id` / `company_id` / `application_id` as three independent nullable columns
(`db/schema.sql:980`: *"a card can carry more than one at once"*), so every **company-scoped**
claim — 04's `market.*` / `competition.*` and 07's `company.*` — sits on a card whose `founder_id`
is NULL and would be dropped, gutting the application half of the view §4.3 calls the Agentic
Traceability deliverable. Applications reach founders only through `companies → founder_company`
and would lose every application whose company has no linked founder.

**Subject resolution, per view:**

| view | subject | rule |
|---|---|---|
| `api_founders` | the founder | excluded when opted out or a merge tombstone |
| `api_claims` | the card's `founder_id` **when non-NULL** | a card with no founder is **retained** — it is company-scoped evidence, not a person's |
| `api_applications` | current founders of the company via `founder_company.is_current` | excluded only when **every** current founder is opted out; **retained when there are none** |

§9 asserts the positive case for all three, not just `api_founders` — including *"a company-scoped
claim with `cards.founder_id IS NULL` is present"*, for exactly the reason B1 taught.

> ⚠️ rev.2 shipped this clause as `opt_out_at IS NOT NULL`, which serves **only** the founders who
> asked to be excluded and nobody else — with zero opt-outs today, all three views returned zero
> rows and the whole feature was dead. Caught in spec review round 2. The two identical
> `-- excluded` comments on opposite polarities are how it slipped through; they are now explicit.
> §9 asserts the **positive** case too (`opt_out_at IS NULL` founders are present) — a test that
> only asserts absence passes trivially against a view returning nothing.

Opt-out is a softer state than `purge_founder()` erasure but must not be served through the public
surface. `merged_into_founder_id` marks a **duplicate-canonicalisation tombstone**: without this
clause a merged duplicate appears as a separate person alongside its canonical record — in a
product whose 30% rubric line begins "smart ingestion, **dedup**, enrichment". Both counts are 0
today; neither is constrained by the schema, and 08 is about to start creating founder rows.

### 4.0 Corpus reality (measured on the live database)

Measured before designing the views, because it changes what the search can honestly claim:

| Field | Filled |
|---|---|
| `founders.location_city` / `location_country` / `headline` | **0 / 0 / 3** of 122 |
| `companies.hq_country` | **0 / 198** · `category` 7 · `one_liner` 8 · `domain` 86 |
| `company.geography_country` claims | **8 rows** (DE 2, NL 3, US 2, 1 gap) |
| `company.sector` claims | **9 rows** |
| any funding-related claim topic | **does not exist** |
| founders with a `founder_score` | **3 / 122** |
| `scores(axis='founder')` | **0 rows** — 04 owns this axis and never wrote it |
| `claims.verification_status='verified'` | **0** (690 unverified, 34 missing; 05 not built) |
| `evidence.source_url` / `quote_verbatim` | 633 / 377 of 672 |
| `evidence.relation` | supports 565 · context 104 · **contradicts 3** — the F4 filter is not hypothetical |
| **`founder.*` claims** | **615** (of 724 total: company 48, market 48, competition 13), with **≥5 on 92 of 122 founders** |

Root cause of the empty structural columns, confirmed in code: `lib/f02/write.js:308` inserts
founders with `full_name` only, and `:426`/`:445` insert companies with `{name, domain, stage}`
only. Nothing populates location, headline, category or one-liner. The 07 fallback does not rescue
it either — 02 calls the thesis gate in `mode:'keyword'`, which makes no LLM call and writes no
claims, so `company.sector`/`geography_country` exist only for the handful of applications that
went through `mode:'full'`.

**Topic coverage — volume is not discrimination** (rev.3, measured; review round 2 B3 caught that
rev.2 had verified only volume). Share of the 122 founders holding at least one claim per topic:

| topic | founders | % | usable with bare `exists`? |
|---|---|---|---|
| `founder.leadership.written_communication` | 118 | **96.7%** | **no** — matches nearly everyone |
| `founder.expertise.unasked_work` | 95 | 77.9% | weak |
| `founder.execution.live_product` | 71 | 58.2% | yes |
| `founder.expertise.vertical_tenure` | 71 | 58.2% | yes |
| `founder.expertise.insight_specificity` | 65 | 53.3% | yes |
| `founder.execution.provenance` | 34 | 27.9% | yes |
| `founder.execution.external_usage` | 33 | 27.0% | yes |
| `founder.execution.commit_consistency` | 25 | 20.5% | yes |
| `founder.execution.merged_pr_foreign` | 24 | 19.7% | yes |

The glob `founder.expertise.*` is the union of three topics covering 78/58/53% — it matches almost
every founder, so the reference query's "technical founder" attribute **cannot rank anything** with
a bare `exists`. Fix (§5.5): credit is graded by **evidence tier**, which is already recorded and
already surfaced. Tier distribution on `founder.*` claims: `discovered` 263 · `documented` 229 ·
`missing` 103 · `inferred` 24 — enough spread to rank even a 96.7%-coverage topic.

Consequences, all binding on §5:

1. **The searchable substance is the `founder.*` claim corpus.** Structural attributes resolve for
   under a dozen companies. `founders.search_tsv` and `companies.search_tsv` are generated from
   columns that are empty, so **they are effectively name-only indexes**; only `claims.search_tsv`
   carries real text.
2. **The brief's reference query degrades to mostly `unknown`.** Correct behaviour, not a bug — but
   the demo therefore shows **two** queries (operator decision, ~09:05), see §5.7.
3. **`verification_status` cannot be a ranking signal** — nothing is verified.
4. `api_applications.score_founder` reports `assessed: false` for every row. Cross-feature gap
   (04's axis), recorded in the tracker, not papered over here.

### 4.1 `api_founders`

One row per founder. `cards` has no unique constraint on `(founder_id, card_type)` and
`radar_candidates` selects `FROM cards`, so a founder with two founder cards would otherwise appear
twice in search results (review M3).

**The join source is `SELECT DISTINCT founder_id, obscurity, obscurity_basis, channel FROM
radar_candidates`** — no `DISTINCT ON`, no tiebreak (rev.3). Since §4.1 takes
`company_id`/`application_id` from `founder_company` only, every column still taken from
`radar_candidates` is a pure function of `founder_id` (the metrics, obscurity and channel are all
computed from founder-scoped `metric_observations` / `raw_signals`), so duplicate card rows carry
*identical* values and a plain `DISTINCT` collapses them provably. rev.2 specified
`ORDER BY founder_id, cards.created_at, cards.id`, which cannot be written — `radar_candidates`
projects neither `cards.created_at` nor `cards.id`, and reaching into `cards` separately would
re-introduce the fan-out.

Columns: `founder_id · full_name · headline · is_synthetic · founder_score ·
founder_score_trend · founder_score_confidence · founder_score_missing · score_assessed ·
scored_at · obscurity · obscurity_basis · channel · first_seen_at · company_id · company_name ·
application_id`.

Semantics, each load-bearing:

- `founder_score` resolves as `max(computed_at)` for `(founder_id, axis='founder_score')`,
  **with `id` as secondary sort** — duplicates written inside one execution can tie on
  `computed_at` and `DISTINCT ON` would otherwise pick arbitrarily (review S3).
- **A founder with no score row is normal, not an error.** 03 writes no row when coverage <
  `min_coverage` (0.25), emitting `founder_score_insufficient_evidence` instead. The view sets
  `score_assessed = false` and `founder_score = NULL` — **never 0** (03 gotcha 1; REQ-003). This is
  the common case: 3 of 122 founders are scored.
- `founder_score_missing` surfaces `missing_flags` normalised to a string array; **`founder_score_gaps`
  carries the raw objects beside it**, preserving `what_would_close_it`. See §4.2 — the per-axis
  shapes differ and rev.3's "array of strings" claim for this axis was wrong (measured: array of
  objects).
- `obscurity` / `obscurity_basis` / `channel` come from `radar_candidates`, **LEFT JOINed**, and the
  **default ordering never uses `obscurity`**: `founder_score DESC NULLS LAST, full_name ASC,
  founder_id ASC` — `full_name` is not unique, so `founder_id` supplies the unique final key
  (review round 2 S4).
  08's inbound founders will have founder cards but no HN anchor, so their radar fields are NULL;
  an inner join would delete them and an obscurity sort would float them to the top as "maximally
  undiscovered" — the exact inversion 02 warns about. Obscurity sorting is available only behind an
  explicit flag, always `NULLS LAST`. (Raised by the 08 terminal, ~09:10.)
- `first_seen_at timestamptz` replaces `radar_candidates.freshness`, which is a Postgres interval
  and serialises as `"41 days 03:12:55"` — awkward for an agent (review S2). **It is re-derived,
  not selected**: `radar_candidates` projects only the computed interval, never the underlying
  `observed_at`, so there is nothing to take (review round 2 M2). The view carries its own
  four-line CTE mirroring `earliest_signal`:
  `SELECT DISTINCT ON (founder_id) founder_id, observed_at FROM raw_signals
   WHERE founder_id IS NOT NULL ORDER BY founder_id, observed_at`.
  Rejected alternative: amending `radar_candidates` to project `observed_at` — that is a
  shared-file edit to 02's object, and §10 lists shared-file collision as a named risk.
- `company_id` / `application_id` come from **`founder_company.is_current` only**, never from
  `radar_candidates` — one source, no unreconciled second (review M3). LEFT JOINed: a founder with
  no company is normal for radar-sourced people.
- `is_synthetic` is exposed so that when 11 seeds synthetic founders they are never ranked
  un-labelled beside real people (review S4).

### 4.2 `api_applications`

One row per application.

Columns: `application_id · company_id · company_name · company_domain · stage · category ·
kind · status · submitted_at · artifact_links · score_founder{…} · score_market{…} ·
score_idea_vs_market{…} · thesis_id · thesis_name · thesis_verdict · thesis_fit ·
thesis_coverage · thesis_missing_fields · thesis_fired_rules · memo_version · memo_available`.

Each `score_*` object is `{value, trend, confidence, missing, assessed}`.

Semantics:

- **The three screening axes are three separate objects, never blended** (REQ-002, invariant #1).
  There is deliberately **no `overall_score` column** and none is to be added.
- An **absent axis row means "not assessed", never zero** (04 contract 2) — `assessed: false`.
- **Never threshold on `value` alone**: 04 warns that "unmeasured" and "middling" both land near 50.
  `confidence` and `missing` travel with every axis so a consumer cannot read the value in isolation.
- **`missing` has a different JSON shape per axis. Measured live, 2026-07-19 ~09:20:**

  | axis | `jsonb_typeof(missing_flags)` | rows |
  |---|---|---|
  | `founder_score` | **array** | 14 |
  | `market` | **object** | 6 |
  | `idea_vs_market` | **object** | 8 |
  | `thesis_fit` | **object** | 11 |

  03's handoff says "array", 07's says object-with-`missing_fields`, and both are right for their
  own axis. rev.1 of this design carried 03's rule as universal — it is wrong for three axes of
  four.

  **Normalisation rule, from the measured shapes** (rev.3 — review round 2 M3; 04's shape was
  undocumented in its handoff and had to be read off the live rows):

  | axis | actual shape | rule |
  |---|---|---|
  | `founder_score` | **array of OBJECTS** `[{"criterion_id": "X1", "what_would_close_it": "A claim describing prior work history in …"}, …]` — **not** strings, as rev.3 wrongly claimed | take `criterion_id` for the uniform string array, **and pass the raw array through in `founder_score_gaps jsonb`** — `what_would_close_it` is the most investor-useful field in the structure and reducing it to an id throws it away |
  | `market`, `idea_vs_market` | `{"gap_growth": true, "gap_why_now": true, "search_failed": ["Q5"], …}` — an object of gap flags, values usually `true` but **sometimes an array** | **collect the KEY names of all truthy entries** |
  | `thesis_fit` | `{"missing_fields": [...], "_f07_input_fingerprint": "…"}` | moot for the views — `thesis_missing_fields` now comes from `thesis_evaluations.missing_fields` (below), so nothing reads this |

  In every case `_`-prefixed keys are writer-internal and dropped. The view emits a **plain array of
  strings** so consumers never branch; the skill documents the underlying per-axis shapes for anyone
  reading base tables directly.
- **`thesis_*` resolves through `thesis_evaluations`, NOT through `scores`** — 07's QA reproduced a
  stale `100.00` via a direct `scores` read. Latest evaluation per `(application_id, thesis_id)`;
  on `verdict='insufficient_evidence'` or `score_id IS NULL`, `thesis_verdict` is still reported and
  `thesis_fit` is NULL. Several theses can be active at once, so `thesis_id` is part of the identity.
- **`thesis_missing_fields` reads `thesis_evaluations.missing_fields` directly** — a native
  `text[]`, populated on every row regardless of verdict (review M2). The rev.1 route via
  `scores.missing_flags->'missing_fields'` was NULL exactly in the `insufficient_evidence` case,
  where "what didn't we know?" is the entire answer.
- `memo_available` is `false` for every row today (06 not built, `memos` empty). A truthful column,
  not a placeholder — see §6.4.

### 4.3 `api_claims` — the evidence ledger, machine-readable

One row per claim with its evidence folded into an array. **This view is the Agentic Traceability
deliverable.**

Columns: `claim_id · card_id · founder_id · company_id · application_id · topic · axis ·
text_verbatim · value · source_kind · base_confidence · verification_status · created_at ·
evidence[] = {tier, relation, strength, quote_verbatim, source_url, raw_signal_id, captured_at}`.

Semantics:

- `verification_status='missing'` claims are **deliberate data with human-readable
  `text_verbatim`**, not empty rows (04 contract 4). Served, not filtered — the investor seeing
  "we looked and did not find X" *is* the product.
- `quote_verbatim` is legitimately sparse (377 of 672) — nullable and documented, not faked.
- `supersedes_claim_id` is NULL database-wide; "latest claim per topic" falls back to
  `ORDER BY created_at DESC, id` (04 known gap + review S3). `created_at` is exposed for this.
- Evidence tiers use `documented | discovered | inferred | missing`. Note `db/seed.sql` seeds only
  `documented` and `discovered` in `signal_sources.base_tier`; `evidence.tier` uses all four
  (review S6).

---

## 5. NL-search — the core

`POST http://localhost:5678/webhook/f10-nl-search` → `{ "query": "<nl>", "limit": 10 }`

### 5.1 Principle: the model classifies, the backend decides and ranks

The LLM **never writes SQL, never sees the database, and never assigns a weight.** It emits a
structured *query plan*; a deterministic JS module (`lib/f10/`) turns that plan into a set of
PostgREST reads and scores the results in memory.

**Execution path (rev.2 — review B2).** The repo has **no `package.json` and no Postgres driver**;
every feature reaches the database over PostgREST HTTP, and n8n Code nodes cannot `require()` from
this repo. "Compiles to parameterised SQL" was therefore unimplementable. The real path:

1. `lib/f10/plan.js` — validates the plan and maps each attribute to a **PostgREST query
   descriptor** (path + filters).
2. The n8n workflow issues those reads (HTTP Request nodes) against `api_*` and `claims`.
3. `lib/f10/score.js` — pure function: `(plan, fetchedRows) → ranked items`. **In-memory scoring
   over 122 founders is trivially fast** and keeps the module zero-dependency and testable against
   fixtures with no LLM and no network, exactly as §9 requires.

This is the same shape 07 already uses (`evaluateThesis` is a pure function over compiled rules)
and the "model proposes, backend decides" pattern from the stack decision.

### 5.2 Subject of a result (operator decision)

**A founder, with their current company/application joined in.** The brief's reference query mixes
person attributes with company attributes; a founder-subject row reaches both, `founder_score` is
person-scoped, and 92 of 122 founders carry ≥5 claims. Application-subject would invert the join
for half the attributes and 308 applications hold only 39 score rows.

### 5.3 Stage 1 — the resolver (LLM)

Model `gpt-5.6-luna` (extraction tier), structured output. **Do not send `temperature: 0`** — luna
returns HTTP 400 for it; omit the parameter entirely (tooling changelog ~05:10). Prompt, input spec
and output schema are authored via the mandatory `ai-agent-builder` skill and live in
`docs/backlog/10-api-cli-skill/agents/nl-search-resolver/`.

The resolver receives the **live corpus catalogue** (claim topics with row counts, structural-field
fill counts, closed vocabularies from `lib/f07/vocabulary.js`, metric kinds) so that "there is no
data source for this" is a decision it can make explicitly rather than a silent mismatch.

Output — the **query plan**. Note what is *absent*:

```jsonc
{
  "attributes": [
    { "id": "technical_founder", "label": "technical founder",
      "kind": "provenance", "polarity": "positive",
      "target": { "type": "claim_topic", "value": "founder.expertise.*" },
      "op": "exists" },
    { "id": "geo_berlin", "label": "Berlin",
      "kind": "structural", "polarity": "positive",
      "target": { "type": "claim_topic", "value": "company.geography_country" },
      "op": "eq", "value": "DE" }
  ],
  "unresolvable": [
    { "label": "no prior VC backing", "reason": "no_data_source" }
  ]
}
```

**There is no `weight` field and no `hard` field.** (rev.2 — review B4, M7.)

Attribute `kind` taxonomy:

**Two kinds in this build** (rev.4 — the `velocity` and `text` cut taken now, not held in reserve;
review round 3). Each dropped kind is a distinct retrieval mode with its own HTTP node in the n8n
workflow, its own descriptor shape in `plan.js` and its own branch in `score.js`; **neither appears
in Q1**, and `velocity` drags in a `metric_observations` join no acceptance query exercises. Two
kinds still resolve a compound query in one pass, which is the entire rubric claim.

| kind | means | resolves against | weight |
|---|---|---|---|
| `provenance` | who the person is, where they have been | `claims.topic` under `founder.expertise.*`, `founder.execution.*`, `founder.leadership.*` | 25 |
| `structural` | geography, sector, stage | `company.sector` / `company.geography_country` claims + `companies.stage`; **not** `hq_country`/`location_*`, which are empty (§4.0) | 20 |
| ~~`velocity`~~ | traction, momentum | **cut from this build** — post-MVP; at pre-seed it maps to proxies, never revenue | — |
| ~~`text`~~ | free-text fallback | **cut from this build** — post-MVP | — |

**`negative` is NOT a kind** (rev.4 — review round 3 F7). rev.3 listed it both as a `kind` (weight
15) and as a `polarity`, so "no prior VC backing" was expressible two well-formed ways that ranked
differently, with nothing saying which was canonical — the resolver prompt and the executor could
each guess differently. **`polarity` is the sole negation marker**, and a negative is weighted by
its subject kind. A matched negative takes `tier_credit = 1.0`: there is no claim to read a tier
from, and the evidence-presence test in §5.4 rule 3 *is* its assessment.

**`unresolvable[]` is a first-class output** with a machine-readable `reason`. An attribute the
resolver cannot map is reported, not silently dropped — silent dropping is how a search quietly
answers a different question than the one asked.

**Scope broadening must be declared** (rev.3 — review round 2 M5). There is no city-level data
anywhere in the corpus, so "Berlin" can only resolve to `company.geography_country = DE`. As rev.2
specified it, a Munich founder came back `matched` against an attribute labelled **"Berlin"**, with
evidence attached — which is exactly the claim drift (scope broadening between systems) that §5.6
says the echoed plan exists to counter, and the echoed plan does not counter it, because the plan
shows `DE` while the item shows "Berlin" and the caller has to spot the discrepancy themselves.

The resolver therefore emits the widening explicitly:

```jsonc
{ "id": "geo_berlin", "label": "Berlin",
  "target": { "type": "claim_topic", "value": "company.geography_country" },
  "op": "eq", "value": "DE",
  "broadening": "city→country" }
```

and any attribute carrying `broadening` renders its match as **`matched_broadened`**, a state
distinct from `matched`. In Q2 this turns a quiet inaccuracy into a visible piece of the honesty
story the demo is already telling.

### 5.4 Stage 2 — the executor (deterministic, `lib/f10/`)

Zero-dependency CommonJS, `node --test lib/f10/*.test.js` (glob form — the directory form fails on
Node v22.19.0).

**Weights come from a fixed table in `lib/f10/`, keyed by `kind`** (rev.2 — review B4):

```js
const WEIGHTS          = { provenance: 25, structural: 20 };  // negative is a polarity, not a kind
const TIER_CREDIT      = { documented: 1.0, discovered: 0.7, inferred: 0.4 };  // missing → unknown_searched
const BROADENING_CREDIT = 0.75;
const CONFIDENCE_FLOOR  = 0.25;
```

**Deliberate deviation, stated so QA does not flag it as an inconsistency** (review round 3 S5):
03 keeps every scoring constant in `score_formulas.config` so a judge can audit the arithmetic
against one database row. Feature 10 hardcodes these in `lib/f10/` instead, because 10 owns no
table and adding one at this clock is a shared-file change for four constants. They are documented
in the skill and echoed in the response, so they remain inspectable — just not queryable.

normalised by the sum of the weights of the attributes actually in the plan. A non-zero-temperature
model emitting weights would mean the same query ranks differently on each run — a judge running
the demo query twice would see two orders and discount everything else on the Trust axis. Fixed
weights make the ranking reproducible and auditable, and cost nothing.

Rules the executor enforces, each derived from a specific finding:

1. **No boolean AND across attributes.** A six-attribute conjunction returns zero rows. Candidates
   are gathered by union, then every attribute is scored against every candidate.
2. **Negatives never touch FTS.** A full-text query for "no VC backing" retrieves documents
   *containing* "VC backing" — the exact inversion of intent. `polarity: "negative"` compiles only
   to `NOT EXISTS` / `IS NULL`.
3. **A negative is never satisfied by absence alone.** Two levels, cheap check first (rev.3 —
   review round 2 M4 generalised the rev.2 rule, whose global-zero trigger was one row too narrow):
   - **Global short-circuit:** if the target's topic family has **zero rows database-wide**, the
     whole attribute is promoted to `unresolvable` with `reason: "no_data_source"`. Concretely: no
     funding topic exists (§4.0), so "no prior VC backing" would be **trivially true for all 122
     founders** and award every one a fabricated match.
   - **Per-candidate rule (the general form):** a negative resolves to `matched` **only for
     candidates that have some evidence in the target's topic family**. A candidate with no
     evidence in that family at all resolves to **`unknown`**. Without this, `company.geography_country`
     — 8 rows across 198 companies — passes the global check and then hands a satisfied `NOT
     EXISTS` to the 190 companies that were simply never extracted: the identical fabrication, one
     row above the threshold.

   This makes the negative rule a special case of the three-state rule rather than a separate
   mechanism, and removes the arbitrary threshold. It is the defence against "absence of evidence
   as evidence of absence" — the one-sided-label-noise trap that makes cold-start founders look
   like failures because they are merely unrecorded.
4. **Candidate gathering, stated literally** (rev.2 — review M6):
   - candidate set = **union of `founder_id`s returned by each POSITIVE attribute's query**,
     each fetch ordered `ORDER BY founder_id` **before** the 200-row cap, so *which* 200 is
     deterministic (rev.3 — review round 2 S1; an unordered cap contradicts rule 6 and §9's
     "identical plan → identical order across runs");
   - **negative attributes never generate candidates** — they are scorers only. A negative that is
     true of nearly everyone would otherwise make the candidate set the entire database;
   - every attribute, positive and negative, is then evaluated against every candidate;
   - `total` = size of the scored candidate set, and the skill defines it as exactly that.
   - **Zero resolvable positive attributes** → fall back to all founders ordered by `founder_score
     DESC NULLS LAST`, every attribute `unknown`, `confidence: 0`, and a `note` explaining why.
     The endpoint never returns an unexplained empty list.
5. **Bounded output.** `limit` defaults to 10, hard-capped by `PGRST_DB_MAX_ROWS=1000`. `total` and
   `truncated` always returned. Silent truncation is forbidden.
   **`truncated` refers to the 200-candidate cap only** — it means "more founders would have
   qualified as candidates than we scored". `total > limit` is normal, expected, and expressed by
   `total`; it is **not** truncation (rev.3 — review round 2 S2, the two were conflated).
6. **Stable ordering:** `has_match DESC, bucket_ordinal DESC, rank_score DESC NULLS LAST,
   founder_id ASC`, where `has_match = rank_score > 0`.

   **`has_match` leads the sort** (rev.6 — found by running Q2 live, after the bucket order was
   already approved). Bucket-first ordering optimises for *how much we assessed* over *whether it
   matches*, and at the extreme that inverts: live Q2 returned, at position **1**, a founder with
   `rank_score = 0` — two demonstrable `mismatch`es and one `unknown` — ranked above nine founders
   with `rank_score = 100`, purely because his coverage was 0.67 (`mid`) against their 0.33
   (`low`). "We know this person well and they do not fit" is not the best answer to a search query.

   Checked against the case that motivated bucketing in the first place: a 1-of-4 documented match
   (rank 100, `low`) and a 4-of-4 match (rank 92.5, `high`) both have `has_match = true`, so the new
   term does not separate them and the bucket still decides — 92.5 correctly stays above 100. No
   regression.

   ```js
   coverage       = |{a : state ∈ assessed}| / |{a : resolvable}|   // COUNT, not weight
   bucket         = coverage >= 0.75 ? 'high' : coverage >= 0.5 ? 'mid' : 'low'
   BUCKET_ORDINAL = { high: 3, mid: 2, low: 1 }                     // sort the INTEGER
   ```

   **Sort the ordinal, never the string** (rev.5 — review round 4 F8). Alphabetically
   `'high' < 'low' < 'mid'`, so a `DESC` string sort yields **mid → low → high**: the exact
   inversion of intent, silently, on a list that still looks plausible. In JS this is the single
   likeliest defect in the whole change.

   **`coverage` counts attributes, it does not normalise weight** (review round 4 Q2). Weight-based
   bucketing sits exactly on the achievable lattice — for a 4-attribute equal-weight query
   `confidence` can only be {0.25, 0.5, 0.75, 1.0} and every edge lands on an attainable value —
   and it diverges from its own meaning the moment weights differ by kind, which they do: with
   three `provenance` (25) and one `structural` (20), *three* assessed criteria bucket as `high`
   (75/95 = 0.789) or `mid` (70/95 = 0.737) depending on **which** three. The bucket is meant to say
   "how much of your query we could assess"; only a count says that. `confidence` stays exactly as
   it is — published on every item and still the floor.

   `founder_id` is the unique final key, so the order is total.

   **When `low_confidence_only` fires**, every candidate is below the floor and has no bucket:
   `confidence_bucket` is `null` and ordering falls back to `rank_score DESC NULLS LAST,
   founder_id ASC` (review round 4 F9 — otherwise the primary key is null on every row and the
   order depends on sort stability).

   **Rejected alternative, recorded because it is the obvious-looking one:** *absolute matched
   weight* (`Σ weight × tier_credit` where matched, unnormalised). It needs no thresholds, no
   buckets and no lattice, and it happens to order the live corpus correctly. **It is wrong because
   it violates REQ-003:** unnormalised, a founder we simply have not researched can never rank
   highly — missing data would lower the score directly, which is the inversion this product exists
   to prevent. It would rank by how much we happen to know, i.e. by crawl luck.

   **Why not `rank_score` first** (rev.5 — found by simulating Q1 against the live corpus, not by
   review): `rank_score` is the match rate *among what we could assess*, so a founder assessed on
   one attribute that matched with `documented` evidence scores **100**, while the single founder
   who satisfies all four of Q1's attributes scores **92.5** (his evidence averages 0.93, not 1.0).
   Sorting by rank first therefore puts the people we know least about at the head of the list —
   and the confidence floor does not catch them, because 1 assessed attribute of 4 gives
   `confidence` exactly 0.25, which is not `< 0.25`.

   Bucketing is a **lexicographic sort, not arithmetic fusion** — the two numbers are never
   combined into one, which invariant #1 forbids. It reads as: *show the founders we could actually
   assess first, ranked by fit within that.* Measured Q1 distribution that motivated it: 1 founder
   matches 4 attributes, 10 match 3, 90 match 2, 17 match 1.

### 5.5 Stage 3 — three-state matching and ranking

Per candidate, per attribute:

| state | meaning | effect on rank | effect on confidence |
|---|---|---|---|
| `matched` | evidence satisfies the attribute as asked | `+ weight × tier_credit` | raises `assessed` |
| `matched_broadened` | satisfied only after the attribute was widened to fit the data (§5.3) | `+ weight × tier_credit` | raises `assessed` |
| `mismatch` | evidence contradicts the attribute | `0` | raises `assessed` |
| `unknown` | we never looked / nothing recorded | **`0` — genuinely free** | **lowers confidence only** |
| `unknown_searched` | **we looked and found nothing** — a `missing`-tier evidence row or a `verification_status='missing'` claim | **`0`, identical to `unknown`** | **lowers confidence only** |

**`unknown_searched` is display-only and deliberately stays out of `assessed`** (rev.4 — review
round 3 F6). §4.3 argues that `missing` claims are deliberate data — *"the investor seeing 'we
looked and did not find X' is the product"* — and rev.3 collapsed them into a plain `unknown`,
discarding the distinction at the surface of the feature whose secondary rubric hook is Agentic
Traceability. It carries its own `note`. Counting it toward `assessed` would put a recorded absence
into the denominator and re-break REQ-003, so the arithmetic is unchanged: one extra string, one of
the cheapest honesty wins in the feature.

```
assessed        = Σ weight(a) where state ∈ {matched, matched_broadened, mismatch}
credit(a)       = tier_credit(a) × (a.broadening ? BROADENING_CREDIT : 1.0)   # 0.75
rank_score      = Σ (weight(a) × credit(a)) where state ∈ {matched, matched_broadened}
                  ÷ assessed × 100
confidence      = assessed ÷ Σ weight(all a)
evidence_quality = mean(tier_credit(a)) over state ∈ {matched, matched_broadened}
```

**The numerator includes `matched_broadened`** (rev.4 — review round 3 F2). rev.3 enumerated three
states in `assessed` and then wrote only "where matched" in the numerator, which a builder reads
literally: a broadened match would have contributed full weight to the denominator and zero to the
numerator, i.e. scored exactly as a `mismatch`, contradicting the state table above it.

**`BROADENING_CREDIT = 0.75`** — a widened match costs something in the ranking, not only in the
label. Without it the Munich founder still ranks as a full Berlin match and M5's state distinction
is a cosmetic exercise.

**`evidence_quality` is a sibling of `rank_score`, not folded into it** (review round 3 F5).
Credit-weighting the numerator fuses two independent quantities — *how much of what we assessed
matched* and *how good the evidence was* — into one figure, in a product whose invariant #1 is that
independent signals are never collapsed because collapsing hides the disagreement the investor
needs. Both numbers already exist per-attribute, so this is an aggregation, not new data, and the
pair is read together exactly as `value` + `confidence` is for the axes.

**The denominator of `rank_score` is `assessed`, not the total** (rev.3 — spec review round 2 B2).
rev.2 divided by the total weight, which made an `unknown` dilute the rank by exactly as much as a
`mismatch`: a founder matched on one attribute with two `unknown` scored 25/55 = 45, and a founder
matched on one with two *demonstrable failures* also scored 45. "We have no data" and "he
demonstrably fails" ranked identically, and adding an attribute we cannot assess lowered the
founder's standing. That is REQ-003 stated backwards, in the very section §8.1 cites as enforcing
it. With `assessed` as the denominator, `unknown` is genuinely free and lands only in `confidence`.

This is the shape 07 already proved (`07/handoff.md`: "missing data lowers **coverage**, never
`fit`") and 03 before it — house style, not invention.

**`tier_credit` — graded credit by evidence tier** (rev.3 — review B3). A bare `exists` cannot rank
a topic that nearly everyone has: `founder.leadership.written_communication` covers **96.7%** of the
122 founders and `founder.expertise.*` as a glob covers almost all of them (§4.0). Credit is
therefore scaled by the best evidence tier backing the matching claim — **counting only evidence
whose `relation = 'supports'`** (rev.4 — review round 3 F4):

- tier selection filters `relation = 'supports'`;
- `relation = 'context'` never sets credit;
- **a claim whose strongest evidence is `contradicts` resolves to `mismatch`, not `matched`**;
- likewise `claims.verification_status = 'contradicted'` forces `mismatch` (review round 3 S6).

rev.3 took `max(tier)` across all evidence rows regardless of relation, which meant a `documented`
row with `relation='contradicts'` raised that claim's credit to 1.0 — **refuting evidence would
have increased the founder's rank.** Not hypothetical: 04 deliberately writes `contradicts` rows on
the `competition.founder_claim_mismatch` path, and 05 is generating more in a parallel terminal.

| tier | credit | live count on `founder.*` claims |
|---|---|---|
| `documented` | 1.0 | 229 |
| `discovered` | 0.7 | 263 |
| `inferred` | 0.4 | 24 |
| `missing` | **not a match** — resolves to `unknown` | 103 |

A `missing`-tier evidence row means "we looked and found nothing"; counting it as a match would
invent a finding out of a recorded absence. The tier already travels in the response, so the
ranking is inspectable rather than opaque.

**Confidence floor and the `low_confidence` bucket.** Dividing by `assessed` creates the known flip
side: a founder assessed on 1 of 5 attributes with a match scores 100 and outranks one assessed on
5 with 4 matches (80). Ordering by `confidence` second does not prevent it. So, following 07's
`min_coverage` precedent and 03's 0.25 threshold:

> Candidates with `confidence < 0.25` are returned in a separate **`low_confidence[]`** bucket
> **below** the ranked list — never interleaved, never dropped. Dropping them would hide exactly
> the sparse-footprint cold-start founder the product exists to find; interleaving them lets one
> lucky match outrank a thoroughly assessed founder.
>
> **If NO candidate clears the floor, `items[]` is populated anyway** and the response carries
> `"low_confidence_only": true` plus a `note` (rev.4 — review round 3 F3). The bucket exists to stop
> weak hits outranking strong ones, not to return nothing — and §5.8 states "Q2 returning no rows is
> a bug". Q2's arithmetic sits on the knife edge: with the accelerator attribute unresolvable the
> total weight is 85 and a typical founder scores 25/85 = 0.294 (survives); if the resolver instead
> types it as `structural` the total is 105 and 25/105 = 0.238 (**every founder would fall into the
> bucket and `items[]` would be empty**). The acceptance criterion for the flagship honesty demo
> must not depend on one LLM classification coin-flip. Deliberately **not** fixed by lowering the
> floor to 0.15 — that would be tuning a threshold to a single query.

`assessed = 0` (reachable via the §5.4 rule 4 zero-positive fallback, where every attribute is
`unknown` for everyone) → `rank_score: null, confidence: 0`, never a division by zero and never a
fabricated 0 or 100.

**No candidate is ever excluded by a mismatch** (rev.2 — review M7: rev.1 referred to a "hard
negative" that existed nowhere in the plan schema). A mismatch scores 0 and ranks the candidate
down. Simpler, consistent with the anti-boolean-AND stance, and it cannot silently hide a founder.

This is **REQ-003 applied to search**: missing data lowers confidence, never the founder's standing.
A founder we know four things about and cannot assess on two ranks on the four, and says so.

Every `matched` attribute carries its proof: `claim_id`, `quote_verbatim`, `source_url`,
`evidence_tier` — what makes a hit inspectable rather than a similarity number.

### 5.6 Response contract

```jsonc
{
  "query": "technical founder, Berlin, AI infra, no prior VC backing",
  "plan": {
    "attributes": [ /* echoed, with the weights the executor applied */ ],
    "unresolvable": [ { "label": "no prior VC backing", "reason": "no_data_source" } ]
  },
  "items": [
    {
      "founder_id": "…", "full_name": "…", "is_synthetic": false,
      "company_id": "…", "company_name": "…", "application_id": "…",
      "rank_score": 72, "confidence": 0.61,
      "confidence_bucket": "high", "coverage": 0.75, "evidence_quality": 0.85,
      "founder_score": 64, "founder_score_assessed": true,
      "attributes": [
        { "id": "technical_founder", "state": "matched", "weight": 25,
          "tier_credit": 1.0,
          "evidence": { "claim_id": "…", "quote_verbatim": "…",
                        "source_url": "…", "tier": "documented" } },
        { "id": "geo_berlin", "state": "matched_broadened", "weight": 20,
          "tier_credit": 0.7, "broadening": "city→country",
          "resolved_as": "company.geography_country = DE",
          "evidence": { "claim_id": "…", "source_url": "…", "tier": "discovered" } },
        { "id": "sector_ai_infra", "state": "unknown", "weight": 20,
          "note": "no data — lowers confidence, not rank" }
      ]
    }
  ],
  "low_confidence": [ /* same item shape, confidence < 0.25, never interleaved above */ ],
  "total": 14,
  "truncated": false
}
```

**`confidence_bucket` is emitted on every item, not just used internally** (review round 4 Q1).
Bucketing is defensible as a *presentation ordering* rather than fusion precisely because both
inputs survive intact and a consumer can re-sort on either — but that is only true if the sort key
is visible. A returned order that cannot be explained from the returned data is worse than fusion:
fusion is at least honest that it collapsed something. The skill states that list order is
`bucket → rank_score` and is reproducible from the response alone.

Deliberate properties, each answering a documented consumer failure mode:

- `plan` is echoed so the caller sees **how its words were interpreted** — counter to claim drift
  (scope broadening between systems).
- `confidence` is separate from `rank_score` and never folded in — counter to certainty inflation.
- Per-attribute `evidence` with a `tier`, not a citation count — counter to source laundering
  (five citations are not five independent sources).
- `unknown` is a visible third state — without it a consuming agent reads absence as failure, which
  at pre-seed is the latent-success trap: cold-start founders are *defined* by sparse footprints.
- `is_synthetic` travels with every item (review S4).

### 5.7 Error envelope (rev.2 — review M8)

The webhook reuses the CLI envelope: `{ "error": { "kind", "message", "hint", "retryable" } }`.

| `kind` | when | `retryable` |
|---|---|---|
| `empty_query` | blank/whitespace query | false |
| `resolver_failed` | model returned malformed JSON after one retry | true |
| `invalid_target` | plan references a target outside the taxonomy — executor rejects rather than guessing | false |
| `unresolvable_query` | every attribute landed in `unresolvable` | false |
| `upstream_timeout` | LLM or PostgREST timed out | true |
| `limit_exceeded` | `limit` > `PGRST_DB_MAX_ROWS` | false |

### 5.8 Evaluation

Precision@K, not recall — a high-recall sourcing tool floods the pipeline with false positives and
becomes operationally useless.

Two acceptance queries (operator decision ~09:05 — both ship, both are demoed):

- **Q1, corpus-fitted:** *"technical founder who ships to production, has external usage of their
  code, merged PRs into other people's repositories, strong written communication"* — every
  attribute maps onto the dense `founder.*` corpus. Must return a genuinely ranked list with
  per-attribute evidence over the 92 founders holding ≥5 claims. QA hand-checks Precision@10.
- **Q2, the brief verbatim:** *"technical founder, Berlin, AI infra, enterprise traction, no prior
  VC backing, top-tier accelerator"* — must return results with an honest state mix: the technical
  attribute `matched` with evidence, geography/sector `unknown` on all but a handful, "no prior VC
  backing" in `unresolvable` with `reason: no_data_source`, and visibly reduced `confidence`.
  **Q2 returning no rows is a bug; Q2 returning confident rows is a worse bug.**

---

## 6. CLI `vcbrain`

### 6.1 Language

**Node, zero dependencies.** The repo is already a Node runtime (`lib/f0*/*.js`, `node --test`, no
`package.json`); Python would add a third runtime for no gain. Closes the feature README's open
question.

### 6.2 Contract (clispec.dev-shaped, because the primary consumer is an agent)

- `{ "items": […], "total": N, "truncated": bool }` envelope on every list.
- Structured errors `{ "error": { "kind", "message", "hint", "retryable" } }`, `kind` from the
  finite documented set (§5.7 plus `missing_token`, `not_found`, `not_yet_available`).
- `--json` default when stdout is not a TTY; no ANSI when piped.
- `--limit` / `--offset`, respecting `PGRST_DB_MAX_ROWS=1000`.
- **`vcbrain schema` works with no token, no config and no network** — an agent reaches for the
  schema precisely when nothing is set up. Root `--help` mentions it.
- Never prompts. A command missing a required flag exits non-zero with a structured error **naming
  the flag**.
- Exit codes: `0` success · `1` structured error · `2` usage error.

### 6.3 Commands — four (rev.2, cut from eleven)

| Command | Backing |
|---|---|
| `schema` | static, offline |
| `search "<nl query>" [--limit]` | `f10-nl-search` |
| `founder <id>` | `api_founders` + `api_claims` |
| `application <id>` | `api_applications` + `api_claims` |

Four commands demonstrate "thin but real" as convincingly as eleven, and `search` is the only one
the rubric scores. Cut: `submit` (§1.1), `founders`/`applications`/`claims` list commands (the two
detail commands plus `search` cover the demo), `score`/`gate` (the f03/f07 webhooks are documented
in the skill for agents that want to trigger work — wrapping them buys nothing at this clock),
`watch` (the `watchlist` table is empty and no feature populates it — absent rather than
present-and-broken).

### 6.4 Commands that are honest about not being ready

`memo` is **not implemented as a command**; `api_applications.memo_available` reports `false` and
the skill states that memo generation (feature 06) is not in this build. A command that fabricates
a memo and one that crashes are both worse than a field that says what is true.

---

## 7. Claude skill `skills/vcbrain-cli/SKILL.md`

A submission artifact: judges see agent-first access documented, not asserted. Written **last and
short** — it documents what exists, so writing it early guarantees it documents what does not.

Frontmatter (`name` / `description` with trigger phrases / `category` / `requires`) follows the
venture-capital-intelligence template (MIT). Body:

1. Setup — `VCBRAIN_TOKEN`, base URLs, `vcbrain schema` first, **and the write-scope disclosure
   from §3.2 verbatim**.
2. Data model — the three `api_*` views, column by column, with the evidence-tier vocabulary.
3. Command catalogue plus the raw `curl` equivalents for the views and the f03/f07/f10 webhooks —
   so an agent that cannot install the CLI is still fully served.
4. Query patterns — "find and assess a founder", "resolve a compound NL query", "pull the evidence
   behind a score".
5. **Traps** — the section that makes this worth more than a man page. Every item is inherited from
   a contract that was violated at least once during this build:
   - an absent axis means *not assessed*, never zero;
   - never threshold on a score `value` alone — read `confidence` and `missing` too;
   - `missing_flags` shape **differs per axis** (array for `founder_score`, object for the other
     three — measured); the views normalise it, base tables do not;
   - thesis fit resolves through `thesis_evaluations`, never `scores` (stale-100 bug);
   - `insufficient_evidence` is a valid answer, not an error;
   - `unknown` in a search hit is not a mismatch;
   - `obscurity` NULL must never sort first;
   - `total` means "candidates scored", not "founders in the world matching"; `truncated` refers to
     the 200-candidate cap, and `total > limit` is normal;
   - `unknown` in a search hit is free — it lowers `confidence`, never `rank_score`;
   - `matched_broadened` is not `matched`: the attribute was widened to fit the data (e.g. a city
     asked for, a country matched);
   - **there is no enumeration verb.** `search` is the only discovery route — `founder <id>` and
     `application <id>` both require an id and `schema` is static (review round 2 S5). An agent that
     wants a full list reads `api_founders` over PostgREST directly; the `curl` example is in §7.3.

---

## 8. Invariants

### 8.1 Product invariants and where each is enforced

| # | Invariant | Enforcement |
|---|---|---|
| 1 | Three axes never collapse (REQ-002) | `api_applications` has three separate objects and **no** `overall_score` column |
| 2 | Founder Score persistent, person-scoped | `api_founders` reads `axis='founder_score'` by `founder_id`; 10 never writes it |
| 3 | Trust/evidence per claim (REQ-010) | `api_claims.evidence[]`; per-attribute evidence in every search hit |
| 4 | Missing → confidence down, never score down (REQ-003) | §5.5 three-state rule; `score_assessed=false` instead of 0; §5.4 rule 3 |
| 5 | Never fabricate (REQ-004) | `verification_status='missing'` claims served as data; `memo_available:false`; `submit` cut rather than writing an unbacked deck pointer |
| 6 | Thesis configurable | thesis identity travels in `api_applications`; multiple active theses supported |
| 7 | Minimal intake | **N/A** — feature 10 has no intake path (§1.1); owned by 08 |
| 8 | Multi-attribute NL in one pass | §5 |
| 9 | Memo required sections | **N/A** — feature 10 generates no memo; owned by 06 |

### 8.2 Inherited gotchas (each is already a bug someone hit)

From 02: never key identity on `companies.name`; obscurity NULLs never sort first; founders/companies
carry only the columns 02 actually writes (§4.0).
From 03: no-score is normal; `missing_flags` is an array **for `founder_score` only**;
`scores(axis='founder')` belongs to 04.
From 04: absent axis ≠ zero; never threshold on `value` alone; `market.outlook` has four values
including `undetermined`; intermittent duplicate `idea_vs_market` rows → resolve by
`max(computed_at), id`.
From 07: thesis fit via `thesis_evaluations`; `applications.thesis_gate` can be NULL post-gate;
`keyword` mode never returns `passed` and writes no claims; `_`-prefixed `missing_flags` keys are
writer-internal.

### 8.3 Feature 10 writes nothing

Sole writer of: three `api_*` views, `lib/f10/*`, `n8n/workflows/f10-nl-search.json`,
`bin/vcbrain`, `skills/vcbrain-cli/`, `docs/api.md`. **No data writes on any table** (§1.1).

---

## 9. Testing

| Layer | How |
|---|---|
| Scorer (`lib/f10/score.js`) | `node --test lib/f10/*.test.js` over plan+rows fixtures — no LLM, no network. Cases: negative never reaches FTS · empty-corpus negative → `unresolvable` · **negative against a sparse-but-nonempty topic yields `unknown` for candidates with no evidence in that family, never `matched`** (§5.4 rule 3, per-candidate) · six-attribute query returns rows · **`unknown` does NOT lower `rank_score`** — the explicit B2 regression: one match + two `unknown` must outrank one match + two `mismatch` · **`assessed = 0` → `rank_score: null`, not 0 and not a division by zero** · `confidence < 0.25` lands in `low_confidence[]` and never interleaves · tier credit orders `documented` above `discovered` above `inferred` · `missing`-tier evidence is never a match · negatives generate no candidates · zero-positive fallback returns an explained list · `truncated` reflects the 200-candidate cap, not `total > limit` — **unit-test only, over a >200-row fixture: the cap never binds on a 122-founder corpus, so this is unreachable end to end and QA must not chase it live** · identical plan → identical order across runs |
| Views | `psql` assertions in `db/tests/smoke.sql` under `-- Feature 10:`: **a founder with `opt_out_at IS NULL` IS PRESENT** (the positive case — asserting only absence passes trivially against a view returning nothing, which is exactly how B1 survived rev.2) · opted-out and merged-tombstone founders absent · exactly one row per founder · no `overall_score` column · unscored founder yields NULL not 0 · thesis fit matches `thesis_evaluations` not a stale `scores` row · `missing` normalised to a string array on the three axes the views expose (`thesis_fit` is moot since §4.2's M2 fix), `_`-prefixed keys dropped |
| Ordering regression | a founder with 1 assessed attribute at `documented` (rank 100, confidence 0.25) must NOT outrank a founder with 4 assessed at rank 92.5 / confidence 1.0 — this is the exact live-data case that motivated the bucket sort |
| Ordering regression 2 | a founder with `rank_score = 0` (all mismatch/unknown) must NOT outrank any founder with `rank_score > 0`, **whatever their buckets** — the live Q2 case that motivated `has_match`. Assert both regressions together: they pull in opposite directions and a fix for one can break the other |
| NL-search end to end | live calls for Q1 and Q2 (§5.8); Precision@10 hand-checked on Q1; Q2 asserted to return rows with `unresolvable` non-empty and reduced confidence |
| CLI | smoke on all four commands incl. `schema` with `VCBRAIN_TOKEN` unset; error shape asserted for a missing required flag |

QA must not reuse these tests — the gate is an independent adversarial pass.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Clock: 10 is the tracker's designated first-to-drop | **Build order is parallel, not serial** (rev.3 — the resolver has the longest lead time because it sits behind two mandated agent handoffs, and it shares no file with the views): `[§4 views (db-engineer) ‖ §5.3 resolver spec (ai-agent-builder)] → [n8n workflow (n8n agents) ‖ lib/f10 (backend)] → CLI → skill`. **Next cut if it still does not fit: drop the `velocity` and `text` attribute kinds** — each adds a whole retrieval mode, neither appears in Q1, and three kinds still resolve a compound query in one pass, which is the entire rubric claim. Cut those **before** cutting the CLI. Final fallback: drop the CLI (the skill documents `curl` against the views and webhook, which reads as agent-first access just as well). |
| Shared-file collision on `db/schema.sql` / `smoke.sql` (this burned three features at ~06:45) | Views appended under a `-- Feature 10:` marker; committed via @devops the same hour they are written, never left in a working tree. |
| Resolver maps an attribute to a wrong target | `unresolvable[]` + echoed `plan` make it visible; executor rejects targets outside the taxonomy (`invalid_target`) rather than guessing. |
| `radar_candidates` (feature 02) raised `cannot take logarithm of a negative number` — one founder has a real `hn_karma = -2` and the view has no log-domain guard, so ANY query materialising `obscurity` aborts entirely (`count(*)` alone survives because the planner prunes the column, which is why 02's smoke tests missed it) | **Fixed under this feature** with a `GREATEST(x, 0)` floor, marked `-- Feature 10 fix to a Feature 02 object` and announced in the backlog TRACKER. Blocked `api_founders` outright and would equally have blocked 09's dashboard and 02's own feed. |
| Corpus too sparse for a convincing demo | Q1/Q2 split (§5.7). Q1 carries the "it works" story on real data; Q2 carries the honesty story. |
| 04's `scores(axis='founder')` is empty | Reported as `assessed: false`, flagged to the tracker as a cross-feature gap, not hidden. |
