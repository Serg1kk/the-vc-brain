# 06 · Investment Memo & $100K Decision — Implementation Plan

> Design (approved, rev 2): `./design.md`. Agent artifacts (done this session): `./agents/`.
> Executors are subagents (build phase). Orchestrator owns the tracker + git-through-@devops.
> Deadline 16:00 Minsk — staging protects the priority: **a working generate-memo with honest gaps
> ships before optional sections**.

## Ownership & guardrails (every task inherits these)

- **Files 06 may touch:** `lib/f06/`, `n8n/build-f06-workflow.py` + `n8n/workflow_defs` additions
  scoped to f06, `n8n/workflows/f06-*.json`, `docs/backlog/06-memo-decision/`. **`web/` is 09's —
  never touched.** Shared `db/schema.sql` needs **no** change (no new columns — confirmed).
- **n8n build pattern = the repo's established Python generator** (`build-f05-workflow.py` precedent):
  lib logic in `lib/f06/*.js`, unit-tested with `node --test`, inlined **verbatim** into Code nodes.
  Code nodes `require('crypto')` bare; polyfill `crypto.subtle`/`URL` only if used; luna omits
  `temperature`; strict schemas through `strictify()`. *(This supersedes the generic
  n8n-workflow-builder MCP path for consistency with f02–f05 — flagged for the plan reviewer.)*
- **Contracts are frozen** (design §4, announced in TRACKER). Any shape change → announce in TRACKER
  before editing (09 reads `memos` concurrently).
- **Two review fold-ins carried from spec-review** (design already patched, tasks must honour):
  (1) §4.4 example is self-consistent — decision fixtures must not encode `material>0 + proceed`;
  (2) `allowed_claim_ids` is the **founder-scoped superset** (§3.6), so the citation gate never
  nukes a memo on a pack-sourced founder contradiction id.

## Task board

| # | Task | Executor | Depends | Stage | Parallel? |
|---|---|---|---|---|---|
| T1 | `lib/f06/decision.js` + `decision.test.js` | @backend-developer | — | 0 | ∥ with T2,T3 |
| T2 | `lib/f06/context.js` + tests | @backend-developer | — | 0 | ∥ with T1,T3 |
| T3 | `lib/f06/assemble.js` + tests | @backend-developer | — | 0 | ∥ with T1,T2 |
| T4 | Agent artifacts (prompts+schemas) | orchestrator (done) | — | 0 | ✅ done |
| T5 | `n8n/build-f06-workflow.py` — assemble `f06-generate-memo` workflow JSON | @backend-developer | T1,T2,T3,T4 | 1 | sequential |
| T6 | Deploy to n8n + single-application smoke | @backend-developer | T5 | 1 | sequential |
| T7 | Optional sections wired ([B3] node live end-to-end) | @backend-developer | T6 | 2 | drop-first |
| T8 | Independent QA gate → `qa-report-06.md` | @qa-engineer | T6 (T7 if reached) | 3 | sequential |
| T9 | Close: README status (EN+RU), tracker final, commit | @devops + orchestrator | T8 | 3 | sequential |

**Stage 0 runs three parallel backend agents** (T1/T2/T3 — no shared state; separate files). Stage 1
is sequential (generator needs all three libs). Stage 2 (T7) is drop-first. Stage 3 sequential.

## Stage 0 — `lib/f06` (three parallel backend agents)

### T1 · `lib/f06/decision.js` — the deterministic decision engine (design §8)
- Pure function `decide(inputs) → { recommendation, conditions }`. **No I/O, no LLM.** `DECISION_CONFIG`
  named constants (`TRUST_FLOOR=40, STRONG_TRUST=60, AXIS_HIGH=60, AXIS_LOW=40, CONF_FLOOR=0.45,
  MIN_TRUST_COVERAGE=0.25`, `thresholds_version:'f06-2026.07'`).
- Implement the **D1 → D1b → D2 → D3 → D4 → D5 → D6** first-match cascade **exactly** as §8 (note
  D1b, the fatal-fabrication→pass tier, sits between D1 and D2). `material_contradictions` and
  `fatal_contradictions` counted per §3.9; `fatal` requires an event with `nature='factual'` AND
  `severity='material'` (config-gated `ENABLE_FATAL_CONTRADICTION_PASS`, default true). Build
  `conditions.items` deterministically from what fell short (D6). **`conditions.rationale` is a
  templated conflict-arbitration narrative naming the axes and why the verb** (§8) — no LLM. Never
  averages; never returns NULL (D6 catch-all).
