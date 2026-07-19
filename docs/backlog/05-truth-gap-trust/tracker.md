# 05 · Truth-Gap Check & Trust Score — Execution Tracker

> Single writer: the **orchestrator session**. Agents report to the orchestrator; they never edit
> this file. Updated on every dispatch, completion, failure and commit.
> Plan: [`plan.md`](plan.md) (v2) · Design: [`design.md`](design.md) (approved, 3 review rounds)

## Status: plan v2 in review · builders not yet dispatched

**Scope ruling (operator, T-5h00m): nothing is cut.** Plan review recommended dropping the Tavily
and LLM branches; operator overrode. Full scope stands; time is bought back from ordering,
parallelism and a headless runner instead.

---

## Task board

| # | Task | Executor | Depends | Status | Result / commit | Notes |
|---|---|---|---|---|---|---|
| **T0 — seven-way parallel · dispatched ~11:00** |
| A1 | `claim_trust` view, `f05_host()`, `trust_v1` config row, smoke | @database-engineer | — | ✅ **done** | view live, all 4 acceptances re-verified by orchestrator | Parity 724=724 · **0 verified on expertise/leadership** (the regression holds) · `provenance`+`tech` → `contradicted`, `expertise.insight` → `unverified` with 0 penalty. Audited the 135 `verified`: **all `factual_static`/`factual_dynamic`, zero judgement claims.** Router split matches design estimate (qualitative 424 vs ~430 predicted). Agent added a `precomputed` cap branch keyed on RAW `n_contradicts` so 04's mismatch can never reach `contradicted` even if written at documented tier — good call, §7.4 lacked an explicit row |
| A2 | `lib/f05/router.js` | @backend-developer | — | ✅ **done** | `lib/f05/router.js` + test, 18/18 green | Verified by orchestrator: tests re-run, zero-import check clean. Exports `routeClaimTopic` + `routeClaims`; no built-in prefix map, config is a required param |
| A3 | `lib/f05/quote_guard.js` | @backend-developer | — | ✅ **done** | `lib/f05/quote_guard.js` + test, 16/16 green | Verified by orchestrator. Call site measured: **44 claims**, not ~0. Agent caught a contradiction in the brief (`90 days`→`30 days` IS the duration branch I had dropped) → **duration reinstated, all 4 branches ship**; design §5.1(a) corrected with the reason. Also fixed a real upstream bug: Python's `_currency_to_float` mis-strips a `MM` suffix (`$50MM` → `50m` → `float()` throws → the amount silently drops out of comparison). **→ QA report.** ⚠️ **Handoff note for `done.md`, verbatim:** until `f05-verify-claims` actually calls `quoteSalienceMismatches()` per claim and turns a non-empty result into evidence/events, nothing may claim this check "runs" — not the memo, not the video |
| B1 | `lib/f05/trust.js` (rollup math) | @backend-developer | frozen column contract | ✅ **done** | `lib/f05/trust.js` + test, **22/22 green** | Verified by orchestrator: tests re-run, the single `require(` hit is a comment. Five flags raised, all ruled: **(3) `coverage` now persisted inside `missing_flags`** — §14.1 makes it a display requirement, and the scores row is a snapshot while the view is live, so recomputing would drift · `trend` correctly omitted (no formula defined) · topic-level dedup kept · §8.1 implemented as a tested JS predicate, now authoritative for B3. ⚠️ **Open: view column names are B1's assumption** — reconcile against A1's actual `CREATE VIEW` before B3 |
| B2 | `lib/f05/verifiers.js` + `entity_gate.js` | @backend-developer | — | ✅ **done** | 4 files, **75/75 green** (26 gate + 49 verifiers) | Verified by orchestrator; live transactional test left **zero** persisted rows. ⚠️ **Honest finding: GitHub provenance has no live input** — the corpus holds repo metadata, profiles and PR-search results but **no commit-level signal**, so `checkGithubProvenance` returns `insufficient_data` on every real claim today. Function is correct and tested against both the real API shape and the one live simplified shape. Demo provenance beat therefore rests on D1's fixture, not the live corpus — **must not be claimed otherwise.** Ruled: denominator extraction writes no evidence row (it analyses the claim's own text, has no `raw_signal_id` to attach, and a NULL FK would break our own binding rule) |
| C2 | agent specs (contradiction-detector, entity-matcher) | @backend-developer + `ai-agent-builder` | — | ✅ **done** | `agents/contradiction-detector.md`, `agents/entity-matcher.md` | Both via `ai-agent-builder`. K=2 correctly placed as the CALLER's job, not the agent's. entity-matcher gets the deliberately narrowest input in the feature (quote + name hints only, no claim/question/tier) so the model cannot rationalise a match from surrounding context — closes the homonym trap. `ai_runs.confidence` NULL stated in both. 2 open wiring questions → C1b |
| D1 | labelled fixture | @database-engineer | — | ✅ **done** | `db/fixtures/05-truth-gap.sql`, 10 claims / 11 evidence / 11 raw_signals | **Pulled forward from T3.** ⭐ **All 10 expectations matched the live view exactly** — independent cross-validation of A1's view by a different agent from the same design. Includes the three cases no live row covers: missing+documented-contradiction stays `missing` (the AVeriTeC guard), qualitative+documented-contradiction stays `unverified`, Tier-3-only never reaches `verified`. Every `raw_signals` row carries an FK; every `evidence` row has `raw_signal_id` |
| — | **commit checkpoint 1** | @devops | A1 | ✅ **done** | `f0c2b90` | schema+seed+smoke+lib/f05 core; nothing pushed, `.env` not staged |
| **T1 — runner** |
| B3 | `lib/f05/run.js` | @backend-developer | A1,A2,B1,B2 | ✅ **done** | `run.js` + `run.test.js`; full f05 suite **147/147** | All 8 acceptances re-verified by orchestrator on live DB: trust rows written & idempotent (19.50 across runs), GDPR anti-join **0**, personal-data leak **0**, `ai_runs.confidence` all NULL, duplicate `content_hash` **0**. **Caught 2 real bugs pre-ship:** (1) the application-fallback event branch leaked `entity_match.quote` — the acceptance SELECT alone would have stayed 0 while shipping the bug; only its own unit test caught it; (2) the quote_guard candidate query matched `contradicts` rows instead of the claim's own `supports` citations, manufacturing 2 spurious mismatches. Honest: **74/74 live `gh_provenance` checks return `insufficient_data`**, no verdict fabricated |
| B4 | commit-level GitHub ingestion (added mid-build) | @backend-developer | — | **in progress** | | Operator supplied a PAT (5000/hr verified live). Closes the provenance data gap on the 34 founders holding both GitHub and Show HN signals |
| — | **commit checkpoint 2** | @devops | B3 | ✅ **done** | `8895ae9` | runner, entity gate, verifiers, fixture, agent specs. Verified: `.env` absent from the commit, nothing pushed |
| **T2 — n8n + paid branch** |
| C1a | generator + `f05-trust-rollup` | @n8n-workflow-builder | B3 | **in progress** | | the only workflow 06 is blocked on; acceptance is a SELECT, never n8n's success status |
| C3 | `factual_dynamic` Tavily branch | @backend-developer | B3 | **in progress** | | ∥ with C1a |
| C1b | `f05-verify-claims` + `f05-contradiction-scan` | @n8n-workflow-builder | C1a, C3 | pending | | also owns entity-gate step 3 (the LLM matcher hook) |
| **T3 — calibration, QA, close** |
| D2 | `min_coverage` calibration | @database-engineer | A1,B1 | pending | | acceptance is a number with the count behind it, not a note |
| D3 | QA gate pass 1 — deterministic core | @qa-engineer | B3 | **in progress** | | started early, ∥ with T2 (recovers ~90 min; 04's gate measured 130 min) |
| D3b | QA gate pass 2 — LLM/Tavily paths + feature-07 regression | @qa-engineer | C1b, C3 | pending | | `qa-report-05.md`, loop until PASSED |
| D4 | close: commit, `NOTICE`, `done.md`, TRACKER rows | @devops | D3b | pending | | NOTICE names both Apache-2.0 sources (`due-diligence-agents`, `reporting`) |

---

## Event log

| Time | Event |
|---|---|
| ~08:51 | Phase 0 opened. Six source agents dispatched in parallel (01/03/04 contracts, intel+OSS, NotebookLM, Exa). |
| ~08:55 | Live DB measured: 724 claims (652 unverified / 72 missing), 672 evidence, 846 raw_signals, 44 `self_asserted` verdicts, 24 red-flag runs, 3 `contradicts` rows. |
| ~09:05 | Operator picked **approach B** (full claim router) over recommended A. Re-verified against sources — B is the stronger answer to the NEE-mislabelling risk, since the "cannot bear a verdict" decision becomes structural. |
| ~09:30 | `design.md` written; spec review round 1 dispatched. |
| ~09:45 | **Round 1 ❌ — 10 blocking.** Headline: the qualitative guarantee was false; 373 sourced supports from 02/04/07 would have rendered as `verified` on day one. Confirmed against live DB, then fixed in the view. |
| ~10:05 | **Round 2 ❌ — 6 new.** Headline: the round-1 fix suppressed `founder.execution.tech`, a real documented contradiction, for want of a prefix catch-all. Fixed. |
| ~10:20 | **Round 3 ✅ APPROVED.** Cosmetic sweep applied. Operator approved the spec. |
| ~10:35 | `plan.md` v1 → plan review ❌: 6.5–8h of work against ~5h20m, and no headless runner (03's recorded trap). |
| ~10:45 | **Operator ruling: nothing is cut.** Plan v2 written — runner added, T0 widened to six parallel tasks, C1 split, five unowned design elements assigned, feature-07 collision recorded. Round 2 review dispatched. |

---

## ⚠️ Column-contract reconciliation — B3 must handle this

A1's shipped view and B1's assumed contract differ in two places. Neither module is wrong; **the
adaptation belongs in B3's query layer**, not in either module.

Actual view columns:
`claim_id, card_id, topic, axis, text_verbatim, source_kind, verification_status, router_class,
n_supports, n_contradicts, n_contradicts_counting, n_independent, base, independence_factor,
contradiction_penalty, trust, derived_status`

| B1 expects | View provides | B3's fix |
|---|---|---|
| `class` | `router_class` | alias `router_class AS class` |
| `card_application_id`, `card_company_id`, `card_founder_id` | only `card_id` | join `cards` and supply the three fields — B1's §8.1 scope predicate needs them |

## Open risks carried into build

1. **Time.** Full scope against a measured precedent of 6.5–8h. Mitigated by ordering (core first,
   committed before the LLM/Tavily branches) — not eliminated.
2. **Feature 07 collision.** 07 reads `claims.verification_status` live; our write-back can change a
   closed feature's gate verdicts. D3 carries the regression check.
3. **`min_coverage` uncalibrated.** Inherited 0.25 was sized for a different denominator. D2 owns it
   or it locks by default.
4. **04's flagship contradiction has never fired live.** The demo uses two real documented
   contradictions instead (`founder.execution.provenance`, `founder.execution.tech`).
5. **`quote_guard` may have no call site.** A3 measures before building; if ~0, it must not be
   claimed as running in the video.
