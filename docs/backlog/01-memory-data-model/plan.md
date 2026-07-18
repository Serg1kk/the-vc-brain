# Feature 01 — Memory & Data Model: Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement
> this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Executors per project process:
> infra bring-up + all git commits → **@devops**; schema/tests → **@database-engineer**;
> adversarial gate → **@qa-engineer**. Column-level DDL specs live in [design.md](design.md)
> §4-§5 — the plan references them instead of duplicating SQL (architect convention).

**Goal:** A running self-hosted Supabase with the full approved Memory-layer schema applied,
invariant-enforcing triggers active, and a green smoke suite proving the sponsor invariants
hold at the database level.

**Architecture:** Hybrid typed-core + JSONB payloads + registry tables (design.md §2).
Append-only guarantees via BEFORE UPDATE/DELETE triggers that RAISE (deliberate deviation
from the spec's REVOKE wording: on Supabase, role grants are entangled with internal roles
and get reapplied; triggers hold under any API key — same invariant, sturdier mechanism).
One `schema.sql` applied idempotently; no migration tooling (additive changes only).

**Tech Stack:** Supabase self-hosted (official docker-compose: Postgres 15+, PostgREST,
Storage, Kong), psql, plain-SQL smoke tests (no pgTAP — YAGNI for 24h).

**Dev environment (operator decision):** full Supabase compose brought up fresh locally
(no existing local instance path provided). n8n container is NOT added here — first needed
by feature 02; compose formalization for VPS is feature 12.

---

## Chunk 1: Environment & scaffolding

### Task 1: Supabase self-hosted up — @devops

**Files:**
- Create: `infra/supabase/` (official supabase/docker files: `docker-compose.yml`, `.env`)
- Modify: `.gitignore` check only — `infra/supabase/.env` must be ignored (pattern `.env` already covers it; verify)

- [ ] **Step 1:** Fetch the official self-hosted docker files (supabase/supabase `docker/` directory, sparse checkout or curl of the release tarball) into `infra/supabase/`. Do not hand-write the compose.
- [ ] **Step 2:** Create `infra/supabase/.env` from the bundled `.env.example`: generate fresh `POSTGRES_PASSWORD` and `JWT_SECRET`, then generate `ANON_KEY` and `SERVICE_ROLE_KEY` as JWTs **signed with that same `JWT_SECRET`** (Supabase self-hosting docs provide the generator; mismatched signing = PostgREST 401s — m3); keep default ports unless occupied (Kong 8000, Postgres 5432) — if occupied, shift and record the final ports in CLAUDE.md Commands.
- [ ] **Step 3:** `docker compose up -d` in `infra/supabase/`; wait for healthy.
- [ ] **Step 3b (operator override, Jul 19):** add **n8n** to the local Docker setup now (not
  deferred to feature 02): official `n8nio/n8n` container in `infra/n8n/docker-compose.yml`
  (or a service joined to the Supabase compose network), persistent volume, port 5678,
  `WEBHOOK_URL=http://localhost:5678/`. Verify: `curl -s http://localhost:5678/` → n8n
  login page HTML.
- [ ] **Step 4:** Verify, expected outputs:
  - `psql "postgresql://postgres:<pw>@localhost:5432/postgres" -c "select version();"` → `PostgreSQL 15` or newer (15+ required for `UNIQUE NULLS NOT DISTINCT`).
  - `curl -s http://localhost:8000/rest/v1/ -H "apikey: $ANON_KEY"` → OpenAPI JSON (PostgREST alive).
- [ ] **Step 5:** Commit `infra/` (WITHOUT `.env`) — @devops, repo commit-style, no push.

**Acceptance criteria:** compose runs from a clean checkout with only `.env` filled in;
psql and PostgREST both answer; `.env` not tracked by git.

### Task 2: Repo scaffolding + Commands section — @database-engineer

**Files:**
- Create: `db/schema.sql` (header comment + empty), `db/seed.sql`, `db/tests/smoke.sql`, `db/apply.sh`
- Modify: `CLAUDE.md` (add the **Commands** section — project hard rule: first code commit adds it)

- [ ] **Step 1:** `db/apply.sh`: psql wrapper with `ON_ERROR_STOP=1`, reads `DATABASE_URL` env (default local instance), applies `schema.sql` then `seed.sql`, and finishes with `NOTIFY pgrst, 'reload schema';` — PostgREST caches the schema and won't expose new tables (or surface trigger errors on PATCH) until reloaded (M3).
- [ ] **Step 2:** `db/tests/smoke.sql` skeleton: runs inside a transaction, uses `DO` blocks that `RAISE EXCEPTION` on failed assertions, `ROLLBACK` at the end (smoke never dirties data); a negative-case helper pattern: attempt a forbidden statement in a nested block, assert the expected SQLSTATE was raised.
- [ ] **Step 3:** CLAUDE.md Commands: compose up/down, apply schema, run smoke — exact copy-paste commands.
- [ ] **Step 4:** Run `./db/apply.sh && psql ... -f db/tests/smoke.sql` on the empty files → exits 0.
- [ ] **Step 5:** Commit via @devops.

