# 06 · Memo & Decision — Execution Tracker

> Single writer = orchestrator. Agents report to me; they never edit this file. Updated on every
> dispatch / completion / failure. Design: `./design.md` (approved rev 2.1). Plan: `./plan.md`.

## Task board

> Status values: pending · dispatched · in-review · **done** (only when verified on disk/DB/git by
> the orchestrator). Result/commit filled ONLY with real, verified artifacts — never a placeholder.

| # | Task | Executor | Depends | Status | Result / commit | Notes |
|---|---|---|---|---|---|---|
| T4 | Agent artifacts (4 prompts + schemas) | orchestrator | — | **done** | `agents/README.md` + `agents/{memo-descriptive,memo-analytical,memo-optional,deep-dive-questions}/` (prompts.txt + json-schema.json each) — verified on disk | via ai-agent-builder this session |
| T1 | `lib/f06/decision.js` + tests | @backend-developer | — | **done** (verified) | `lib/f06/decision.js` + `.test.js` — 43/43 pass, zero-import + cascade confirmed on disk; real inversion checks done | `decide(inputs, configOverrides?)`; items=[] for non-D6 (watchlist conds live in rationale+questions); items[].claim_ids enrichment deferred to [D]/T5 |
| T2 | `lib/f06/context.js` + tests | @backend-developer | — | **done** (verified) | `lib/f06/context.js` + `.test.js` — 35/35 pass, zero-import confirmed on disk | dedup material/fatal by claim_id; founder_score=founders[0] (view-ordered); competitors value.name/company_mentioned |
| T3 | `lib/f06/assemble.js` + tests | @backend-developer | — | **done** (verified) | `lib/f06/assemble.js` + `.test.js` — 28/28 pass, zero-import confirmed on disk by orchestrator | citation gate walks all blocks incl. gaps.contradictions singular `claim_id`; typed-exception guard; content-merge not index; SWOT gated per-array (matches analytical prompt) |
| PR | Plan review | @implementation-plan-reviewer | plan.md | **✅ APPROVED** | no blockers; D1b ordering confirmed clean (fatal ⊂ material, first-match, no double-count) | should-fix #1 (back-fill empty required sections, not reject) folded into design §9 + T5 brief; #2/#3 → T8 QA; #4 plan wording fixed; nits → T5/T6 |
| T5 | `build-f06-workflow.py` → workflow JSON | @backend-developer | T1,T2,T3,T4,PR | **done** (verified) | `n8n/build-f06-workflow.py` + `n8n/workflows/f06-generate-memo.json` (19 nodes) + `README-f06.md`; assemble.js patched (back-fill, 31/31); `--check` 0 fail on disk | flags: (i) deep-dive schema file was missing → orchestrator wrote it; (ii) 23505-race retry UNVERIFIED LIVE → T6/T8; (iii) B-nodes degrade to sentinel on LLM fail |
| T6 | Deploy + single-app smoke | @backend-developer | T5 | **done** (verified) | workflow `iLzZ0he48v4WowMS` active; 6 memos rows verified in DB (Medows v1-4 D2·watchlist, tracewire v1-2 D3·watchlist), cited 14-20, q 5-7, 6 memo_generated events; app-not-found→404; v2 append-only | finding: ~40% runs hit a content gate→clean 422 (0 bad writes). Cause: $-figure in structural stmt + rare claim_id hallucination. → T6b hardening |
| T6b | Content-robustness hardening (prompts + drop-not-reject gates) + re-smoke | @backend-developer | T6 | dispatched | — | prompts: no $-figure in prose; assemble gates DROP+log offending stmt not whole-memo reject (I3 preserved); measure new reject rate |
| T7 | Optional sections live (B3) | @backend-developer | T6 | pending | — | Stage 2, drop-first |
| T8 | Independent QA gate | @qa-engineer | T6 | pending | — | adversarial → `qa-report-06.md` |
| T9 | Close: README(EN+RU), tracker, commit | @devops + orch | T8 | pending | — | explicit paths only |

## Event log

- 2026-07-19 ~12:35 — feature opened; phase 0 sources (Explore contracts + OSS/Exa/NBLM research).
- 2026-07-19 ~12:55 — design.md rev 1; frozen contract announced to 09 in TRACKER.
- 2026-07-19 ~13:00 — spec-review round 1: CHANGES REQUESTED (2 blockers + 4 SF).
- 2026-07-19 ~13:15 — design.md rev 2 (all fixes); re-review → ✅ APPROVED (6 non-blocking notes).
- 2026-07-19 ~13:20 — agent artifacts authored (ai-agent-builder): 4 agents.
- 2026-07-19 ~13:30 — Exa+NBLM pass confirmed design; folded fatal-contradiction tier (D1b),
  deal-memo framing, proxy-valuation rejection, richer rationale → design rev 2.1.
- 2026-07-19 ~13:35 — plan.md written; tracker created.
- 2026-07-19 ~13:35 — **dispatching Stage-0 (T1/T2/T3 parallel) + plan review.**

- 2026-07-19 ~13:50 — **Stage 0 COMPLETE.** T1 43/43 · T2 35/35 · T3 28/28, all verified on disk by
  orchestrator (files exist, zero-import, tests re-run green). Interface seams reconciled:
  `context.decision_inputs` keys == `decision.decide()` expected input; `assemble` reads
  `pack.allowed_claim_ids`/`pack.gaps` + `decision.recommendation`/`.conditions` (via defensive
  packObj/decisionObj). 106 tests total. Next: T5 (n8n generator) once plan-review returns.

- 2026-07-19 ~14:05 — T6 preflight green (n8n up, container has OPENAI_API_KEY + SUPABASE creds,
  memos=0). Deploy BLOCKED by a generator bug: all 4 sticky-note nodes named "Note" → n8n API
  rejects duplicate node names. T6 correctly stopped (generator bug, not deploy config). Routed back
  to T5 to give sticky notes unique names + regenerate; T6 standing by. Demo apps chosen live:
  **tracewire** `11f00002-…-006` (all 3 axes + trust 63, rich beat) + **Medows** `08f360ee-…` (trust
  19.5 + contradictions, honest-watchlist contrast).
