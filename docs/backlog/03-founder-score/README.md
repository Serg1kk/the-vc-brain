# 03 · Founder Score (cold-start core)

Status: backlog · Depends on: 01 · The heart of the product

## What it is

The evidence-backed Founder Score: an n8n scoring pipeline that turns a founder's public
footprint + interview claims into a **persistent, versioned, explainable score** for the
Founder axis — designed for the founder with NO track record. «Model proposes, backend
decides»: LLM nodes emit sub-scores WITH evidence citations; a deterministic n8n node
aggregates by versioned weights; Supabase stores every version append-only.

## Why (rubric & evidence)

- Carl, verbatim: problem/market/SWOT are «nowadays quite easy with Claude… really assessing
  the founder, finding a good scoring — that's the hard part of the challenge» (FACT-007).
- Rubric tiebreaker: generic ingestion scores low unless it solves the **cold-start,
  pre-track-record** case. This feature IS that answer.
- Sponsor invariants: axes never averaged (REQ-002); Founder Score lives in Memory, never
  resets, feeds every decision (FAQ-6); missing data → confidence down, not score (REQ-003).

## Where the idea comes from

- Carl's three questions (Q&A @33-35min): would I work for them / can they sell / can they
  scale (SIG-003/004/005). Fund triad integrity/energy/resilience (SIG-022); 8-trait rubric
  (SIG-023); founder-first thesis «almost nothing but the founder matters» (SIG-021).
- **2026-fresh signal calibration from our e/acc KB (906 items)** — our unfair advantage:
  - shipped-vs-built: prod deploy + external traction, not code volume (SIG-012, t.me/eaccchat/187646)
  - vibe-coding decayed the prototype signal (RSK-002, t.me/eaccchat/3061, Jun 30)
  - GitHub stars = vanity; provenance check first-commit-date vs earlier source (SIG-014, /3033, /211095)
  - agency/completion ratio: finished vs abandoned projects (SIG-011, cryptoessay/2753)
  - domain expertise 40+ / management skill as predictor (SIG-016), hands-on-at-scale (SIG-017)
  - anti-signals: headcount (SIG-019), pitch polish — persuasion devalued (SIG-018)
  - GTM competence for B2B (SIG-020); post-rejection updates as rare persistence signal (SIG-025)
- vantage (MIT): scoring.py aggregation pattern; sieve-mcp: evidence typing
  Documented/Discovered/Inferred/Missing.
- Defenses: RSK-003 (verbatim layer vs LLM echo chamber), RSK-004 (survivorship-aware:
  no «looks like past winners» features; YC directory as optional ground-truth check).

## Implementation view

n8n workflows (via ai-agent-builder for every prompt):

1. **`score-founder`** (called by radar/intake): input = card_id → gather claims from Supabase
   → parallel LLM sub-scorers (each an ai-agent-builder-specified agent with JSON output):
   `execution-signals` (shipped/agency/provenance), `expertise-signals` (domain, hands-on),
   `leadership-sales-proxies` (SIG-003/004 public proxies), `red-flags` → each returns
   {signal, value, evidence:[claim_ids], confidence, missing:[]}.
2. **`aggregate-score`** (Code node, deterministic): versioned weights (formula_v1 in a config
   row), missing → confidence penalty only; writes `scores` row (append-only) + trend vs
   previous version.
3. Output contract: score + per-signal breakdown + evidence links + confidence + honest
   «what we don't know» list — consumed by card UI (09), memo (06), API (10).

OQ-002 (which 5-7 GitHub metrics) is closed HERE during grooming: candidate set = merged PRs
to foreign repos · release-completion ratio · first-commit provenance · prod-deploy evidence ·
consistency-over-time · domain-content depth. NOT: stars, LOC, commit volume.

## Boundaries & stubs

Social-personality analysis (X/Twitter traits) — stretch per Carl (SCOPE-005), stub as a
grayed «Personality (research)» block. No prediction intervals (Research Area 1) — show
confidence honestly instead.

## Open questions

- Final formula_v1 weights — groom with operator; keep a config table so judges see
  configurability.
- Do we run a YC-directory calibration pass if time allows (killer slide, ~1h)?
