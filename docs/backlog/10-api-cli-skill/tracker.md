# Feature 10 — Execution Tracker

> Single writer: the orchestrator (this terminal). Agents report back; they never edit this file.
> Created 2026-07-19 ~09:42, immediately after the plan was finalised and before the first dispatch.

## Task board

| # | Task | Executor | Depends | Status | Result / commit | Notes |
|---|---|---|---|---|---|---|
| A1 | three `api_*` views | @database-engineer | — | **done** (verified) | `db/schema.sql:1216-1578` + `f10_normalize_missing_flags()` | 308/724/109 confirmed; `api_founders` blocked by A1a |
| A1a | fix `radar_candidates` log-domain bug (**feature 02 object**) | @database-engineer | A1 | **done** (verified) | `GREATEST(x,0)` floor on both log args | karma −2 founder now yields obscurity 0.8835 instead of aborting |
| A1c | fix `api_founders` company/application join | @database-engineer | F1a | **dispatched** 10:28 | — | source was `founder_company` (5 fixture rows); real linkage is in `cards` |
| A1b | add `founder_score_gaps jsonb` | @database-engineer | A1 | **done** (verified) | trailing column on `api_founders` | must be trailing: CREATE OR REPLACE VIEW cannot reposition existing columns |
| B1 | `lib/f10/` plan + score + tests | @backend-developer | — | **done** (verified) | `5f2b0f1` · 82 tests pass | got the rev.5 ordering delta before writing `score.js` |
| A2 | smoke.sql view assertions | @database-engineer | A1 | **done** (verified) | `db/tests/smoke.sql`, 10 assertions, 323 lines | guard proven to bite: `log(1+(-2))` still raises |
| C1 | n8n `f10-nl-search` | @n8n-workflow-builder | A1, B1 | **done** (Q1+Q2 live) | wf `x7qXnx2asXrGB0ye` | agent caught 2 real bugs live |
| C1a | re-sync stale `score.js` paste | @n8n-workflow-builder | B1-fix | **done** (verified live) | wf re-exported | Q2 top hit now rank 100; inversion gone |
| D1 | `bin/vcbrain`, 4 commands | @backend-developer | A1 | **done** (3 of 4 verified) | `bin/vcbrain` | envelope + truncation flag confirmed correct; `search` success path still blocked on C1 |
| E1 | live Q1/Q2 acceptance | orchestrator | C1 | **done** (found 1 defect) | both queries pass §5.8 | Q2 top hit had rank 0 → `has_match` fix |
| F1a | `docs/api.md` (views only) | @backend-developer | A1 | **done** (verified) | `docs/api.md`, 409 lines | 4 findings returned; 1 was wrong and I corrected the doc |
| F1b | `skills/vcbrain-cli/SKILL.md` | @backend-developer | C1, D1 | **done** (verified) | 446 lines | every command executed before being written down |
| G1a | QA gate part 1 (views/CLI/api.md) | @qa-engineer | A1,D1,F1a | **GATE FAILED** | `qa-report-10.md` | 1 CRITICAL + 1 MAJOR, both real |
| A1e | obscurity: SQL vs library divergence + `radar_candidates` dedup | @database-engineer | — | **done** (verified) | 0.767/`{gh_followers}`; dup injection 123/123 | ruling: negative karma is UNOBSERVED |
| A1d | **CRITICAL** opt-out dead on `api_applications` | @database-engineer | G1a | **done** (verified) | 308→190 on full opt-out, 0 leaked | single-founder precision confirmed separately |
| G1b | QA gate part 2 + re-verify | @qa-engineer | C1a | **GATE FAILED** (3 MAJOR) | `qa-report-10.md` | search machinery held; 3 new findings, all confirmed |
| A1f | opt-out must be **company**-scoped | @database-engineer | G1b | **done** (verified) | 9→0 scoped; wipe leaks 0 | my spec error: design said company, I dispatched application |
| B2 | `quote_verbatim` fabrication + structural claim join | @backend-developer | G1b | **dispatched** 11:21 | — | 32.5% of supports rows had no real quote |
| H1 | commit DB layer | @devops | A2 | **done** | `b2a7788` (11 files, 2557 ins) | commit only, NOT pushed — `docs/` is tracked and the remote is public |

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

