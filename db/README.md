# db/ — The VC Brain Memory-layer schema

Reference for anyone writing to this database: the n8n workflow builder, the feature-10
CLI/skill, or a future agent. Authoritative design lives in
[`docs/backlog/01-memory-data-model/design.md`](../docs/backlog/01-memory-data-model/design.md)
(internal, not published) — this file is the practical "how do I write to table X" companion,
committed alongside the schema itself.

## Files

| File | Purpose |
|---|---|
| `schema.sql` | All DDL: tables, indexes, functions, triggers. Additive-only, re-appliable (`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE`). |
| `seed.sql` | Registry rows only (`score_axes`, `signal_sources`, `card_types`, `metric_kinds`). Idempotent (`ON CONFLICT DO NOTHING`). |
| `apply.sh` | `psql` wrapper: applies `schema.sql` then `seed.sql`, reloads PostgREST's schema cache. See CLAUDE.md > Commands for the exact connection string. |
| `tests/smoke.sql` | 43 assertions proving every constraint, dedup gate, and the enforcement layer actually work. Runs inside one transaction, always rolls back. |

## Connecting

Supabase self-hosted runs a Supavisor connection pooler in front of Postgres. **The username
must be tenant-qualified** — `postgres.<POOLER_TENANT_ID>`, not plain `postgres` (which fails
with `no tenant identifier provided`). `POSTGRES_PASSWORD` and `POOLER_TENANT_ID` live in
`infra/supabase/.env` (gitignored, never commit or print them).

```
DATABASE_URL=postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@localhost:54322/postgres
```

REST access goes through Kong on `:8000` (`ANON_KEY` / `SERVICE_ROLE_KEY`, same `.env` file).
See CLAUDE.md > Commands for copy-paste examples of every command below, including the full
reset sequence (note: `docker compose down -v` alone does **not** wipe Postgres data — the
PGDATA directory is a host bind-mount, not a named volume; CLAUDE.md has the corrected sequence).

## Table map

**Registries** (seeded, extensible by INSERT — new type = new row, never a migration):

| Table | What |
|---|---|
| `score_axes` | Vocabulary for `scores.axis` / `claims.axis`: `founder`, `market`, `idea_vs_market`, `trust`, `founder_score`. |
| `signal_sources` | Vocabulary for `raw_signals.source`: `github_api`, `hn_algolia`, `tavily_extract`, `deck_parse`, `interview_answer`, `manual`. |
| `card_types` | Vocabulary for `cards.card_type`: `company`, `founder`, `team`. |
| `metric_kinds` | Vocabulary for `metric_observations.metric`: `gh_stars`, `gh_commit_weeks`, `gh_merged_prs`, `hn_points`, `site_updated`, extensible. |

**Identity core:**

| Table | What |
|---|---|
| `founders` | One row per real person. `search_tsv` (generated, GIN) feeds NL search. `merged_into_founder_id` is a duplicate-canonicalization tombstone. |
| `founder_identities` | External identity claims (GitHub, HN, site, LinkedIn, X, email) — `UNIQUE(kind, value)` is the DB-level dedup gate. |
| `companies` | One row per company, early-stage only (`stage` CHECK `pre_seed`/`seed`). `search_tsv` (generated, GIN). |
| `founder_company` | Founder↔company edges (`role`: founder/cofounder/early_hire). |

**Funnel:**

| Table | What |
|---|---|
| `theses` | Versioned fund configuration (sectors, stage, geo, check size, risk appetite). |
| `applications` | The funnel unit. Minimal intake = `company_id` + `deck_storage_path` for `kind='inbound'` only (`radar_activated` rows are deckless by design). Re-application = a new row, on purpose. |

**Evidence ledger:**

| Table | What |
|---|---|
| `raw_signals` | Immutable observation snapshots (append-only). |
| `cards` | Grouping + lifecycle metadata (`draft`/`prefilled`/`confirmed`) for a founder/company/team's claims. |
| `claims` | The unit of knowledge. `verification_status='missing'` is a first-class gap (REQ-004), not an omission. `search_tsv` (generated, GIN). Corrections are new rows via `supersedes_claim_id`. |
| `evidence` | One row per (dis)confirmation of a claim (append-only). `relation='contradicts'` is data, not a flag. |

**Intelligence:**

| Table | What |
|---|---|
| `scores` | Append-only score journal. Subject is `founder_id` XOR `application_id`. Current value per (subject, axis) = latest `computed_at` row — never overwritten. |
| `ai_runs` | Decision receipt for every AI call (append-only). `disagreement` preserves multi-model divergence. |

**Interview, experience & ops:**

