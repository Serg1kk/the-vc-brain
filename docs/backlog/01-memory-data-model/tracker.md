# 01 · Memory & Data Model — Execution Tracker

> Plan: [plan.md](plan.md) (✅ approved by implementation-plan-reviewer, round 3, 2026-07-19).
> Spec: [design.md](design.md). **Single writer of this file: the orchestrator (main
> session).** Agents report to the orchestrator; the orchestrator updates statuses on every
> dispatch/completion/failure. Purpose: full recovery picture after any crash.

## Task board

| # | Task | Executor | Depends on | Status | Result / commit | Notes |
|---|------|----------|-----------|--------|-----------------|-------|
| 1 | Supabase self-hosted up (`infra/supabase/`) | @devops | — | in_progress | | ∥ with Task 2 steps 1-3 |
| 2 | Repo scaffolding `db/` + CLAUDE.md Commands | @database-engineer | Step 4 waits on 1 | in_progress | | steps 1-3 ∥ Task 1 |
| 3 | Registries + seeds | @database-engineer | 1, 2 | pending | | sequential 3→8 |
| 4 | Identity core (+FTS founders/companies) | @database-engineer | 3 | pending | | |
| 5 | Funnel (applications, theses) | @database-engineer | 4 | pending | | |
| 6 | Evidence ledger (+claims.search_tsv) | @database-engineer | 5 | pending | | |
| 7 | Intelligence (scores, ai_runs) | @database-engineer | 6 | pending | | |
| 8 | Interview, experience & ops | @database-engineer | 7 | pending | | |
| 9 | Enforcement (triggers, purge_founder) | @database-engineer | 3-8 | pending | | R1 two-predicate bypass; R2 subtree rule; FK delete-order advisory |
| 10 | Cold-start reset proof + REST checks | @database-engineer | 9 | pending | | |
| 11 | Handoff docs (`db/README.md`) + final commit | @database-engineer → @devops | 10 | pending | | ∥ with 12 |
| 12 | Adversarial QA gate (`qa-report-01.md`) | @qa-engineer | 10 | pending | | ∥ with 11 |

## Event log

- 2026-07-19 · plan approved by reviewer (3 rounds: 2C+5M+4m → 2M+2m → ✅); FK cross-subtree
  advisory folded into Task 9.
- 2026-07-19 · tracker created; dispatched @devops (docs commit → Task 1) and
  @database-engineer (Task 2 steps 1-3).