**Acceptance criteria:** one-command apply + one-command smoke, both green on empty schema;
Commands section present in CLAUDE.md.

## Chunk 2: Schema by table groups

> **Stages & parallelism (dependency note, M5):** Task 1 ∥ Task 2 Steps 1-3 may run in
> parallel (different executors, no shared files); Task 2 Step 4 (run apply+smoke) waits
> for Task 1's DB to be up (R4). Tasks 3→8 are STRICTLY SEQUENTIAL — same append
> targets (`db/schema.sql`, `db/tests/smoke.sql`) and FK dependency order (registries →
> identity → funnel → ledger → intelligence → interview/ops). Task 9 depends on 3-8;
> Task 10 on 9; Tasks 11 ∥ 12 both depend on 10 and may run in parallel.
>
> Pattern for Tasks 3-8 (uniform): (a) append the group's DDL to `db/schema.sql` exactly per
> the referenced design.md section — tables, CHECKs, FKs, UNIQUEs, generated columns, indexes;
> (b) append the group's assertions to `db/tests/smoke.sql` — at minimum one positive insert
> per table and every listed negative case asserting its SQLSTATE (23505 unique, 23514 check,
> 23503 FK); every negative case is its own `BEGIN … EXCEPTION` PL/pgSQL sub-block (savepoint
> semantics — a bare failing statement would abort the whole smoke transaction); every
> intended «no-op» dedup insert carries an explicit `ON CONFLICT … DO NOTHING` clause;
> (c) `./db/apply.sh && smoke` → green; (d) commit via @devops. Schema must stay
> re-applyable: `CREATE TABLE IF NOT EXISTS` + `CREATE OR REPLACE` for functions/triggers +
> idempotent seed upserts.
>
> **FTS scope decision (M1):** `search_tsv` generated columns + GIN indexes on `founders`
> (Task 4), `companies` (Task 4) and `claims` (Task 6) ARE part of feature 01. Promoted
> facet generated columns (`is_technical`, `prior_vc_backing`, `accelerator`, …) are
> DEFERRED to feature 10 (additive `ALTER TABLE … ADD COLUMN GENERATED`, no migration pain).

### Task 3: Registries + seeds — @database-engineer

Design ref: **§4.1**. Seeds (in `db/seed.sql`, `ON CONFLICT DO NOTHING`): score_axes
(`founder`, `market`, `idea_vs_market`, `trust`, `founder_score`), signal_sources
(`github_api`, `hn_algolia`, `tavily_extract`, `deck_parse`, `interview_answer`, `manual`),
card_types (`company`, `founder`, `team`), metric_kinds (starter set from §4.1).

- [ ] DDL + seeds; smoke: seeds present (row counts), re-running seed.sql is a no-op.

**Acceptance:** all 4 registries queryable with seed rows; double-apply changes nothing.

### Task 4: Identity core — @database-engineer

Design ref: **§4.2** (founders, founder_identities, companies, founder_company).

- [ ] DDL (incl. `search_tsv` generated + GIN on BOTH founders and companies — M1); smoke
  negative cases: duplicate `(kind, value)` identity → 23505 (the dedup gate);
  `companies.stage='series_a'` → 23514 (early-stage constraint); founder_company duplicate
  pair → 23505. Positive: founder + github identity + company + link round-trip;
  `search_tsv` non-null for a named founder AND a named company.

**Acceptance:** re-ingesting the same GitHub login cannot create a second person — proven by
a failing insert in smoke.

### Task 5: Funnel — @database-engineer

Design ref: **§4.3** (applications, theses).

- [ ] DDL; smoke: minimal intake works — application with ONLY company_id + deck_storage_path
  (thesis_id NULL) inserts fine (REQ-008); invalid `status` → 23514; re-application =
  second row for the same company succeeds (trajectory).

**Acceptance:** minimal-intake insert green; funnel statuses constrained.

### Task 6: Evidence ledger — @database-engineer

Design ref: **§4.4** (raw_signals, cards, claims, evidence).

