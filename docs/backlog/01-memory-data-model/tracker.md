# 01 · Memory & Data Model — Execution Tracker

> Plan: [plan.md](plan.md) (✅ approved by implementation-plan-reviewer, round 3, 2026-07-19).
> Spec: [design.md](design.md). **Single writer of this file: the orchestrator (main
> session).** Agents report to the orchestrator; the orchestrator updates statuses on every
> dispatch/completion/failure. Purpose: full recovery picture after any crash.

## Task board

| # | Task | Executor | Depends on | Status | Result / commit | Notes |
|---|------|----------|-----------|--------|-----------------|-------|
| 1 | Supabase self-hosted up (`infra/supabase/`) + n8n | @devops | — | done | commits 903601b (docs), 668e41d (infra); PG 17.6, Kong 8000, n8n 5678 | keys via official generate-keys.sh; .env not committed |
| 2 | Repo scaffolding `db/` + CLAUDE.md Commands | @database-engineer | Step 4 waits on 1 | done | apply+smoke exit 0 on live DB | |
| 3 | Registries + seeds | @database-engineer | 1, 2 | done | 4 registries seeded (5/6/3/5 rows), non-collapse seed guard | |
| 4 | Identity core (+FTS founders/companies) | @database-engineer | 3 | done | dedup gate + search_tsv proven; normalized_name GENERATED | |
| 5 | Funnel (applications, theses) | @database-engineer | 4 | done | minimal intake + re-application proven; theses UNIQUE(name,version) | deck NOT NULL → replaced by inbound-only CHECK (design addendum) |
| 6 | Evidence ledger (+claims.search_tsv) | @database-engineer | 5 | done | provenance chain, supersedes chain, contradicts row, dedup no-ops | |
| 7 | Intelligence (scores, ai_runs) | @database-engineer | 6 | done | XOR both ways, 0-100 bound, append-only versioning proven | |
| 8 | Interview, experience & ops | @database-engineer | 7 | done | memo `?&` CHECK, NULLS NOT DISTINCT dedup, mutable interviews | |
| 9 | Enforcement (triggers, purge_founder) | @database-engineer | 3-8 | done | 42 smoke blocks; real R1 attack (SET ROLE service_role) blocked; purge ordering bug found+fixed; DEFERRABLE on 2 self-FKs | re-applied on REAL supabase-db @54322 after port incident |
| 10 | Cold-start reset proof + REST checks | @database-engineer | 9 | in_progress | | |
| 11 | Handoff docs (`db/README.md`) + final commit | @database-engineer → @devops | 10 | pending | | ∥ with 12 |
| 12 | Adversarial QA gate (`qa-report-01.md`) | @qa-engineer | 10 | pending | | ∥ with 11 |

## Event log

- 2026-07-19 · plan approved by reviewer (3 rounds: 2C+5M+4m → 2M+2m → ✅); FK cross-subtree
  advisory folded into Task 9.
- 2026-07-19 · tracker created; dispatched @devops (docs commit → Task 1) and
  @database-engineer (Task 2 steps 1-3).
- 2026-07-19 ~02:03 · Task 2 steps 1-3 done, files verified on disk (apply.sh with NOTIFY
  pgrst, smoke harness with BEGIN/EXCEPTION pattern, CLAUDE.md Commands). Task 1 still
  in progress (infra/ dirs created, containers coming up).
- 2026-07-19 ~02:10 · Task 1 done (@devops): commits 903601b + 668e41d; PG 17.6, Kong 8000,
  n8n 5678.
- 2026-07-19 ~02:17 · Tasks 2.4+3+4+5 green (@db-engineer, first pass, 13 smoke DO blocks,
  double-apply idempotency proven). Design addendum: deck required for inbound only
  (radar_activated deckless). Dispatched Tasks 6-8 + deck fix.
- 2026-07-19 ~02:20 · commit 4765f15 (@devops): db/ tasks 2-5; .gitignore += 
  infra/supabase/volumes/ (protective addition — runtime DB data must not be committed).
- 2026-07-19 ~02:25 · Tasks 6-8 + deck fix green (@db-engineer, 36 smoke DO blocks, double
  apply). DEFERRABLE INITIALLY DEFERRED approved for the 2 self-FKs (Task 9).
- 2026-07-19 ~02:30 · **INCIDENT: port collision.** Native host PostgreSQL (pid 619, trust
  auth) binds 127.0.0.1/::1:5432 and shadows the Docker pooler for loopback — ALL schema
  applies landed in the operator's native PG; supabase-db was empty (operator spotted it
  in Studio). Fix in flight: @devops remaps Docker port → 54322 + Commands update;
  @db-engineer does surgical cleanup of native PG (operator approved), re-apply + full
  smoke on real supabase-db, then Task 9.
- 2026-07-19 ~02:33 · Native PG cleanup done (22 tables dropped, zero foreign data, no
  CASCADE needed). Native = PG 16.13 Homebrew, trust auth (left untouched).
- 2026-07-19 ~02:36 · Port remap committed (@devops, 6ca7508): pooler 54322:5432, internals
  unchanged, CLAUDE.md Commands updated (file gitignored). Working DSN confirmed by
  orchestrator: tenant-qualified username `postgres.<POOLER_TENANT_ID>` @ 54322, PG 17.6,
  wrong-password properly rejected. @db-engineer go for re-apply + Task 9.
