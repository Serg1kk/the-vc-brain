# 05 · Truth-Gap Check & Trust Score

Status: **DONE** (2026-07-19 · QA gate PASSED after 2 passes · 197 tests · 3 n8n workflows live · see [done.md](done.md)) · Depends on: 01, 03, 04

## What it is

The diligence layer: every claim on a card gets verified against external evidence, gets a
**per-claim Trust/confidence level**, contradictions are flagged BEFORE they reach the
investor, and gaps are logged honestly. Trust is per-claim, never one number per company
(sponsor FAQ-7).

## Why (rubric & evidence)

- Intelligent Analysis & Trust = 25%; stretch-goal #1 (Agentic Traceability — cite the exact
  data point behind every conclusion) is Carl's pick for highest leverage (FAQ-13).
- Sponsor invariants: missing → mark honestly, never fabricate (REQ-004); missing → lower
  confidence, not the founder score (REQ-003, Carl @1:10:40).
- BuilderAI case (FACT-010): $445M of AI-washing passed HUMAN diligence incl. Microsoft —
  the pitch line for machine truth-gap.

## Where the idea comes from

- Generator-Validator-Critic pattern (REC-007): the validator
  checks claims against FACTS (code execution, API calls, metrics, search results), never
  against another LLM's opinion.
- Evidence ledger over vibes (REC-013); verbatim preservation vs LLM echo chamber (REC-009,
  RSK-003); GitHub provenance forensics (first-commit date vs earlier source, /211095).
- sieve-mcp (MIT): finding typology Documented / Discovered / Inferred / Missing — adopt as
  our verification_status vocabulary. dealgraph README (ideas only): ClaimRouter —
  factual_static→graph, factual_dynamic→web, qualitative→LLM-judge, unverifiable→flag;
  contradicted claim actively LOWERS the score.
- NotebookLM (Jul 19): AI-washing detection = deck claims vs actual codebase — implement the
  cheap version: deck claims vs GitHub/site reality.

## Implementation view

n8n workflows:

1. **`verify-claims`** (per card, after 03/04): route each unverified claim by type →
   - factual+public (stars, dates, deploys, team size): direct API check (GitHub, site fetch)
   - factual+dynamic (traction, funding mentions): Tavily search verify
   - self-reported w/o proxy: mark `unverified`, confidence low, add to gaps
   → status: verified / unverified / contradicted / missing + evidence_quote + source_url.
2. **`contradiction-scan`**: deck/interview claims vs found reality (e.g. «10k users» vs no
   visible traction; founder's competition list vs our 04 findings) → red flags with severity;
   contradiction lowers Trust axis score deterministically.
3. **`trust-rollup`**: per-axis confidence = f(verified share, contradiction count) —
   deterministic node; feeds the card header and memo.

Every verification writes an `events` audit row → this IS Agentic Traceability for the demo:
«click any number → see the exact source and when we checked it».

## Boundaries & stubs

Reference calls → proxy signals or «References: unavailable at this stage» (STUB-003).
Validator-critic full adversarial committee (IDEA-003) — stretch; if time allows, one
«devil's advocate» n8n agent that must find ≥2 objections per memo.

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** claim router (factual-static / factual-dynamic / qualitative / unverifiable), contradiction detector; validator checks FACTS, never another LLM's opinion (GVC).
- **n8n (MANDATORY, two n8n agents):** `verify-claims`, `contradiction-scan`, `trust-rollup` (deterministic).
- **Data model:** @database-engineer — verification_status vocab, events audit trail; reconcile with 01.
- **UX/Design:** status badges + evidence-on-click pattern — agree vocab/colors with @designer (renders in 09).
- **QA:** @qa-engineer — CRITICAL here: no fabrication paths, contradiction lowers Trust deterministically, audit row per verification.

## Open questions

- Verification depth per claim budget (LLM+Tavily calls) — cap per card, groom.
- Do contradicted claims notify the founder (fairness) or investor-only in MVP? (I lean
  investor-only for MVP, founder-visible post-MVP.)