- [ ] DDL (incl. `claims.search_tsv` generated over topic+text_verbatim + GIN — M1: absent
  from design §4.4 column list but required by §7; design.md gets the addendum); smoke:
  duplicate `raw_signals.content_hash` insert with explicit `ON CONFLICT (content_hash)
  DO NOTHING` → row count unchanged (idempotent retries); claim with
  `verification_status='missing'` inserts (a gap is data — REQ-004); `supersedes_claim_id`
  chain of 2 rows; evidence `relation='contradicts'` row lands; duplicate
  `evidence.content_hash` with `ON CONFLICT DO NOTHING` → no-op.

**Acceptance:** full provenance chain insertable: raw_signal → claim → evidence referencing it.

### Task 7: Intelligence — @database-engineer

Design ref: **§4.5** (scores, ai_runs).

- [ ] DDL; smoke: score with BOTH founder_id and application_id set → 23514 (XOR CHECK);
  score with NEITHER set → 23514 (XOR is two-sided — m1); `value=150` → 23514; two
  sequential `founder_score` rows for one founder insert fine (append-only versioning)
  and `max(computed_at)` row is the current one; ai_runs insert with `disagreement` payload.

**Acceptance:** versioned scores per axis work; subject XOR and 0-100 bounds enforced.

### Task 8: Interview, experience & ops — @database-engineer

Design ref: **§4.6-§4.7** (interviews, voice_artifacts, memos, watchlist,
metric_observations, events).

- [ ] DDL; smoke: memo missing the `swot` key in sections → 23514 (`?&` CHECK); duplicate
  `(application_id, version)` → 23505; interview status transition pending→abandoned via
  UPDATE succeeds (mutable table); duplicate metric observation (same metric/subject/
  observed_at, NULLS NOT DISTINCT) with explicit `ON CONFLICT DO NOTHING` → no-op (m4);
  events insert.

**Acceptance:** required memo sections DB-enforced; velocity table dedup-safe.

### Task 9: Enforcement layer — @database-engineer

Design ref: **§5** (items 2-4). All DDL here uses `CREATE OR REPLACE FUNCTION` /
`CREATE OR REPLACE TRIGGER` (PG14+) so `schema.sql` stays idempotently re-applyable.

- [ ] **Step 1:** One trigger function `forbid_mutation()` (RAISE EXCEPTION, message names
  the violated invariant) + BEFORE UPDATE OR DELETE triggers on the six append-only tables:
  scores, raw_signals, evidence, ai_runs, events, memos.
  **Purge bypass built in (two predicates — R1):** the function returns without raising
  only when `current_setting('vcbrain.purging', true) = 'on'` **AND `current_user` equals
  the `purge_founder` owner role** (under SECURITY DEFINER the cascade runs as the owner,
  e.g. `postgres`). A placeholder GUC alone is USERSET — any session incl. service_role
  could SET it; the `current_user` guard makes that attack inert: a hostile session can
  set the GUC but is not the owner → still blocked, and it cannot SET ROLE to the owner.
  (Chosen over `session_replication_role='replica'`, which would also disable FK
  enforcement.)
- [ ] **Step 2:** `touch_updated_at()` trigger on the mutable set (§5.3 list).
- [ ] **Step 3:** `purge_founder(uuid)` SECURITY DEFINER per §5.4. Opens with
  `SET LOCAL vcbrain.purging = 'on'`, then deletes in FK-safe order the EXHAUSTIVE set of
  founder-linked rows:
  1. **Sole-founder companies — full subtree (R2, one consistent rule):** for every company
     where this founder is the ONLY founder, cascade the ENTIRE company chain — its
     applications' `voice_artifacts` → `interviews` → `memos` → `applications`, plus
     company-linked `cards`→`claims`→`evidence`, `raw_signals` (company_id),
     `metric_observations` (company_id), `scores` (via those applications), `watchlist`
     (company), and the `companies` row itself. Rationale in the function comment: a
     sole-founder company is the person's data shadow — interview transcripts, memos and
     assessments all describe the same human; a half-purge that keeps the memo is not
     erasure. Multi-founder companies: company-level artifacts are RETAINED as
     separate-entity data (documented), only founder-scoped rows below are removed;
  2. `evidence` → `claims` for the founder's cards → `cards` (founder-subject);
  3. `scores` (founder_id), `metric_observations` (founder_id), `raw_signals` (founder_id),
     `ai_runs` (founder_id), `watchlist` (founder_id);
  4. prior `events` rows with `entity_type='founder' AND entity_id=<id>` (GDPR beats audit);
  5. duplicate `founders` rows with `merged_into_founder_id = <id>` (R3: same person's
     tombstones — purge them via the same traversal, else the self-FK blocks the DELETE);
     then `founder_company`, `founder_identities`, and the `founders` row itself (hard
     DELETE, no tombstone);
  6. INSERT one anonymized `events` row (`event_type='founder_purged'`, payload without PII).

  **Delete-order hazard (reviewer advisory, binding for implementation):** FK enforcement
  stays ON during purge, and `evidence.raw_signal_id` can cross subtrees (founder-scoped
  evidence → company-scoped raw_signal). Therefore sweep ALL evidence → claims → cards in
  the purge set (both subtrees) BEFORE deleting ANY raw_signals. The smoke fixture must
  wire one founder-evidence → company-raw_signal cross-link so this path is actually
  exercised.
