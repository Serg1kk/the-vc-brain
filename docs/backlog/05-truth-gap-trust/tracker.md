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
| B4 | commit-level GitHub ingestion (added mid-build) | @backend-developer | — | ✅ **done** | `lib/f05/ingest_commits.js`; **31 commit-level signals** written | Operator supplied a PAT (5000/hr, verified live). Orphan-FK count unchanged at 9; idempotent re-run inserts 0. ⭐ **Honest result: 32 real founders checked, 31 clean, 1 insufficient_data, ZERO flagged.** The agent ran all 32 rather than sampling, and explicitly declined to hunt for a flaggable case to force into the demo. This is the better outcome — the check is live on real people and produces **no false accusations**, which was the feature's primary risk. Also surfaced a 4th instance of feature 02's known founder/company dedup gap (two founders resolving to one repo); our `content_hash` collapsed it correctly |
| — | **commit checkpoint 2** | @devops | B3 | ✅ **done** | `8895ae9` | runner, entity gate, verifiers, fixture, agent specs. Verified: `.env` absent from the commit, nothing pushed |
| **T2 — n8n + paid branch** |
| C1a | generator + `f05-trust-rollup` | @n8n-workflow-builder | B3 | ✅ **done** | n8n id `Wtd887vYwv5x3FvH`, 17 nodes, **active** | Verified by orchestrator: live row `558883f6…` = **19.50 / 0.43 / 12**, identical to `lib/f05/run.js` — the Code-node inlining has not drifted from the tested module, which is the whole point of the generator. Executions API confirms every node on the taken branch ran and the insufficient-evidence branch correctly did **not**. Exported JSON carries secrets only as `$env.*`, zero literals. ⚠️ **Cross-feature find → recorded in the shared tooling changelog: `globalThis.crypto` is UNDEFINED in the n8n task-runner sandbox**, contradicting the project's own standing guidance; `docker exec` prints `object` on the same container because it is a different global scope. Use `require('crypto')` |
| — | **commit checkpoint 3** | @devops | B4, C1a | ✅ **done** | `875f4ae` | Triggered early and deliberately, right after the project's **second** data-loss event (~11:00, feature 08 lost an hour to a stray `git reset` from another terminal). Dispatched with an explicit ban on pull/rebase/stash/reset/checkout/clean. Verified: nothing pushed, `.env` unstaged, other terminals' files untouched |
| C3 | `factual_dynamic` Tavily branch | @backend-developer | B3 | **in progress** | | ∥ with C1a |
| C1b | `f05-verify-claims` + `f05-contradiction-scan` | @n8n-workflow-builder | C1a, C3 | pending | | also owns entity-gate step 3 (the LLM matcher hook) |
| **T3 — calibration, QA, close** |
| D2 | `min_coverage` calibration | @database-engineer | A1,B1 | pending | | acceptance is a number with the count behind it, not a note |
| D3 | QA gate pass 1 — deterministic core | @qa-engineer | B3 | ⛔ **GATE BLOCKED** → 2 findings, both in fix | `qa-report-05.md` | Started early ∥ with T2. **F1 CRITICAL, confirmed by orchestrator on live data:** scope route 2 matched on company alone without excluding cards owned by a *sibling* application (route 3 had the guard, route 2 did not). **104/308 applications (34%)** own no cards while their company has cards elsewhere → each would silently inherit a sibling's evidence. Demonstrated with a real write: an application owning **zero** cards produced a confident `value=62.71, coverage=1.0`. **F2 MAJOR, dormant:** `quote_guard` false-positives on numeric ranges (`$1-2 million` — only the second number extracted) and on ordinary true negations ("does not currently generate revenue") → −0.30 penalty on a TRUE claim, the exact harmful-flip mode §12 exists to catch; the entity gate cannot catch it because the check reuses the claim's own `raw_signal_id`. Helpful fixes 2/2, harmful flips 0/4 on the fixture — but that 0% does not cover F2's class |
| FIX1 | scope-leak fix (`trust.js` route 2 + design §8.1) | @backend-developer | D3 | ✅ **done** | `trust.js` 23/23 green | Route 2 now requires `card_application_id IS NULL OR = ctx.applicationId`. Verified: the leaking application went `scoped 28 → 0` and now writes **no** `scores` row, only `trust_rollup_insufficient_evidence`. Medows regression clean — still exactly 19.50 / 0.43 / 12, so the fix narrows without over-narrowing. `run.js` needed no change: it over-fetches deliberately and delegates all scoping to `trust.js` |
| FIX2 | `quote_guard` range + negation fix | @backend-developer | D3 | 🔁 **2(a) closed · 2(b) reopened** | 23/23 at first pass | **2(a) ranges: fixed and independently re-verified.** **2(b) negation: only the reported case was closed, not the class** — `negationPredicateWords()` matches on up to 4 loose nearby words rather than on the negated relationship, so an incidental word collision flags a TRUE claim ("no paying customers… do not charge for the beta" vs a source mentioning "closed beta"). Same `contradicts` write path, same −0.30 penalty on an ordinary honest pre-seed disclosure. Sent back with an explicit fallback: require the negated predicate itself, **or disable the negation branch entirely** and say so. Three solid numeric checks plus an honest "we don't do negation" beats a fourth that accuses truthful founders |
| — | over-narrowing note (from QA's attack on FIX1) | orchestrator | — | ✅ recorded | | QA searched the live corpus for shapes where the route-2 restriction would wrongly EXCLUDE a claim — **zero found today**. Theoretical shape stands: if a company is ever re-screened under a second application expected to inherit an enduring company-level card, that claim is now excluded. → note to 06/09, not a live bug |
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

## 🔴 KNOWN-OPEN: one stale pre-fix score row, deliberately NOT deleted

`scores.id = 7e0c43c0-6e61-486c-b1ba-642211ace2fb` — `value=62.71, confidence=0.70` on application
`9f0268d3-…`, which owns **zero cards**. It was written by QA's own live demonstration of finding 1,
six minutes before the fix landed. It is the only such row (verified across the whole table).

**Decision: leave it.** We could delete it — the session connects as `postgres` and the append-only
trigger has a bypass — but that bypass exists for GDPR erasure, and quietly using it to tidy a demo
is precisely the behaviour this feature is built to prevent. We claim an append-only guarantee to
the judges; we do not break it for cosmetics.

**Design gap this exposed, worth stating honestly:** a wrongly-computed score **cannot be retracted**.
`scores` is append-only, and "absence ≠ zero" (§8.2) forbids writing a corrective placeholder over
it. Post-MVP this needs either a `superseded_by` column or a retraction event type.

**Defensive rule for 06 and 09 — carry into `done.md`:** do not render a `scores(axis='trust')` row
whose application has no claims in scope per §8.1. A trust row is only meaningful alongside the
`input_claim_ids` that produced it; an empty or stale one must not be displayed.

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
