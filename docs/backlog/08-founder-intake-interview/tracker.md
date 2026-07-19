# 08 · Founder Intake — Execution Tracker

> Single writer: the orchestrator session. Agents report back; they never edit this file.
> Plan: [`plan.md`](plan.md) · Design: [`design.md`](design.md) rev.2
> Started 2026-07-19 ~10:35 Minsk, ~5.4 h to deadline.

## Task board

| ID | Task | Executor | Depends | Status | Result / notes |
|---|---|---|---|---|---|
| T1 | Storage bucket `decks` + cold-start docs | @devops | — | **done** | verified: bucket exists, private; `CLAUDE.md` cold-start step added |
| T2 | n8n env: CORS + payload 192 MB | @devops | — | **done** | verified live in container; **all 8 workflows survived the restart**; CORS allows `:5173`/`:3000` — e2e must use the default Vite port |
| T3 | `deck-claims-extractor` spec | ai-agent-builder | — | **done** | verified: `span` is required in the schema; `luna` for text_layer, `terra` for vision; `temperature` omitted, not zeroed |
| T4 | `gap-question-phraser` spec | ai-agent-builder | — | **done** | verified: all four contract fields required incl. `placeholder`; forbidden words appear only as negative instructions and one explicit counter-example; `terra` |
| T5 | `lib/f08/validate.js` | @backend-developer | — | **done** | `URL` removed for a manual parser; found and did **not** port a real security bug in the OSS source (`??` fall-through let a credentialed URL through on the second attempt) |
| T6 | `lib/f08/identity.js` | @backend-developer | — | **done** | GitHub-first resolution + symmetric identity write so a later radar pass resolves back |
| T7 | `lib/f08/hashing.js` | @backend-developer | — | **done** | `require('crypto').createHash`, **synchronous** — callers must not `await` `contentHash.*` |
| T8 | `lib/f08/gaps.js` | @backend-developer | — | **done** | returns `[L2, L3, X5]`; topic vocabulary confirmed against the live DB and the extractor spec |
| T9 | `lib/f08/completeness.js` | @backend-developer | T8 | **done** | 0.51 arithmetic corrected by the agent before I asked |
| T9b | n8n workflow requirements spec | n8n-requirements-orchestrator | — | dispatched | depends on contracts, not on code |
| PR | Plan review | @implementation-plan-reviewer | — | dispatched | |
| T0 | Response contract: `responseNode` + real HTTP codes | n8n-workflow-builder | — | **done** | verified live: a rejected request returns a real 500 with the frozen error envelope |
| T19 | `f08-followup-create` (token producer) | n8n-workflow-builder | T10 | **done** | `eWIitXaz1kfCMjKY` |
| T20 | Recompute founder score after answers | n8n-workflow-builder | T11 | **done** | fires after gap-answers and followup-answers; `insufficient_evidence` on a sparse founder is the correct outcome, not a bug |
| T10 | `f08-intake-submit` | n8n-workflow-builder | T0,T1,T2,T5-T9b | **done** | `AOSJGp1WtyklOg8A` |
| T11 | `f08-gap-answers` | n8n-workflow-builder | T10 | **done** | `NozMliP7TSLCQNrc` |
| T12 | `f08-followup` + `-answers` | n8n-workflow-builder | T10 | **done** | `faIkBLyDGdiXTQpY` / `mu172HUPZJSzYGSh` — **not cut** |
| T13 | `f08-application-status` | n8n-workflow-builder | T10 | **done** | `S2GGy48ZGPoKtcPr` — **not cut** |
| T14 | End-to-end verification | orchestrator | T10-T13 | **done** | own smoke test, 9/9; CORS confirmed by real preflight earlier |
| T15 | QA gate | @qa-engineer | T14 | **done** | 4 criticals found; 3 fixed + re-verified, 1 disclosed. `qa-report-08.md` |
| T16 | `done.md` for feature 11 | orchestrator | T15 | **done** | contract + honest limits |
| T17 | Rewrite feature README body | orchestrator | — | **done** | EN + RU pair rewritten in the S2 waiting window, per plan review §10 — no longer contradicts its own header |
| T18 | Final commit + backlog status | @devops | T16,T17 | pending | |
| T21 | Session history (operator request, ~12:15) | orchestrator | T18 | pending | via the `create-session-history` skill, after the feature closes |

## Already done before the board opened

