# Feature 10 — Execution Tracker

> Single writer: the orchestrator (this terminal). Agents report back; they never edit this file.
> Created 2026-07-19 ~09:42, immediately after the plan was finalised and before the first dispatch.

## Task board

| # | Task | Executor | Depends | Status | Result / commit | Notes |
|---|---|---|---|---|---|---|
| A1 | three `api_*` views | @database-engineer | — | **done** (verified) | `db/schema.sql:1216-1578` + `f10_normalize_missing_flags()` | 308/724/109 confirmed; `api_founders` blocked by A1a |
| A1a | fix `radar_candidates` log-domain bug (**feature 02 object**) | @database-engineer | A1 | **done** (verified) | `GREATEST(x,0)` floor on both log args | karma −2 founder now yields obscurity 0.8835 instead of aborting |
| A1b | add `founder_score_gaps jsonb` | @database-engineer | A1 | **done** (verified) | trailing column on `api_founders` | must be trailing: CREATE OR REPLACE VIEW cannot reposition existing columns |
| B1 | `lib/f10/` plan + score + tests | @backend-developer | — | **dispatched** 09:45 | — | wave 1, pure/fixture-driven |
| A2 | smoke.sql view assertions | @database-engineer | A1 | **done** (verified) | `db/tests/smoke.sql`, 10 assertions, 323 lines | guard proven to bite: `log(1+(-2))` still raises |
| C1 | n8n `f10-nl-search` | n8n agents | A1, B1 | pending | — | resolver spec already written |
| D1 | `bin/vcbrain`, 4 commands | @backend-developer | A1, C1 | pending | — | first to cut if clock bites |
| E1 | live Q1/Q2 acceptance | orchestrator | C1 | pending | — | §5.8 criteria |
| F1 | skill + api.md | @backend-developer | D1 | pending | — | written LAST by design |
| G1 | QA gate | @qa-engineer | F1 | pending | — | independent, no dev-test reuse |
| H1 | commit DB layer | @devops | A2 | **dispatched** 09:54 | — | commit only, NO push — `docs/` is tracked and the remote is public |

## Design/spec phase — closed

| Item | Status |
|---|---|
| Phase 0 sources (intel base · brief · NotebookLM ×2 · Exa ×2 · OSS · live DB ×4) | done |
| `design.md` rev.1 → rev.4 | done |
| Spec review rounds 1 / 2 / 3 | done — all findings applied |
| Resolver agent artifacts (5 files, `ai-agent-builder`) | done, patched for F7 + kind cut |
| `plan.md` | done (plan-reviewer round deliberately skipped — rationale in plan.md) |

## Event log

- **09:00** Phase 0 opened. Intel base: **no sponsor mandate for API/CLI/MCP exists** — the only rubric-scored part of this feature is FAQ-12's one-pass compound query.
- **08:55–09:10** Live DB measured. Structural columns are empty (`founders.location_*` 0/122, `companies.hq_country` 0/198); searchable substance is 615 `founder.*` claims over 92 founders.
- **09:05** Operator: scope **A**; demo shows **both** Q1 (corpus-fitted) and Q2 (brief verbatim, honest degradation).
- **09:10** Coordinated with terminal 08. Its warning about `radar_candidates` NULLs for inbound founders folded into §4.1; `purge_founder()` confirmed out of scope for 10.
- **09:20** Review round 1: `submit` cut (schema `stage NOT NULL` would fail every call) → feature became read-only. Executor path corrected — repo has no Postgres driver.
- **09:28** Review round 2: **inverted opt-out filter** caught (would have served only opted-out people, or nothing); **rank formula made `unknown` penalise like `mismatch`** — REQ-003 inverted. Both fixed.
- **09:38** Review round 3: **`tier_credit` ignored `evidence.relation`, so contradicting evidence raised the match score** (3 `contradicts` + 104 `context` rows already live). Fixed to `supports`-only. `velocity`/`text` kinds cut.
- **09:45** Wave 1 dispatched: A1 + B1 in parallel.
- **09:47** A1 returned. Three views + a normalisation helper landed; `api_applications` 308, `api_claims` 724 (109 of them company-scoped, i.e. the F1 anti-join works). **Agent surfaced a blocking bug it correctly refused to fix unilaterally.**
- **09:48** Verified the bug myself: `radar_candidates` computes `log(1 + hn_karma)` with no domain guard, one founder has a real `hn_karma = -2`, and any query materialising `obscurity` aborts. `count(*)` alone survives (planner prunes the column) — which is why 02's smoke tests never caught it. Blocks 09's dashboard and 02's own feed too. **Authorised the fix under this feature** (02 is closed, no live terminal); announced in the backlog TRACKER.
- **09:48** A1 also caught a **real error in my design**: `founder_score.missing_flags` is an array of OBJECTS `{criterion_id, what_would_close_it}`, not strings. Design corrected; adding `founder_score_gaps` so `what_would_close_it` is not thrown away.
- **09:49** A1a/A1b verified independently: 122/122/3, 308, 724 (109 company-scoped), and **`GET /rest/v1/api_founders` returns 200 through Kong** — the views are live over PostgREST, not just valid SQL. `score_market` renders as `{"value": null, "assessed": false}`, i.e. an absent axis reads as "not assessed", never zero. `apply.sh` idempotent on a 3rd run; `smoke.sql` still green.

- **09:54** A2 verified independently: smoke exits 0, 97 DO blocks, zero ERROR/FAIL, zero fixture rows left behind. Went further than the agent and **proved the regression guard actually bites** — `log(1 + (-2))` still raises, so reverting the `radar_candidates` fix aborts the whole suite instead of passing silently. DB layer handed to @devops (commit only; `docs/` is tracked and the remote is public, so nothing is pushed until the operator rules).

## Open cross-feature items to report at close

- `scores(axis='founder')` has **0 rows** — 04 owns that axis and never wrote it. Surfaces as `assessed: false` on every application. Belongs in the backlog TRACKER.
- `claims.verification_status='verified'` is **0** database-wide (05 not built), so verification cannot be a ranking signal in this build.
