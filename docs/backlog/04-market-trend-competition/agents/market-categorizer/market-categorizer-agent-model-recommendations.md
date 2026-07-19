# `market-categorizer` — Model Recommendations

> Assigned by design.md §9: **`gpt-5.6-luna`**. This document justifies that assignment
> and fixes the runtime parameters; it does not reopen the choice.
> Pricing source: `internal/research/openai/02-models.md` (collected 2026-07-18).

## Token estimate

| Component | Tokens | Notes |
|---|---|---|
| System prompt (XML, EAP-structured) | ~5,100 | Static across every call in a run and across runs → prime prompt-caching candidate. |
| User message — company fields | ~120 | name, domain, one-liner, existing label, stage. |
| User message — `known_categories[]` | ~60–300 | Grows with the database; tens of entries through the demo. |
| User message — `deck_claims[]` | ~300–1,600 | Capped at 50 claims upstream (input spec). Deckless `radar_activated` rows contribute 0. |
| User message — `thesis_geos[]` | ~20 | |
| **Input total** | **~5,600–7,100** | Typical ≈ 6,200. |
| Output (JSON) | ~200–450 | Abstentions run at the top of the range — five `gaps[]` entries cost more tokens than a clean classification. |

Well under the 272K threshold where Sol/Terra/Luna apply the 2× input / 1.5× output
surcharge. No risk of hitting it: this agent never sees fetched web content.

## Cost per call

Luna: **$1.00 / 1M input · $6.00 / 1M output · $0.10 / 1M cached input.**

| Scenario | Input | Output | Cost |
|---|---|---|---|
| Uncached, typical (6,200 in / 350 out) | $0.0062 | $0.0021 | **$0.0083** |
| Uncached, worst case (7,100 in / 450 out) | $0.0071 | $0.0027 | **$0.0098** |
| Cached system prompt (5,100 cached + 1,100 fresh / 350 out) | $0.0016 | $0.0021 | **$0.0037** |

One call per card. At ~$0.008/card uncached, 100 demo cards cost **$0.83** — negligible
against the $50 shared hackathon credit pool, and the pool is shared with other
pipelines, so this agent is not where the budget goes.

**Caching verdict for MVP: skip it.** Cache *write* is billed at 1.25× uncached input
and the minimum TTL is 30 minutes. At a demo volume of tens of cards the write premium
is not reliably recovered, and an explicit cache breakpoint is one more thing that can
misbehave on stage. Revisit only if the demo runs hundreds of cards back to back.

## Model comparison

| | **Luna (assigned)** | Terra | Sol |
|---|---|---|---|
| Input / 1M | $1.00 | $2.50 | $5.00 |
| Output / 1M | $6.00 | $15.00 | $30.00 |
| Cost per call here | **$0.0083** | $0.021 | $0.042 |
| Context | 1.05M | 1.05M | 1.05M |
| Reasoning label (docs) | High | Higher | Highest |

**Why Luna fits this job.** The task is closed-form classification and extraction from
a short, self-contained payload: pick or mint one label, name a countable noun, choose
one of four enum values, list what is missing. There is no evidence to weigh, no
arithmetic, no conflict between sources — every hard reasoning decision in feature 04
lives in `market-sizer` (Sol) and in the deterministic Code nodes, by design. Luna is
also not a weak tier despite the naming: per the model research, the 5.6 rename came
with a capability jump and Luna leads Opus 4.8 on the Coding Agent Index, so
instruction-following on a strict JSON contract is not the constraint here. Its 10M TPM
ceiling (vs 4M for Sol/Terra) is a free bonus if the demo ever runs cards in parallel.

Spending Terra or Sol money here buys nothing measurable and takes budget away from the
step where reasoning quality actually changes the answer.

## Runtime parameters

| Parameter | Value | Rationale |
|---|---|---|
| `temperature` | **0** | Extraction/classification. Design §4 pins Tavily's `end_date` so the same run reproduces tomorrow; a stochastic category label would defeat that on the very first node. There is no creative surface in this task — a "more interesting" category label is a worse one. |
| `top_p` | 1 (default) | Do not tune alongside `temperature`. |
| `reasoning_effort` | **`low`** | Single-pass classification. `medium`+ buys nothing and adds latency to the node that gates all five searches. |
| `text.verbosity` | `low` | Output is a fixed JSON object; verbosity only inflates `note` fields. |
| `response_format` | JSON Schema (strict), from `market-categorizer-agent-json-schema.json` | Structural enforcement of the enums — especially `buyer_concentration` and the closed `reason_code` list — so the "may not invent codes" rule is guaranteed by the API rather than requested in prose. |
| `max_output_tokens` | 900 | Comfortably above the 450-token worst case; a response approaching this is malformed. |
| Retry | 1 re-ask with the schema restated, then abstain | Design §4 error branch: "LLM returns non-conforming JSON → 1 re-ask with the schema restated → then abstain (write `missing` claims), never a partial parse." |

## Endpoint

Chat Completions or Responses — both supported on 5.6. Use whichever the n8n OpenAI
node targets by default. No Responses-only feature is required here (no tools, no
web search, no multi-agent).

## What would change this recommendation

- If `known_categories` grows past a few hundred entries, canonical normalisation stops
  being lookup and starts being judgement → re-evaluate Terra. Not a demo-scale concern.
- If QA finds Luna coercing novel companies into legacy buckets (the failure mode in
  Undesired Example 1 of the prompt), the first fix is a sharper Instruction 3, not a
  bigger model. Escalate to Terra only if a prompt fix fails twice.
