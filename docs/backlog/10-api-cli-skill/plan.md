# Feature 10 — Implementation Plan

> Against `design.md` **rev.4** (3 spec-review rounds, all findings applied). 2026-07-19 ~09:42.
> Scope A: NL-search deep, CLI and skill thin. Feature is **read-only** — no data writes anywhere.
>
> **Process deviation, stated deliberately:** the separate @implementation-plan-reviewer round is
> **skipped**. The design reviewer already assessed buildability across three rounds, produced the
> task decomposition and the dispatch order below, and closed with "dispatch the §4 views and
> resolver spec tracks now". At T-6h a second review round of a plan derived mechanically from an
> already-thrice-reviewed design buys less than the 30 minutes it costs. Design review round 3's
> estimate stands: ~5h of work incl. the F1–F7 fixes, with the `velocity`/`text` cut taken.

## Stages and parallelism

```
WAVE 1  (parallel — no shared files)
  A1  db/schema.sql: three api_* views          → @database-engineer
  B1  lib/f10/score.js + plan.js + tests        → @backend-developer   (pure, fixture-driven)

WAVE 2  (needs wave 1)
  A2  db/tests/smoke.sql: view assertions       → @database-engineer
  C1  n8n workflow f10-nl-search                → n8n-requirements-orchestrator
                                                  → n8n-workflow-builder

WAVE 3  (needs wave 2)
  D1  bin/vcbrain — 4 commands                  → @backend-developer
  E1  live Q1/Q2 acceptance                     → orchestrator + @qa-engineer

WAVE 4
  F1  skills/vcbrain-cli/SKILL.md + docs/api.md → @backend-developer  (written LAST, by design)
  G1  QA gate                                   → @qa-engineer
  H1  commits                                   → @devops
```

A1 and B1 share no file: A1 touches `db/schema.sql` only, B1 touches `lib/f10/` only.

## Tasks

| # | Task | Executor | Depends | Acceptance |
|---|---|---|---|---|
| **A1** | Three views in `db/schema.sql` under `-- Feature 10:` — `api_founders`, `api_applications`, `api_claims`. Anti-join opt-out/tombstone rule with per-view subject resolution (design §4, F1). `DISTINCT` radar subselect. `first_seen_at` re-derived CTE. `missing` normalised per-axis. Thesis state from `thesis_evaluations`. | @database-engineer | — | `./db/apply.sh` twice clean; each view returns >0 rows; `api_founders` exactly 122 rows (one per founder) |
| **A2** | `db/tests/smoke.sql` assertions under `-- Feature 10:` — the §9 view list, **positive cases first** | @database-engineer | A1 | `psql -f db/tests/smoke.sql` green |
| **B1** | `lib/f10/plan.js` (validate plan → PostgREST descriptors) + `lib/f10/score.js` (pure `(plan, rows) → ranked`) + `*.test.js` covering every §9 scorer case | @backend-developer | — | `node --test lib/f10/*.test.js` green; the B2 regression case explicitly present |
| **C1** | n8n `f10-nl-search`: webhook → build catalogue → LLM resolver (`gpt-5.6-luna`, no `temperature`, structured output per the agents/ schema) → PostgREST fetches → scoring → response | n8n agents | A1, B1 | live POST returns the §5.6 shape |
| **D1** | `bin/vcbrain` — `schema`, `search`, `founder <id>`, `application <id>`; clispec envelope + error kinds | @backend-developer | A1, C1 | all four run; `schema` works with `VCBRAIN_TOKEN` unset |
| **E1** | Live acceptance: Q1 ranked with evidence, Q2 honest degradation | orchestrator | C1 | §5.8 criteria met |
| **F1** | `skills/vcbrain-cli/SKILL.md` + `docs/api.md`, incl. the §3.2 write-scope disclosure verbatim and the full traps list | @backend-developer | D1 | documents only what exists |
| **G1** | QA gate — independent adversarial pass, must not reuse dev tests | @qa-engineer | F1 | `qa-report-10.md`, GATE PASSED |
| **H1** | Commits (per-task-group, paths only, no `git add -A`) | @devops | each group | pushed nowhere without operator ruling |

## Cut order if the clock bites

1. D1 CLI (skill documents `curl` instead — still reads as agent-first access)
2. F1's `api.md` (skill alone carries it)
3. Never: A1, B1, C1 — that trio is the rubric claim.

## Shared-file discipline

`db/schema.sql` and `db/tests/smoke.sql` are edited by four terminals. Append under the
`-- Feature 10:` marker, never read-modify-write the whole file, and commit via @devops **the same
hour** the work is done — the ~06:45 incident lost hours of three features' DDL that lived only in
a working tree.