- **09:58** Simulated Q1 against the live corpus before building the pipeline for it. Distribution is good (1 founder matches 4 attributes, 10 match 3, 90 match 2, 17 match 1) — **but running it through the real formula inverted the list**: `rank_score` is match-rate-among-assessed, so one documented match scores 100 while the best founder in the corpus scores 92.5. The confidence floor cannot catch it (1-of-4 = exactly 0.25, rule is `< 0.25`; and 2-of-4-documented = 100 at confidence 0.5). **Three adversarial review rounds missed this because it is invisible in the spec — it only shows up in numbers.**
- **10:00** Review round 4 adjudicated the fix: bucket-then-rank ordering is not fusion (it produces no number; both inputs stay inspectable), but required four corrections — sort an **ordinal integer**, never the bucket string (`'high' < 'low' < 'mid'` alphabetically, so `DESC` yields mid→low→high, silently inverted); bucket on **attribute count**, not weight-normalised confidence (weight-based edges sit on the achievable lattice and diverge under non-uniform weights); **emit** `confidence_bucket` so the order is reproducible from the response; `bucket: null` + rank fallback when `low_confidence_only` fires. All applied → design rev.5. Delta pushed to the backend agent before it wrote `score.js`.

- **10:20** Operator moved the session to autonomous mode: parallelise everything parallelisable. Three tracks now in flight — C1 (n8n), D1 (CLI), F1a (api.md). Pre-push compliance scan run over everything going public: no keys, no JWTs, no closed-source attribution. **Anonymised my own two mentions** attaching "hn_karma = −2" to a named live HN account — the founder UUID is technically sufficient and this repo is public.

- **10:28** F1a returned `docs/api.md` plus four findings. Verified each rather than accepting them:
  - **Real defect (mine):** `api_founders.application_id` is NULL on **all 124** founders and `company_id` on all but 5. §4.1 sourced them from `founder_company`, which feature 02 never writes — it has 5 rows, all 03/05 fixtures. The linkage lives in `cards`: **118 of 124** founders have a founder-card carrying both `application_id` and `company_id`. Round 2's M3 fix correctly killed a fan-out but pointed the join at an empty table; the founder card would have shown no company for 95% of the corpus. Dispatched A1c.
  - **Agent was wrong, doc corrected:** it reported `REVOKE TRUNCATE` "never applied or reverted". Live: `has_table_privilege('anon','scores','TRUNCATE')` = **false**, `claims` = **true** — the revoke IS applied, on exactly the nine tables the schema lists; `claims` is not among them because it is not append-only. It generalised one table to all. Fixed the claim in `docs/api.md` before it stayed in a public doc, and told the db agent not to touch grants.
  - Corpus is live and growing under us (124 founders / 734 claims / 7 contradicts now) — feature 05 is writing in parallel. `api.md` uses measured numbers, not the brief's.
  - `api_claims.axis` is NULL on 654 of 734 rows; documented as measured rather than assumed.

- **10:30** D1 verified independently: `schema` runs with no token/network, `founder` returns real evidence + `what_would_close_it` gaps, missing arg → exit 2 naming the argument, bad id → `not_found` without crashing. **`search`'s success path is still unproven** — `f10-nl-search` returns 404, so only its error degradation is tested. Agent flagged 5 spec gaps and resolved each visibly (two CLI-local error kinds are labelled as such inside `vcbrain schema` output rather than passed off as documented).
- **10:30** Scare, then a tooling finding: an n8n workflow query returned `[]`. **n8n answers a bad API key with 200 + empty array, not 401** — indistinguishable from "everything was deleted", in a repo that already lost work once today. All 8 workflows are present and active; `N8N_API_KEY` lives in `infra/n8n/.env`, not `infra/supabase/.env`. Appended to the backlog TRACKER for the other terminals.

- **10:32** A1c verified end-to-end, not just at the DB: `api_founders` now 124/124/123/118, the `founder_company` preference branch wins on all 5 rows it applies to, smoke green, and the CLI renders company `safehttp` + application id for the demo founder. The fix propagates through every layer.
- **10:32** **Two false alarms of my own, both from bad verification rather than bad code.** I read `company_id` flat when the CLI nests it under `company:{id,name}`, and I counted `len()` of the claims *envelope* (3 keys) instead of `claims.items` (28 rows) — and briefly concluded the CLI was silently truncating, the one thing §6.2 forbids outright. It was not: `--limit 5` correctly returns `items:5, total:28, truncated:true`. Lesson recorded because it nearly cost two spurious fix dispatches: **when a check contradicts a layer already verified below it, suspect the check first.**