- **Acceptance:** `node --test lib/f06/decision.test.js` green. Tests MUST cover: D1 thesis-failed→pass;
  **D1b fatal factual+material contradiction→pass; D1b does NOT fire on a temporal/scope material
  contradiction (→ D2 watchlist); D1b disabled by config → falls through to D2;** D2 material
  contradiction→watchlist; D2 low-trust→watchlist; D3 thesis-NULL-gate/insufficient→watchlist;
  D3 only-1-axis-assessed→watchlist; D4 measured market<40→pass; D4 idea_vs_market<40→pass;
  D4 does NOT fire on low founder axis; D5 all-strong→proceed; D6 mixed (market 68/idea 55/trust 55)
  →proceed-with-conditions with idea+trust named; totality (no input → NULL) fuzz; non-averaging
  (68+40 never yields a 54-band proceed); rationale names the disagreeing axes. Each locked test
  verified to FAIL if the rule is inverted.

### T2 · `lib/f06/context.js` — context-pack assembly (design §3, §4.2)
- `buildPack(pgClient, application_id) → pack` implementing §3.1–§3.10 reads with the inlined `pg()`
  helper shape (f04/f05 precedent; `SUPABASE_URL` already ends `/rest/v1`). Encodes every resolution
  rule: absent≠zero (§3.2), `scores` dedup `computed_at DESC,id DESC` (§3.4), stale-thesis via
  `api_applications` (§3.5), **`allowed_claim_ids` = application-scoped ∪ founder-scoped, deduped**
  (§3.6 superset), `derived_status` join (§3.7), contradictions both entity shapes + co-founder set
  (§3.9) exposing BOTH `material_contradictions` and `fatal_contradictions` (fatal = event
  `nature='factual'` AND `severity='material'`; documented-only contradictions are never fatal),
  competition all three slugs + `company_mentioned→named_by_founder` (§3.10).
- `buildGaps(pack) → gaps` (§4.2): `not_disclosed` from the fixed trigger set (financials, revenue,
  + disclosure-mapped missing fields), `missing_axes`, `missing_fields`, `low_coverage`,
  `contradictions` (singular `claim_id`).
- **Empty-normal branches:** every select tolerates `[]` (app-not-found is the only hard error).
- **Acceptance:** `node --test lib/f06/context.test.js` green against a mocked pg layer. Tests cover:
  not-assessed axis stays null (never 0); no-trust-row → trust.assessed=false; NULL-gate thesis →
  not-decidable inputs; founder-scoped claim with `application_id NULL` IS in `allowed_claim_ids`;
  empty pack → all-gaps + valid inputs. (Integration against live DB happens in T6.)

