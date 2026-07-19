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
| B2 | `lib/f05/verifiers.js` + `entity_gate.js` | @backend-developer | — | **in progress** | | entity gate = the >80% FP guard; gate step 3 left as an unimplemented hook |
| C2 | agent specs (contradiction-detector, entity-matcher) | @backend-developer + `ai-agent-builder` | — | **in progress** | | moved before n8n so builder is never blocked |
| D1 | labelled fixture | @database-engineer | — | **in progress** | | **pulled forward from T3** — depends on design only; takes load off the QA wave |
| — | **commit checkpoint: db/schema.sql, seed.sql, smoke.sql** | @devops | A1 | pending | | same-hour rule; before T1 dispatch |
| **T1 — runner** |
| B3 | `lib/f05/run.js` | @backend-developer | A1,A2,B1,B2 | pending | | owns the 5 previously-unowned design elements |
| **T2 — n8n + paid branch** |
| C1a | generator + `f05-trust-rollup` | @n8n-workflow-builder | B3 | pending | | the only workflow 06 is blocked on |
| C3 | `factual_dynamic` Tavily branch | @backend-developer | B3 | pending | | ∥ with C1a |
| C1b | `f05-verify-claims` + `f05-contradiction-scan` | @n8n-workflow-builder | C1a, C3 | pending | | |
| **T3 — calibration, QA, close** |
| D1 | labelled fixture | @database-engineer | B3 | pending | | ∥ with D2 |
| D2 | `min_coverage` calibration | @database-engineer | A1,B1 | pending | | acceptance is a number, not a note |
| D3 | QA gate + feature-07 regression check | @qa-engineer | D1,D2,C1b | pending | | `qa-report-05.md`, loop until PASSED |
| D4 | close: commit, `NOTICE`, `done.md`, TRACKER rows | @devops | D3 | pending | | NOTICE names both Apache-2.0 sources |

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
