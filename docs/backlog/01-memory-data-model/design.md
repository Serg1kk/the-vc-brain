# 01 · Memory & Data Model — Design (approved)

> Status: **APPROVED by operator (2026-07-19)** — architecture, all 3 sections, enforcement level.
> Scope: Supabase (Postgres) schema for the Memory layer. This doc supersedes the
> «Implementation view (first cut)» in [README.md](README.md).
> Sources consulted (per CLAUDE.md hard rule): intel trackers (REQ/SCOPE/SIG/RSK),
> OSS references (vantage, vcbrain, sieve-mcp, reporting, InGa), NotebookLM ×9 queries
> (early-stage framing), Exa ×2 (evidence-ledger patterns, JSONB hybrid patterns).

## 1. Goals and binding constraints

The schema must make the sponsor invariants **structurally impossible to violate**, not
just documented:

| Invariant | Schema answer |
|---|---|
| Memory stores everything; dedup, timestamps, source tags (REQ-009) | `raw_signals` immutable snapshots, `content_hash` dedup, `observed_at` everywhere |
| Founder Score persists across startups, never reset (REQ-011/FAQ-6) | `scores` append-only, subject = **founder** (person), UPDATE/DELETE revoked |
| 3 axes never collapsed; each with trend (REQ-002) | `scores.axis` from `score_axes` registry; one row per axis; trend per axis |
| Missing data → confidence down, never the score (REQ-003) | `claims.verification_status='missing'`; `scores.missing_flags` + `confidence` |
| No fabrication; gaps marked (REQ-004) | a missing fact is a **claim row** with status `missing` («Cap table: not disclosed») |
| Trust per claim, not per company (invariant #3) | `claims` + `evidence` tables; per-claim confidence computed from evidence |
| Thesis configurable (invariant #6) | `theses` versioned config; scores/applications reference thesis version |
| Minimal intake: deck + name (REQ-008) | `applications` requires only company ref + deck path; everything else nullable |
| NL multi-attribute search in one pass (invariant #8) | FTS tsvector + promoted facet columns; LLM→SQL in one query (feature 10) |
| Extensible types w/o migrations (operator, Jul 19) | registry tables + JSONB payloads: new signal/card/axis/metric = INSERT |
| Early-stage only (operator, Jul 19) | no NRR/churn/LP/portfolio fields; `companies.stage` CHECK pre_seed/seed |

## 2. Architecture decision

**Chosen: Hybrid + registries** (operator pick over two alternatives):

- **Typed columns** for the stable core: ids, FKs, axes, confidence, statuses, timestamps —
  everything constraints and indexes need.
- **JSONB payloads** for variable per-type attributes (`raw_signals.payload`,
  `claims.value`, `theses.config`, `memos.sections`, `*.profile`).
- **Registry tables** for type vocabularies (`score_axes`, `signal_sources`, `card_types`,
  `metric_kinds`): adding a type is an INSERT, not a migration. FK to registry replaces enums.
- Hot JSONB keys are **promoted to generated columns** when they become filters
  (Exa best practice; avoids both EAV and rigid table-per-type).

Rejected: (A) strict normalization — every new type needs DDL, contradicts the
extensibility mandate; (C) full event-sourcing — strongest traceability story but
+2-3h and complicates every n8n write/PostgREST read; its useful parts survive as
`raw_signals`, `events`, and append-only `scores`/`memos`.

Enforcement level (operator pick): **medium** — CHECK/FK constraints, REVOKE
UPDATE/DELETE on append-only tables, 1-2 triggers, one SECURITY DEFINER purge function.
No RPC-gated writes in MVP.

## 3. ER overview

```
                    ┌────────────────────┐
 registries:        │ score_axes         │  signal_sources   card_types   metric_kinds
                    └────────────────────┘
 identity core:
   founders ──< founder_identities            (kind+value UNIQUE — dedup at DB level)
      │  │
      │  └──< metric_observations             (time series → velocity/convergence)
      │
      └──< founder_company >── companies ──< applications >── theses (versioned)
                                                   │
 evidence ledger:                                  │
   raw_signals (immutable) ←─ evidence >── claims ──> cards (card_type)
                                             │  (supersedes chain)
 intelligence:                               │
   scores (append-only, per axis) ── ai_runs (decision receipts)
 experience:
   memos (versioned) · watchlist · interviews ──< voice_artifacts · events (audit)
```

## 4. Tables

Conventions: `id uuid PK default gen_random_uuid()`, `created_at timestamptz default now()`;
`updated_at` + trigger only on mutable tables. All names snake_case, English.

### 4.1 Registries (seeded in schema.sql, extensible by INSERT)

- **`score_axes`** — `slug PK` (`founder`, `market`, `idea_vs_market`, `trust`,
  `founder_score`), `label`, `description`, `is_screening_axis bool`.
  `founder_score` is deliberately an axis row: it is computed and versioned like the
  others but is an *input* to the `founder` screening axis, never a replacement (REQ-002).
  The `trust` axis row is an **application-level rollup** (written by feature 05 for
  dashboard/memo, subject = application, derived from per-claim trust); per-claim trust
  itself is always computed live from `evidence` and is never stored per company —
  invariant #3 stays intact.
- **`signal_sources`** — `slug PK` (`github_api`, `hn_algolia`, `tavily_extract`,
  `deck_parse`, `interview_answer`, `manual`), `label`, `base_tier` (default evidence tier
  for this source).
- **`card_types`** — `slug PK` (`company`, `founder`, `team`), `label`, `section_schema jsonb`
  (informal JSON-shape hint for card sections).
- **`metric_kinds`** — `slug PK` (`gh_stars`, `gh_commit_weeks`, `gh_merged_prs`,
  `hn_points`, `site_updated`, …), `label`, `unit`.

### 4.2 Identity core

- **`founders`** — `full_name`, `normalized_name` (lower/trim, indexed), `headline`,
  `location_city`, `location_country`, `profile jsonb` (extensible facets),
  `is_synthetic bool default false` (honest demo-profile marker),
  `merged_into_founder_id uuid NULL` (duplicate canonicalization tombstone),
  `opt_out_at timestamptz NULL`, `search_tsv` generated tsvector.
- **`founder_identities`** — `founder_id FK`, `kind text NOT NULL` (seed vocabulary:
  `github`, `hn`, `site`, `linkedin`, `x`, `email`; deliberately NO CHECK — new identity
  platforms (e.g. producthunt) must not need a migration, consistent with the
  extensibility stance), `value text`, `url`, `confidence numeric(3,2)`,
  `discovered_via text`, `verified_at`. **UNIQUE(kind, value)** — the DB-level dedup gate:
  re-ingesting the same GitHub login cannot create a second person. Mirrors the sourcing
  identity-resolution flow (GitHub profile as hub; vantage alias pattern).
- **`companies`** — `name`, `normalized_name`, `domain UNIQUE NULL`, `one_liner`,
  `category`, `stage CHECK (stage in ('pre_seed','seed'))`, `hq_city`, `hq_country`,
  `aliases text[]`, `profile jsonb`, `is_synthetic`, `search_tsv`.
- **`founder_company`** — `founder_id FK`, `company_id FK`, `role CHECK (role in
  ('founder','cofounder','early_hire'))`, `is_current bool`, `confidence`,
  `source text`. UNIQUE(founder_id, company_id).

### 4.3 Funnel

- **`applications`** — the funnel unit; both tracks converge here (SCOPE-006).
  `company_id FK`, `kind CHECK (kind in ('inbound','radar_activated'))`,
  `status CHECK (status in ('sourced','screening','diligence','decision','invest','pass'))`,
  `thesis_id FK NULL` (nullable: minimal intake must not depend on a seeded thesis; the
  gate step fills it), `thesis_gate CHECK (thesis_gate in ('passed','failed','borderline')
  OR NULL)` (cheap pre-filter result, SCOPE-007), `deck_storage_path`, `artifact_links jsonb`
  (repo/live URL/demo — REC-014), `submitted_by`, timestamps.
  **Re-application = new row** → the rejection→growth→return trajectory is preserved
  for free (SIG-025).
- **`theses`** — `name`, `config jsonb` (sectors, stages, geos, check_size,
  risk_appetite, weights, must_haves, deal_breakers — vcbrain ThesisConfig vocabulary),
  `version int`, `active bool`. Scores and applications reference a concrete thesis row →
  reproducibility (vcbrain thesisSnapshot pattern).

### 4.4 Evidence ledger

- **`raw_signals`** — append-only observation store. `source FK → signal_sources`,
  `source_url`, `payload jsonb` (raw API/crawl/parse output), `content_hash text UNIQUE`
  (dedup + idempotent n8n retries), `founder_id FK NULL`, `company_id FK NULL`,
  `observed_at timestamptz`. Every downstream conclusion clicks through to a row here —
  the provenance differentiator.
- **`cards`** — `card_type FK → card_types`, `founder_id NULL`, `company_id NULL`,
  `application_id NULL`, `status CHECK (status in ('draft','prefilled','confirmed'))`,
  `completeness numeric(3,2)`. Card content = its claims; the card row is grouping +
  lifecycle metadata (prefilled from public footprint → founder confirms in interview).
- **`claims`** — the unit of knowledge. `card_id FK`, `topic text` (dotted slug:
  `traction.users`, `founder.domain_expertise`, `market.competitors`),
  `text_verbatim text` (word-for-word — the verbatim layer against LLM echo-chamber
  re-centering, RSK-003), `value jsonb NULL` (structured reading),
  `axis FK → score_axes NULL` (which screening axis this feeds),
  `source_kind CHECK (source_kind in ('self_reported','public','interview','voice','derived'))`
  — self_reported/interview start with LOW base confidence (NotebookLM: self-reported =
  hypothesis), `base_confidence numeric(3,2)`,
  `verification_status CHECK (in ('unverified','partially_supported','verified',
  'contradicted','missing'))`, `content_hash` (idempotency),
  `supersedes_claim_id uuid NULL` (corrections are new rows; history never erased —
  koi/actual-news pattern), `search_tsv` generated tsvector over topic + text_verbatim
  (feeds §7 NL-search; addendum per plan review M1). A gap is a first-class row: `topic='round.cap_table',
  verification_status='missing'` renders as «Cap table: not disclosed» (REQ-004).
- **`evidence`** — one row per (dis)confirmation. `claim_id FK`,
  `relation CHECK (relation in ('supports','contradicts','context'))`,
  `strength numeric(3,2)`, `tier CHECK (tier in ('documented','discovered','inferred',
  'missing'))` (sieve-mcp vocabulary), `quote_verbatim`, `source_url`,
  `raw_signal_id FK NULL` → traces to the raw snapshot, `captured_at`,
  `content_hash text UNIQUE` (writer computes over claim_id+relation+source_url+quote —
  a retried truth-gap workflow cannot double-insert and skew per-claim trust).
  **A contradiction is data, not a flag**: the truth-gap agent (feature 05) INSERTs a
  `contradicts` row; claim status is then recomputed. Per-claim Trust =
  f(evidence tiers, relations, strengths) — computed, not stored as opinion.

### 4.5 Intelligence

- **`scores`** — append-only score journal. Subject: `founder_id NULL` XOR
  `application_id NULL` (CHECK exactly one set). `axis FK → score_axes`,
  `value numeric(5,2) CHECK (value BETWEEN 0 AND 100)`,
  `trend CHECK (trend in ('improving','stable','declining'))`,
  `confidence numeric(3,2)`, `missing_flags jsonb` (what was absent — feeds REQ-003),
  `input_claim_ids uuid[]`, `formula_version text`, `prompt_version text`, `model text`,
  `thesis_id FK NULL`, `computed_at`. Current score = latest row per (subject, axis);
  trend derives from row history. **UPDATE/DELETE revoked** — «never reset» is a grant,
  not a convention (vantage CompanyScore pattern).
- **`ai_runs`** — decision receipt for every AI call (vantage AIOutput + NotebookLM Q8).
  `task_type text` (`extraction`, `scoring`, `memo`, `interview_turn`, `truth_gap`, …),
  `founder_id/company_id/application_id NULL`, `model`, `prompt_version`,
  `input_hash`, `output_json jsonb`, `confidence NULL`, `disagreement jsonb NULL`
  (multi-model/panel divergence preserved, never erased), `n8n_execution_id text`.
  Write path: LLM output ALWAYS lands here; target tables only after the n8n
  validation node passes it («model proposes, backend decides»).

### 4.6 Interview & artifacts

- **`interviews`** — `application_id FK`, `card_id FK NULL`, `kind CHECK (kind in
  ('first','follow_up'))`, `share_token text UNIQUE` (VC-requested second interview link;
  email delivery mocked in MVP), `status CHECK (status in ('pending','in_progress',
  'completed','abandoned'))` — mid-interview abandonment is itself a founder signal,
  `disclosed_at` (AI-disclosure guardrail timestamp), `transcript jsonb`,
  `started_at`, `completed_at`. Interview answers spawn claims
  (`source_kind='interview'|'voice'`) + a raw_signal per answer.
- **`voice_artifacts`** — `interview_id FK`, `question_ref text`, `storage_path`
  (Supabase Storage), `duration_sec int`, `transcript_text`. A spoken original is a
  provenance artifact (harder to fake than pasted text).

### 4.7 Experience & ops

- **`memos`** — append-only versions: `application_id FK`, `version int`
  (UNIQUE(application_id, version)), `sections jsonb` — required keys: `snapshot`,
  `hypotheses`, `swot`, `problem_product`, `traction` (brief REQ), enforced by a cheap
  `CHECK (sections ?& array['snapshot','hypotheses','swot','problem_product','traction'])`;
  padding control stays a prompt concern. `gaps jsonb` (honest omissions),
  `cited_claim_ids uuid[]` (memo → claim → evidence → raw_signal chain),
  `recommendation CHECK (in ('invest','pass','watch'))`, `conditions jsonb`,
  `deep_dive_questions jsonb` (REC-005). **No `status` column**: a memo row is immutable;
  regeneration = new `(application_id, version)` row; current memo = highest version.
- **`watchlist`** — `founder_id NULL / company_id NULL`, `reason text`,
  `condition jsonb` (alert rule, e.g. `{"metric":"gh_commit_weeks","delta":">2x","window_days":30}`),
  `added_from_application_id NULL`, `last_scored_at`, `next_check_at`, `active bool`.
  Converts a rejection into a trajectory subscription (REC-010).
- **`metric_observations`** — time series for velocity: `founder_id/company_id NULL`,
  `metric FK → metric_kinds`, `value numeric`, `observed_at`. Snapshots (raw_signals)
  keep provenance; this table makes **velocity over tight windows and convergence
  signals** computable (verification finding #5; vantage CompanyMetric — «velocity is
  the alpha»). Index (metric, founder_id/company_id, observed_at).
  Idempotency: `UNIQUE NULLS NOT DISTINCT (metric, founder_id, company_id, observed_at)`
  — retried sourcing workflows cannot double-insert and distort velocity.
- **`events`** — append-only pipeline audit: `event_type`, `entity_type`, `entity_id`,
  `payload jsonb`, `actor text` (n8n workflow/execution or user), `created_at`.

## 5. Integrity & enforcement (medium level — operator pick)

1. FKs to registries replace enums; CHECKs guard statuses (listed above).
2. **Append-only set**: `scores`, `raw_signals`, `evidence`, `ai_runs`, `events`, `memos`
   — `REVOKE UPDATE, DELETE` from the API/service roles used by n8n and PostgREST.
3. `updated_at` trigger on mutable tables (founders, companies, cards, claims-status*,
   applications, watchlist, **interviews** — status/completed_at lifecycle, **theses** —
   `active` toggle). Third bucket — mutable-rarely, no updated_at trigger: registries,
   `founder_identities` (verified_at/confidence set after discovery), `founder_company`
   (`is_current` flips when a founder moves on — the mechanism behind «the score follows
   the person»), `voice_artifacts`, `metric_observations`. *claims: only
   `verification_status` is mutable (recomputed from evidence); text/value corrections
   go through `supersedes_claim_id` — documented convention, column-restricting trigger
   optional if the trigger budget allows.
4. **`purge_founder(founder_id)`** — SECURITY DEFINER function, the ONLY deletion door
   (GDPR/opt-out, P3-K4): cascades across all tables incl. append-only ones, writes an
   anonymized `events` row. Resolves the immutability-vs-right-to-deletion conflict
   (verification finding #3).
5. RLS: not in MVP scope beyond service tokens (single fund); tables stay RLS-ready.

## 6. Write path (n8n)

- All writes via Supabase API (service key); one «DB-write» sub-workflow per entity.
- Idempotency (the full set): `content_hash` UNIQUE on `raw_signals`, `claims`,
  `evidence`; `UNIQUE NULLS NOT DISTINCT (metric, founder_id, company_id, observed_at)`
  on `metric_observations` → `ON CONFLICT DO NOTHING`; n8n retries are safe everywhere.
- «Model proposes, backend decides»: agent output → `ai_runs` (always) → validation
  node → target tables (only if valid).

## 7. NL-search grounding (no vector DB — operator ruling stands)

- `search_tsv` generated tsvector + GIN on `founders`, `companies`, `claims`.
- Hot facets promoted from `profile` JSONB to generated columns as they stabilize:
  `location_country`, `category`, `is_technical`, `prior_vc_backing`, `accelerator` —
  B-tree indexed. The reference query «technical founder, Berlin, AI infra, no prior VC
  backing, top accelerator» resolves as ONE SQL statement (LLM→SQL, feature 10).

## 8. Verified pitfalls → design responses (NotebookLM verification pass)

| # | Pitfall | Response |
|---|---|---|
| 1 | Entity resolution → duplicate profiles corrupt scoring | UNIQUE(kind,value) identities; `merged_into_founder_id`; no-ML resolution flow via GitHub hub |
| 2 | Relational misses network dynamics | typed link tables = graph edges in SQL; full graph (InGa) = post-MVP |
| 3 | Append-only vs right-to-deletion | `purge_founder()` single door + anonymized audit event |
| 4 | One-sided label noise (no data ≠ failure) | `missing` is a claim status hitting confidence, never value; PU-estimation note handed to feature 03 |
| 5 | Snapshots hide velocity/convergence | `metric_observations` time series; watchlist conditions over windows |
| 6 | Arbitration bias (generic negatives outweigh specific positives) | evidence carries `tier`+`strength`; weighting rule handed to features 03/05 prompts (via ai-agent-builder) |

## 9. Handoff notes to other features

- **02 Sourcing**: write raw_signals + metric_observations + founder_identities only via
  DB-write sub-workflows; GitHub hub is the identity anchor.
- **03 Founder Score**: read claims/evidence, write scores (axis=`founder_score`) +
  ai_runs; PU-estimation / label-noise caution; never write a negative claim for absence.
- **04 Market/Trend/Competition**: writes market-topic claims (`market.*`,
  `competition.*` slugs) + Tavily raw_signals + scores for `market` / `idea_vs_market`
  axes (subject = application) + ai_runs receipts. Competitor entities live as claims
  with structured `value` (typed per_competitor_record vocabulary from reporting), not
  as a dedicated table in MVP.
- **05 Truth-gap**: INSERT `contradicts` evidence, recompute claim status; also writes
  the application-level `trust` rollup rows into `scores` (see §4.1); specificity >
  volume in arbitration prompts.
- **06 Memo**: cite claim ids only; gaps come from `missing` claims.
- **07 Thesis**: theses.config vocabulary fixed here; new criteria = config keys.
- **08 Interview**: questions generated FROM card gaps (claims with `missing`/low
  confidence); every answer = claim + raw_signal (+ voice_artifact).
- **10 API/CLI**: PostgREST exposes these tables as-is; append-only semantics documented
  in the Claude skill. Note: the multi-table NL-search query needs a **view or RPC**
  (e.g. `search_founders(...)`) on top of PostgREST — raw per-table filters cannot join;
  plan it in feature 10, the view lands in schema.sql.
- **11 Demo data**: `is_synthetic` flags; seeded contradictions = prepared
  `contradicts` evidence rows.

## 10. Boundaries & stubs

No vector DB · no multi-tenancy/auth beyond single fund + service tokens · no migration
tooling (one `schema.sql`, changes additive) · no portfolio/downstream tables ever ·
late-stage metrics (NRR, churn cohorts, LP fields) deliberately absent.

## 11. Open items (for the implementation plan)

- OQ-001 (intake form fields) → finalize nullable columns on `applications` at feature 08.
- Claim `topic` slug vocabulary: seed list at implementation, free-form allowed.
- Whether `metric_observations` backfills from raw_signals payloads (nice-to-have n8n step).