- **10:44** **QA gate part 1: FAILED — and it was right.** Reproduced the CRITICAL myself: opting out *every one* of the 124 founders removes **0 of 308** `api_applications` rows. `api_founders` correctly drops to 0 and `api_claims` to 110, but the applications view still gates on `founder_company` — the same empty-table defect A1c fixed in `api_founders` and that I failed to carry across. **The smoke assertion passed only because its fixture hand-inserts a `founder_company` row — it tested a path no real founder takes.** A green test on a dead code path is exactly how this survived. Dispatched A1d, including a rewrite of the test to build the linkage through `cards` like real data does, plus an explicit opt-out-everyone assertion.
- **10:44** QA's MAJOR was also right: A1c invalidated `docs/api.md`'s own prose (it still said `application_id` was 0/124 and blamed a corpus gap, when the cause was my view defect and the real fill is 118/124). Corrected in place — the doc is public, so a wrong explanation there is a live defect, not a typo.

- **10:57** Feature 10 fully pushed (`91c984a`, 14 files). **Near-miss checked, not assumed:** the rebase stashed other terminals' uncommitted work and restored it. Verified straight away — stash list empty, 05/08/09/`lib/f05`/`lib/f08`/`web` all intact. Same operation class that destroyed hours of work at ~06:45; noted in the backlog TRACKER for the others.
- **10:57** New trap from F1b, not in the design: the resolver's **`unresolvable` segmentation is non-deterministic** — the same reference query split "enterprise traction" into one attribute on one run and two on the next. Expected fallout of `gpt-5.6-luna` refusing `temperature: 0`; we had reasoned about plan *composition* varying but not phrase *segmentation*. No effect on ranking (weights and scoring are deterministic by construction), recorded as a consumer-facing trap in the skill.

- **11:10** A1e — cross-feature defect routed in by the operator: `radar_candidates` and `lib/f02/obscurity.js` disagreed on negative HN karma. Measured the divergence rather than trusting the report, and it narrowed usefully: **only the `< 0` branch differs**; zero karma already agreed on both sides (`isObserved` is `v >= 0`), so a blanket "fix the karma term" would have broken what was already consistent.
  **Ruling: negative karma is UNOBSERVED** — term NULL, excluded from the mean, `hn_karma` dropped from the basis. Reasoning beyond consistency: the metric maps *positive visibility* onto obscurity, so its domain is karma ≥ 0; a negative value says the person was **seen and poorly received**, which is a fact about reception, not discovery. Calling them maximally obscure asserts nobody found them — demonstrably false. The term is undefined, not extremal, and the view's own rule ("absence must shrink the term count, never contribute a value") applies literally. Verified: `0.767`/`{gh_followers}` from SQL, byte-identical to the library.
  **I was wrong about the second item and the injection test proved it.** I called the duplicate-card risk "latent" because no founder currently has two founder cards. `api_founders` was indeed already safe (A1c's `DISTINCT ON`), but `radar_candidates` itself was **live-broken** — injecting a duplicate card returned two rows blending different `company_id`/`application_id`. Reading the SQL would have confirmed my wrong conclusion; only the injection caught it. Post-fix: 123/123 distinct. `freshness` is exposed to this on `radar_candidates` (it is not a column of `api_founders`) — flagged for feature 09.

- **11:21** QA round 2 did the thing a gate is for and that I had not done: it **re-attacked the boundary around my fix rather than the fix itself**, after first proving the new assertions actually fail against the old bug (`v_leaked = 118`, round 1's exact number). Found that A1d protects an application carrying a founder card, while **104 of 308** applications belong to a company with a known founder and carry no card of their own — surviving that founder's opt-out. **My specification error:** design §4 says "every current founder **of the company**"; my A1d dispatch said "linked to **it**". The implementer built exactly what I asked for.
- **11:21** My own repro for that finding was also wrong, in a way the project has already documented: I filtered by `companies.name`, and there are **4 distinct companies named "safehttp"** (also `puffinsoft` ×3, and others). That is 02's inherited "never key identity on `companies.name`" gotcha, biting the person who copied it into his own design doc. Correct check, scoped by `company_id`: 9 → 0.
- **11:21** Worth recording as method: the agent temporarily re-applied the **old** view and confirmed `smoke.sql` failed loudly before restoring the fix — and separately noticed its own earlier fixture had become semantically wrong under company scoping (an "untouched sibling" that was a co-founder of the same company legitimately keeps its applications visible). Both are the discipline that makes a green test mean something.

## Open cross-feature items to report at close

- `scores(axis='founder')` has **0 rows** — 04 owns that axis and never wrote it. Surfaces as `assessed: false` on every application. Belongs in the backlog TRACKER.
- `claims.verification_status='verified'` is **0** database-wide (05 not built), so verification cannot be a ranking signal in this build.