- [ ] **Step 4:** Smoke: `UPDATE scores SET value=...` → P0001 with invariant message; DELETE
  on raw_signals → P0001; **the real R1 attack**: in a non-owner session run
  `SET vcbrain.purging='on'` then `UPDATE scores` → STILL blocked (GUC forged, but
  `current_user` ≠ owner); `purge_founder` on a fixture founder (with rows seeded in EVERY
  table from the Step-3 list, incl. a sole-founder company with application+interview+memo
  AND a merged-duplicate founders row) → zero founder-linked rows remain anywhere EXCEPT
  the single anonymized event; purge is the ONLY working delete path.

**Acceptance:** «Founder Score never reset» and «nothing thrown away» hold against hostile
UPDATE/DELETE under any role/key; `purge_founder` empties the exhaustive founder-linked set
(list above = every founder_id-bearing table + claims/evidence via cards + voice via
interviews) and leaves exactly one anonymized audit row.

## Chunk 3: Verification & handoff

### Task 10: Cold-start reset proof — @database-engineer

- [ ] `docker compose down -v && up -d` → `./db/apply.sh` → smoke → green, in one recorded
  command sequence (goes into CLAUDE.md Commands as «full reset»).
- [ ] PostgREST exposure check (apply.sh has already sent `NOTIFY pgrst, 'reload schema'`;
  if 404s persist, restart the rest container — M3): `curl .../rest/v1/founders?select=id`
  with SERVICE_ROLE key → `[]` (200); `PATCH .../rest/v1/scores?id=eq.<uuid>` → error
  surfaced from the trigger (the append-only invariant visible straight through the REST
  surface — judge-facing proof).

**Acceptance:** clean-machine bring-up ≤ 5 commands; REST PATCH on scores provably fails.

### Task 11: Handoff docs + final commit — @database-engineer, commit @devops

- [ ] `db/README.md`: table map (one line per table), the append-only list, idempotency keys
  per table (for n8n DB-write sub-workflows: which ON CONFLICT target to use), purge
  function contract, connection env vars. This is the reference the n8n builder and the
  feature-10 CLI/skill will read.
- [ ] Feature README status: backlog → schema implemented (link plan.md + design.md).
- [ ] Final commit via @devops.

**Acceptance:** a new agent can write to the DB correctly from `db/README.md` alone.

### Task 12: Adversarial QA gate — @qa-engineer

- [ ] Independent pass, NOT reusing smoke.sql: attack each invariant via psql AND via
  PostgREST (after schema reload — M3): UPDATE a score; DELETE a raw_signal; memo without
  a required section via REST; duplicate identity via REST; manual `SET vcbrain.purging`
  in an API session followed by UPDATE scores (bypass must not leak).
- [ ] **Non-collapse check (M4), stated plainly:** REQ-002 is convention-level at the DB —
  the axis registry is deliberately INSERT-extensible, so nothing structurally blocks
  someone adding an `overall` axis; the DB-level guarantees are (a) the seed contains no
  aggregate axis (`SELECT count(*) FROM score_axes WHERE slug IN
  ('overall','total','combined')` → 0) and (b) scores are stored one-row-per-axis, so
  collapse can only happen at render time. The QA report must state this honestly
  (it reconciles design §1's «structurally impossible» wording for this one invariant).
- [ ] Report: pass/fail per invariant with reproduction commands.

**Acceptance:** QA report filed in the feature folder (`qa-report-01.md`), all invariant
attacks rejected by the DB (or findings fed back into Task 9), non-collapse honesty note
included.

---

## Decision log

1. Triggers over REVOKE for append-only (Supabase role entanglement) — deviation from
   design.md §5.2 wording, same invariant; design.md stays authoritative for WHAT, this
   plan for HOW.
2. No pgTAP — plain-SQL DO-block assertions (24h budget; zero new dependencies).
3. n8n container included in Task 1 local Docker bring-up (operator override, Jul 19);
   VPS compose/deploy formalization stays feature 12.
4. Smoke tests run in a rolled-back transaction — re-runnable on a live DB.
