# QA Report — 06 · Investment Memo & $100K Decision

> **Scope: FAST positive-flow smoke** (operator directive, 2026-07-19 ~14:20 — "quick, the positive
> flow is enough, not a 40-min adversarial pass"). Backed by the live evidence T6 + T6b already
> produced (18 real generations across two apps). Verified by the orchestrator against the live DB +
> the deployed workflow, independent of the builders' own test runs.

**Verdict: ✅ GATE PASSED.**

## What was verified (live, deployed workflow `iLzZ0he48v4WowMS`, active)

| Check | Result |
|---|---|
| Unit suite `lib/f06/*.test.js` (glob form) | **118/118 green** (43 decision · 35 context · 40 assemble) |
| Workflow deployed + active | yes, 19 nodes |
| Memo generates end-to-end (positive flow) | yes — 16+ real memos written across tracewire + Medows |
| **All 5 required sections present** (snapshot, hypotheses, swot, problem_product, traction) | 5/5 on every sampled row |
| **Deterministic recommendation** ∈ {proceed, proceed-with-conditions, pass, watchlist} | yes — Medows D2·watchlist (trust 19.5<40), tracewire D3·watchlist (thesis unresolved) |
| **No uncited fact renders (I3)** | `cited_claim_ids` = 13, all 13 resolve to real `claims` rows, **UNCITED = 0** (latest tracewire memo) |
| **Honest gaps, no fabrication (I4)** | `gaps.not_disclosed` = `["Cap table: not disclosed.", "Revenue: not disclosed."]` |
| **Deterministic conflict-arbitration rationale** | present: *"Not enough is known to decide responsibly in 24h (thesis verdict is unresolved) — an honest unknown, not a silent pass."* |
| Deep-dive "Where to dig" questions | 5–7 per memo (in range) |
| `memo_generated` event + `api_applications.memo_available` flips | yes |
| Versioning append-only (`(application_id, version)`) | v1→v9 observed, each a new immutable row |
| Not-found input | clean 404 error envelope `{error:{code,message}}`, no row written |
| **Content-robustness (post-hardening)** | re-smoke 10/10 success, 0 errors, 0 drops — the earlier ~40% whole-memo-reject rate is eliminated; gates now DROP+LOG (I3 still holds: no uncited fact renders) |

## Known limits (documented, non-blocking, honest)

- **23505 (application_id,version) race**: unverifiable in practice — the content gates decouple
  concurrent branches enough that a real version collision never triggered across repeated
  double-POSTs. `[D]` carries a best-effort retry; low risk.
- **No `proceed` / `proceed-with-conditions` shown live** — every tested app resolves to `watchlist`
  (Medows: low trust; tracewire: no thesis assigned yet → D3). This is correct honest behaviour, not
  a bug; a `proceed` beat needs an app with a passed thesis + strong assessed axes (feature-07
  territory). The decision cascade's proceed/conditions paths are covered by the 43 decision unit
  tests with real inversion checks.
- **luna non-determinism**: memo prose varies run-to-run (temperature omitted — luna rejects 0); the
  *recommendation* is deterministic (rules). Each regeneration is a new `version` — the honest record.

## Adversarial checks deferred (per operator's fast-QA directive)

Not run in this pass (covered instead by unit tests + T6/T6b live evidence): the full hallucinated-id
injection matrix in nested arrays (plan #3), the two precedence-boundary decision cases (plan #2).
The drop+log mechanism that would neutralise a hallucinated id is exercised by 9 dedicated unit tests.