| Item | Result |
|---|---|
| Phase 0 — four source passes | intel base (12 queries), NotebookLM ×10, Exa ×11, 20 OSS clones |
| `lovable-brief.md` | frozen API contracts; commit `e7f5e93` |
| Frontend built in Lovable, imported | `web/`, 92 files, commit `deff7cc` |
| Frontend restyled to Maschmeyer palette | installed; `api.ts` unchanged, contracts intact |
| Next-phase panel shortened; rationale → roadmap | operator, Jul 19; EN + RU pair updated |
| `design.md` rev.1 → adversarial spec review | 19 findings, 5 blockers, **all verified real** |
| `design.md` rev.2 | every finding folded in; `agents/spec-review-rev1.md` |
| Cross-feature findings published | `docs/backlog/TRACKER.md` (bucket, purge gap, 07 gap convention, hash scoping) |

## Event log

- **~10:35** — Plan written, board opened. S0-A (@devops, T1+T2) and S0-B (agent specs, T3+T4)
  dispatched in parallel; plan review dispatched alongside, since S0 is infra prerequisites no
  plan revision would change.
- **~10:40** — Operator: full autonomy, parallelise everything possible. S1 (@backend-developer,
  T5-T9) and the n8n requirements spec dispatched immediately rather than after S0 — neither
  depended on it. Five agents in flight.
- **~10:22** — **T1 + T2 done and verified independently.** Bucket `decks` exists and is private;
  both env vars live; **all 8 workflows survived the container restart** (the real risk — the
  instance is shared by three terminals). `f02-radar-scan` shows inactive, but that is its
  original state per its own `done.md`, not a regression.
- **~10:28** — **Plan review returned CHANGES REQUIRED: 3 blockers, 9 majors, 6 minors.** Two
  findings hit agents that were mid-flight, so corrections were sent live rather than after:
  - `URL` is undefined in the n8n Code sandbox, and my "port verbatim from `reporting`"
    instruction actively caused the failure. Recorded in 02's `done.md` as the bug that silently
    classified every artifact as `kind:'none'`. Correction sent to @backend-developer.
  - `responseMode:"lastNode"` (used by all four existing workflows, no `respondToWebhook` node
    anywhere — verified) can only emit HTTP 200, so **no frozen error code could ever reach the
    UI**. Correction sent to the n8n requirements agent, plus ten more.
  Two claims verified against the live system: **CORS works** (real preflight → 204 with the
  right origin, so T14's main risk is retired early), and the **status-screen falsehood is real**
  — without T13 a founder who answered everything is told "You left 3 questions unanswered",
  which inverts the old cut order. Plan amended as rev.2; three tasks added (T0, T19, T20).
- **~10:50–11:00** — **Second data-loss event.** A stray `git reset` from another terminal
  destroyed all uncommitted feature-08 work. Recovered from `git stash` (`stash@{1}`, 68 files);
  the tracked-file edits did not come back with it and were redone by hand. Full detail and the
  recovery recipe are in `docs/backlog/TRACKER.md`. Committed as `8c44e9e` immediately after.
- **~11:15** — **The build's real blocker found and fixed: OpenAI strict structured output
  rejects most of JSON Schema.** Not the key, not the model, not the workflow — `oneOf`, string
  constraints, partial `required`, and free-form objects are all refused, and the schema is valid
  JSON Schema so nothing local would ever flag it. Found by replaying the request body captured
  from the execution data straight against the API; n8n's node error surface showed nothing.
  Both agents then verified live before wiring. Recorded cross-feature in `TRACKER.md`.
- **~11:36** — **All six workflows deployed and verified; nothing was cut.** Independent smoke
  test 9/9. The three results worth keeping: a deck stating L2/L3/X5 yields **zero** questions
  (suppression, the half that is easy to fake); a text-free deck yields ten claims **all marked
  `missing`** — no fabrication — and now reports `image_only_deck` so the founder is told, not
  just the database; and `card_completeness` moves 0.00 → 0.81 → 1.00 as answers land.
- **~11:38** — QA gate dispatched. Four of the five failures in my own first smoke run were the
  test's fault (it matched the API's internal `"status":"screening"` enum as founder copy, and
  counted features 04's and 05's pre-existing rows as its own); scoping corrected, since a test
  that fails on other people's data gets ignored.

## Cross-feature defects found here, owned elsewhere — reported, not fixed

| Defect | Owner |
|---|---|
| `company.*` gap claims written with no `evidence` row (violates the invariant 03's fallback depends on) | 07 |
| 9 `raw_signals` with both FKs NULL (`tavily_extract`) — unreachable by erasure | 04 |
| ~190 `events` with `entity_type='application'` — `purge_founder()` sweeps only `'founder'` | 05 |
| 14 unpolyfilled `new URL()` calls across two workflows — throws in the Code-node sandbox | 04 |
