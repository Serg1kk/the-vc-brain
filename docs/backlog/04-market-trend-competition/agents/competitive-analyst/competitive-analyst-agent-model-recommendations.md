# `competitive-analyst` — Model Recommendations

> Assigned by design.md §9: **`gpt-5.6-terra`**. This document justifies that assignment
> and fixes the runtime parameters.
> Pricing source: `internal/research/openai/02-models.md` (collected 2026-07-18).

## Token estimate

| Component | Tokens | Notes |
|---|---|---|
| System prompt (XML, EAP-structured, 3 desired + 2 undesired examples) | ~8,200 | The longest of the three prompts. The two rubric tables and the five worked examples are load-bearing: they carry the null-is-correct behaviour and the identified-vs-displaced distinction. Static across calls. |
| User message — company + category + as_of_date | ~250 | |
| User message — founder competition view | ~100–600 | Empty for deckless entries. |
| User message — `searches_performed[]` | ~120 | |
| User message — `documents[]` | ~26,000–30,000 | **20 documents × 6,000 chars truncation cap** (see input spec). Dominates. |
| **Input total** | **~35,000–39,000** | Typical ≈ 37,000. |
| Output — visible JSON | ~1,200–3,500 | Scales with competitor count. Six competitors with rationales and evidence rows sits near the top. |
| Output — reasoning tokens | ~600–2,500 | At `reasoning_effort: medium`. |

The 272K-token cliff (2× input / 1.5× output on the whole request) applies here exactly
as it does to Sol. The 6,000-char truncation is what keeps the payload an order of
magnitude clear of it; removing it voids the cost model below.

## Cost per call

Terra: **$2.50 / 1M input · $15.00 / 1M output · $0.25 / 1M cached input.**

| Scenario | Input | Output (visible + reasoning) | Cost per call |
|---|---|---|---|
| Typical, `reasoning_effort: medium` (37K in / ~4,000 out) | $0.093 | $0.060 | **$0.15** |
| Rich landscape, 8 competitors (39K in / ~6,000 out) | $0.098 | $0.090 | **$0.19** |
| Abstention on thin evidence (30K in / ~1,200 out) | $0.075 | $0.018 | **$0.09** |
| `reasoning_effort: low` (37K in / ~2,500 out) | $0.093 | $0.038 | **$0.13** |

One call per card. At ~$0.15/card, 100 cards cost **~$15**. Combined with `market-sizer`
at `high` (~$43) and `market-categorizer` (~$0.83), feature 04's full model spend at 100
cards is **~$59** against a $50 shared pool — which is why the sizer's budget note
matters and this one does not: dropping the sizer to `medium` brings the total to ~$46.

**Caching: not recommended for MVP.** Same reasoning as the sizer — the 8,200-token
prefix is cacheable but the document payload (~75% of input cost) never is, cache write
costs 1.25× uncached input, and the 30-minute minimum TTL only pays back across a tight
burst.

## Model comparison

| | Luna | **Terra (assigned)** | Sol |
|---|---|---|---|
| Input / 1M | $1.00 | $2.50 | $5.00 |
| Output / 1M | $6.00 | $15.00 | $30.00 |
| Cost per call here | $0.061 | **$0.15** | $0.31 |
| Reasoning label (docs) | High | Higher | Highest |

**Why Terra sits correctly between the other two.**

This is typed extraction with two genuine judgement calls embedded in it, which is
exactly the shape Terra's tier is for.

The extraction half is mechanical: pull companies out of ~30K tokens of fetched pages,
classify each into a four-value enum, match names against a founder-supplied list,
attach source URLs. Luna could very likely do that part.

The judgement half is not, and it is where the axis score comes from:

- **Knowing when to emit `null`.** Both ordinals are our own rubrics, and the correct
  behaviour under thin evidence is abstention — which is the behaviour models are least
  naturally inclined toward, because a filled field looks more helpful than an empty
  one. `switching_cost` carries the single largest weight on the `idea_vs_market` axis
  (+20 / 0 / −15), so a model that guesses rather than nulls moves an investment score
  on nothing. This is the specific failure Undesired Example 1 in the prompt is built
  around.
- **Refusing the founder's own claim as verification.** "We're 10× faster" in a deck is
  the thing under examination, not evidence for it. Holding that line requires tracking
  the provenance of an assertion across the context, not just its content.
- **Keeping «identified» and «displaced» apart.** Two predicates a page apart in the
  prompt, feeding two different downstream terms, where the wrong one inflates the
  score.

Sol would do all this marginally better at 2× the price — but unlike the sizer, a
mistake here degrades gracefully: a wrong `threat_level` moves one axis term by at most
20 points on a 0–100 scale, whereas a fabricated TAM propagates into the memo as a
headline number. The design's tiering (Sol for sizing, Terra for landscape, Luna for
classification) tracks blast radius, and it tracks it correctly.

## Runtime parameters

| Parameter | Value | Rationale |
|---|---|---|
| `temperature` | **0** | Typed extraction with a hard provenance contract. Design §4 pins `end_date` so runs reproduce; a stochastic competitor set would make the demo non-reproducible and the `content_hash` recipes (§3.5) churn new claim rows for no reason. If the API rejects `temperature` on reasoning-enabled requests, drop it and rely on `reasoning_effort` plus strict schema enforcement. |
| `reasoning_effort` | **`medium`** | Enough to weigh the two ordinals against the documents; not enough to start theorising about the market. Raise to `high` only if E1 shows the ordinals being guessed rather than nulled — though the more likely fix for that is the prompt, not the budget. |
| `text.verbosity` | `low` | Fixed JSON output. `positioning_summary` and the two rationale fields are capped in the schema precisely to stop them growing into essays; §9's memo rule is explicit that padding works against you. |
| `response_format` | JSON Schema (strict), from `competitive-analyst-agent-json-schema.json` | Enforces the four enums (`category`, `stage`, `coverage`, `reason_code`), the 1..4 / 1..3 ordinal ranges, and `source_urls` `minItems: 1`. That last constraint is the structural guarantee that no competitor is recalled from training data rather than found in the input — a rule that would otherwise rest entirely on the prompt. |
| `max_output_tokens` | 6,000 (visible) | Above the 3,500-token rich-landscape case with headroom. |
| Retry | 1 re-ask with the schema restated, then abstain | Design §4 error branch — "never a partial parse". |

### What strict schema mode cannot enforce, and must be checked downstream

Three conditional invariants that JSON Schema expresses awkwardly and that the
deterministic node should assert instead:

1. `threat_level_rationale` non-null **iff** `threat_level` non-null.
2. `switching_cost_rationale` non-null **iff** `switching_cost` non-null.
3. `displacement_source_url` non-null **whenever** `displaced` is `true`; and
   `most_recent_funding.amount` non-null **only if** `most_recent_funding.source_url`
   is non-null.

The prompt states all four; design §3.3 already requires the ordinals to be
"range-checked deterministically" after emission, so these checks belong in the same
node. A violation should null the offending value rather than fail the run — the same
degrade-don't-fail posture as §4's error branches.

## Endpoint

Chat Completions or Responses — both supported on 5.6. No hosted tools: this agent never
searches, it only reads what the workflow already fetched. That separation is what makes
"every competitor traces to a document in the input" checkable rather than merely
requested.

## What would change this recommendation

- If E1 finds guessed ordinals surviving into the database, fix the prompt first, then
  the deterministic range-check, then consider Sol. In that order.
- If competitor counts routinely exceed 8, revisit `max_output_tokens` and the
  truncation cap together — not one without the other.