| Table | What |
|---|---|
| `interviews` | AI interview sessions. Mutable (`status` lifecycle). |
| `voice_artifacts` | Spoken-answer provenance artifacts. |
| `memos` | Append-only versioned investment memos. `sections` CHECK enforces the 5 required keys. |
| `watchlist` | Rejected-but-worth-tracking founders/companies. |
| `metric_observations` | Time series for velocity/convergence signals. |
| `events` | Append-only pipeline audit log. |

## Append-only tables

`scores`, `raw_signals`, `evidence`, `ai_runs`, `events`, `memos` — `UPDATE`/`DELETE` are
rejected at the trigger level (`forbid_mutation()`, SQLSTATE `P0001`) for **any** caller,
including `service_role` over PostgREST. The only way data in these tables is ever removed is
via `purge_founder()` (below). Do not build a write path that assumes these are ever editable.

**`TRUNCATE` is separately revoked** (`REVOKE TRUNCATE ... FROM anon, authenticated,
service_role`), not just trigger-guarded: `BEFORE UPDATE OR DELETE` triggers never fire on
`TRUNCATE`, and Supabase's self-hosted default privileges (`ALTER DEFAULT PRIVILEGES IN SCHEMA
public`) grant `TRUNCATE` to those three roles on every table at creation time — a QA-gate
finding (Task 12), not something this project's DDL added on purpose. **Any new append-only
table added in a later feature is born with `TRUNCATE` already granted the same way — copy the
`REVOKE` for it too**; this is a per-table fix, deliberately not a change to the schema-wide
default (which also governs `SELECT`/`INSERT`/`UPDATE` that these roles legitimately need).

## Idempotency keys (for n8n `ON CONFLICT` targets)

| Table | Conflict target | Notes |
|---|---|---|
| `score_axes` / `signal_sources` / `card_types` / `metric_kinds` | `slug` | Registries only; not written by product workflows. |
| `founder_identities` | `(kind, value)` | The identity dedup gate — re-ingesting the same GitHub login is a safe no-op. |
| `founder_company` | `(founder_id, company_id)` | |
| `theses` | `(name, version)` | |
| `raw_signals` | `content_hash` | Writer computes the hash over the raw payload — safe for n8n retries. |
| `claims` | `content_hash` | Nullable — only set when there is real underlying content to hash (a synthesized `missing` claim has none). |
| `evidence` | `content_hash` | Writer computes over `claim_id + relation + source_url + quote`. |
| `metric_observations` | `(metric, founder_id, company_id, observed_at)` | `UNIQUE NULLS NOT DISTINCT` — retried sourcing workflows cannot double-insert and skew velocity. |
| `memos` | `(application_id, version)` | Regeneration = a new version row, not an update. |

Tables **without** a DB-level idempotency key — `founders`, `companies`, `applications`,
`cards`, `scores`, `ai_runs`, `interviews`, `voice_artifacts`, `watchlist`: dedup for these is
either intentionally NOT a DB concern (`applications` — re-application is a new row on purpose;
`scores`/`ai_runs` — append-only versioning, always insert) or happens upstream (`founders` —
resolved via the `founder_identities` dedup gate before a new founder row is ever created).

## `purge_founder(founder_id uuid)` — GDPR erasure contract

The **only** deletion path in this schema (SECURITY DEFINER, runs as the `postgres` owner
regardless of caller). Given a founder id, it removes:

- every row directly scoped to that founder (`scores`, `metric_observations`, `raw_signals`,
  `ai_runs`, `watchlist`, `founder_company`, `founder_identities`, plus their cards → claims →
  evidence chain);
- the **entire** subtree of any company where that founder is the sole linked founder
  (applications → interviews → voice_artifacts → memos, plus company-scoped cards/claims/
  evidence/raw_signals/metric_observations/watchlist, then the company row itself) — companies
  with other founders keep their company-level data;
- every prior `events` row about that founder;
- any merged-duplicate ("tombstone") founder rows pointing at this one, folded into the same
  call (one erasure, not one per duplicate).

It leaves behind **exactly one** anonymized `events` row (`event_type='founder_purged'`, no
PII in the payload) as the audit trail. Call it as `SELECT purge_founder('<uuid>');` — there is
no other supported way to delete rows from this schema; a bare `DELETE`/`UPDATE` on any table
either hits the append-only trigger (P0001) or a `RESTRICT` foreign key (23503).

## Verified live (2026-07-19)

- Cold-start reset (full `infra/supabase` volume wipe → `apply.sh` → smoke): green, ~28s wall
  time end to end.
- `PATCH /rest/v1/scores?id=eq.<uuid>` via Kong with the `service_role` key → `400`,
  `{"code":"P0001", "message":"append-only invariant violated: ..."}` — the append-only
  invariant is visible straight through the REST surface.
- A forged `SET vcbrain.purging = 'on'` from a non-owner role (`service_role`) does not bypass
  the guard — `current_user` must also be the function owner.