### T3 · `lib/f06/assemble.js` — validate, gate, version, write-payload (design §9)
- `assembleMemo({pack, sections_parts, decision}) → memoRow | {error}`:
  1. **Merge the four B-node items by content** (not index) — a sentinel `{}`/all-null from [B3]
     contributes no keys; drop `null` optional sections.
  2. **Citation gate (hard):** collect every claim id across `sections`, `deep_dive_questions`,
     `conditions.items`, `gaps.contradictions` (singular); any id ∉ `allowed_claim_ids` → return
     `{error}` (no partial write).
  3. **Typed-exception guard:** reject `not_disclosed`/`structural` statements containing `$` or a
     digit+unit (residual documented — non-numeric/worded-number smuggling is left to the QA
     assertion + the §6 prompt; I3 is airtight only for `kind:'fact'`).
  4. **Required-key gate:** 5 required keys present, each non-empty (empty-but-required → one
     `structural` line inserted upstream by the writer, verified here).
  5. `cited_claim_ids` = deduped union of ALL claim ids (all blocks).
  6. Return the INSERT payload (version computed in T5's node from a live read, retry-on-race).
- **Acceptance:** `node --test lib/f06/assemble.test.js` green. Tests cover: hallucinated id →
  rejection; `$`/digit in not_disclosed → rejection; missing required key → rejection; sentinel [B3]
  → optional keys absent; `cited_claim_ids` union spans questions+conditions, not just sections.

## Stage 1 — n8n workflow (sequential)

### T5 · `n8n/build-f06-workflow.py` — generate `f06-generate-memo.json`
- Mirror `build-f05-workflow.py`: `inline_module()` for `lib/f06/{decision,context,assemble}.js`
  (strip `module.exports`, assert zero-import); load the four agent prompts+schemas from `agents/`;
  run every schema through `strictify()`; build the node graph of design §5 — Webhook → [A] →
  fan(B1,B2,B3,B4) → Merge(4) → [C] → [D] → Respond. **[C] reads `$('Context pack')` for numbers;
  [D] reads `$('Merge').all()` + `$('Context pack')`.** `alwaysOutputData` on version/trust/claims
  selects. `--check` mode syntax-checks every Code node.
- **Acceptance:** `python3 n8n/build-f06-workflow.py --check` passes; JSON written to
  `n8n/workflows/f06-generate-memo.json`; README-f06.md documents deploy + the node graph.

### T6 · Deploy + smoke
- POST/PUT the workflow to n8n via API (`X-N8N-API-KEY` from `infra/n8n/.env`), activate. Run one
  real application end-to-end (a synthetic demo app with trust rolled up — see runbook note), verify
  a `memos` row lands: 5 required keys, `recommendation` ∈ the 4 values, `cited_claim_ids` non-empty,
  `memo_generated` event emitted, `api_applications.memo_available` flips true.
- **Runbook note:** the target demo app must have `f05-trust-rollup` run first, else D3→watchlist on
  all (design §10). Pick an app that already has trust + ≥2 assessed axes for the "proceed"/"conditions"
  demo beat; keep one watchlist and one honest-empty app for contrast.
- **Acceptance:** a live `memos` row exists and validates; a second run creates `version=2` (append-only).

## Stage 2 — optional sections (drop-first) · T7
- Confirm [B3] produces risk_matrix/competition/financials_lite live on an app that has the inputs,
  and the sentinel path omits keys cleanly. If the clock is inside ~40 min to deadline at T6 close,
  **skip T7** — the not-disclosed honesty is already guaranteed via `gaps` (design §4.2), so the
  memo is complete and honest without it.

## Stage 3 — QA gate + close

### T8 · Independent QA (@qa-engineer) → `qa-report-06.md`
Adversarial, not the dev tests. Must independently verify: no uncited fact renders (inject a
hallucinated id → whole-memo reject); the 5 required sections always present; "Cap table: not
disclosed" path; padding guard; recommendation is deterministic (same inputs → same verb across
runs, even though prose varies); axes never averaged; the four not-assessed states (founder axis
absent, trust unassessed, thesis NULL-gate, empty pack) each produce an honest memo, never a 0;
`recommendation` never NULL. psql + REST + a workflow execution trace. **Finding → fix (backend) →
independent re-check** until GATE PASSED.

### T9 · Close (@devops + orchestrator)
- Commit **explicit f06 paths only** (`lib/f06/`, `n8n/build-f06-workflow.py`,
  `n8n/workflows/f06-*.json`, `n8n/workflows/README-f06.md`, `docs/backlog/06-memo-decision/`),
  `git add` by path, never `-A`; `git pull --rebase` first (multi-terminal). No push unless told.
- README status → done (EN + RU together); tracker final; TRACKER.md status row → done.

## Risks / notes for the reviewer
- **n8n Merge content-merge (T3 step 1):** [D] must merge the four items by their keys, not by input
  index, so the [B3] sentinel is harmless. Called out because index-merge is the tempting default.
- **luna non-determinism:** prose differs run-to-run (no `temperature`); the *recommendation* is
  deterministic (rules). QA asserts the split. Each regeneration is a new `version` — the honest record.
- **Deferred (research #3, considered, NOT adopting under the clock):** emitting a short rejection
  stub instead of the full 5-section memo on `pass`. The current architecture runs sections and the
  decision in parallel from `[A]`, so gating sections on the verb would serialise the workflow; a
  full memo on a `pass` is still honest (every statement cited; the banner makes the pass clear) and
  the padding cost is small. Revisit only if a demo beat needs it.
- **Clock:** Stage 0 is the only genuinely parallel gain (3 agents). Priority RANKING if time is
  very short: T1 (decision.js) is the highest-value unit — the deterministic $100K call is the
  rubric's core — but T1 alone renders nothing. The minimum DEMOABLE slice is design §12 Stage 1
  (context pack + 2 narrative writers + questions + decision + write): a working memo with honest
  gaps and a real recommendation. Optional sections (Stage 2) drop first.
