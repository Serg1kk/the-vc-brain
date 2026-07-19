# `market-sizer` — Model Recommendations

> Assigned by design.md §9: **`gpt-5.6-sol`**. This document justifies that assignment,
> fixes the runtime parameters, and flags the one place where this agent is genuinely
> expensive.
> Pricing source: `internal/research/openai/02-models.md` (collected 2026-07-18).

## Token estimate

| Component | Tokens | Notes |
|---|---|---|
| System prompt (XML, EAP-structured, 3 worked examples) | ~7,600 | Long by design. The three examples carry the abstention behaviour, the incumbent-sizing refusal and the don't-average rule — the three things this agent exists to do. Static across calls. |
| User message — company + category + geography + as_of_date | ~250 | |
| User message — `searches_performed[]` | ~150 | Five entries. |
| User message — `documents[]` | ~28,000–32,000 | **20 documents × 6,000 chars truncation cap** (see input spec). This dominates everything else. |
| **Input total** | **~36,000–40,000** | Typical ≈ 38,000. |
| Output — visible JSON | ~800–2,500 | Full model with 4–8 evidence rows sits near the top; a clean abstention near the bottom. |
| Output — reasoning tokens | ~800–6,000 | Billed at the output rate. Scales with `reasoning_effort`. |

### The 272K cliff — a hard constraint on the C1 builder

Prompts above **272K input tokens incur 2× input and 1.5× output pricing on the entire
request**. With a 1.05M context window this is easy to hit accidentally, and it is
silent. Twenty untruncated `/extract` results from long pages can plausibly reach
150K–250K tokens, and a bad day pushes past the line.

**The 6,000-char-per-document truncation is not a nicety — it is the guard.** At the cap
the payload sits an order of magnitude under the threshold. If the builder removes the
truncation, the cost model below is void.

## Cost per call

Sol: **$5.00 / 1M input · $30.00 / 1M output · $0.50 / 1M cached input.**

| `reasoning_effort` | Input | Output (visible + reasoning) | Cost per call |
|---|---|---|---|
| `low` | 38K → $0.190 | ~2,300 → $0.069 | **$0.26** |
| `medium` (default) | 38K → $0.190 | ~3,500 → $0.105 | **$0.30** |
| **`high` (recommended)** | 38K → $0.190 | ~8,000 → $0.240 | **$0.43** |
| `max` | 38K → $0.190 | ~15,000 → $0.450 | **$0.64** |

One call per card (plus at most one re-ask on non-conforming JSON, per §4).

**Budget reality check, stated plainly:** at `high`, 100 cards cost **~$43** against a
$50 hackathon credit pool that is *shared with the operator's other pipelines*. This
agent is where feature 04's model spend actually lives — the other two agents together
are under 5% of it. Two consequences:

1. For the recorded demo (a handful of cards), `high` is affordable and correct.
2. For any bulk run over ~40 cards, drop to `medium` first, and re-check credits before
   `high` is used again. Do not discover this at 03:00 on submission day.

**Caching:** worth reconsidering here, unlike the other two agents — the 7,600-token
system prompt is a stable prefix, and at $0.50/1M cached vs $5.00/1M uncached it saves
~$0.034/call. But cache write is billed at 1.25× uncached input and the minimum TTL is
30 minutes, so it only pays back across a tight burst of calls. **Not recommended for
MVP**; the saving is 8% of a call whose cost is dominated by the document payload,
which is never cacheable because it differs per card.

## Model comparison

| | Luna | Terra | **Sol (assigned)** |
|---|---|---|---|
| Input / 1M | $1.00 | $2.50 | $5.00 |
| Output / 1M | $6.00 | $15.00 | $30.00 |
| Cost per call here (`high`) | $0.086 | $0.215 | **$0.43** |
| Reasoning label (docs) | High | Higher | **Highest** |
| BrowseComp | — | — | **92.2% SOTA** |

**Why Sol, and why the 5× premium over Luna is the right trade exactly here.**

Every other component of feature 04 is either classification (Luna), typed extraction
(Terra) or deterministic arithmetic in a Code node. This is the one step where the
model has to *reason against its own priors*, and the priors are actively wrong:

- It must refuse to use figures it "knows", because market numbers in training data are
  disproportionately laundered report-mill figures that lost attribution on the way in.
  Suppressing confident recall in favour of "I can only use what is in this document"
  is a genuinely hard instruction-following problem, not a formatting one.
- It must recognise an incumbent-industry revenue figure *disguised* as a buyer anchor
  and abstain — a judgement that requires understanding what the product displaces.
  Design §1 calls the sizing approach "the single largest design decision in feature 04";
  this is the node where that decision is either honoured or quietly dropped.
- It must hold two conflicting sources apart as a spread instead of collapsing them,
  which is the default behaviour of a helpfulness-tuned model.
- It reads ~30K tokens of heterogeneous extracted web content and has to locate two
  specific anchors in it and quote them word for word.

Sol's BrowseComp result (92.2%, SOTA) is on precisely this shape of task — reasoning
over fetched web content. A cheaper tier failing here does not produce an obviously
broken output; it produces a *plausible, confident, wrong* TAM, which is the exact
failure the rubric's Trust criterion (25%) and REQ-004 punish, and which is invisible
until a judge asks "where did that number come from?".

## Runtime parameters

| Parameter | Value | Rationale |
|---|---|---|
| `temperature` | **0** | Numeric extraction with a hard provenance contract. Design §4 pins Tavily's `end_date` so a run reproduces tomorrow; a stochastic TAM would break that guarantee at the most visible point. If the API rejects `temperature` on reasoning-enabled requests, drop the parameter and rely on `reasoning_effort` plus strict schema enforcement. |
| `reasoning_effort` | **`high`** for the demo; `medium` for bulk runs | See the budget note above. `max` is not justified: the extra spend goes into exploring alternatives, and here the correct behaviour under uncertainty is to abstain, not to search harder for a number. |
| `reasoning.mode` | `pro` — **optional, only if a QA finding demands it** | Reliability mode, no separate model slug on 5.6. Adds cost; adopt only if E1 finds non-deterministic abstention decisions. |
| `text.verbosity` | `low` | Output is a fixed JSON object. Verbosity inflates `assumptions[]` and `note` strings into padding, and design §9's memo rule is explicit that padding works against you. |
| `response_format` | JSON Schema (strict), from `market-sizer-agent-json-schema.json` | Structurally enforces the closed `reason_code` enum, the `catalyst_kind` enum, the `supports_field` pattern and the `relation` enum. The `supports_field` regex in particular makes it impossible to attach an evidence row to a field that does not exist. |
| `max_output_tokens` | 4,000 (visible) | Above the 2,500-token worst case with headroom for the evidence array. |
| Retry | 1 re-ask with the schema restated, then abstain | Design §4 error branch — "never a partial parse". |

## Endpoint

Chat Completions or Responses — both supported on 5.6. Responses is preferable if the
builder wants `reasoning.context` control across the re-ask, but nothing here requires
it. No hosted tools are used: this agent never searches, it only reads what the
workflow already fetched. That separation is deliberate — it is what makes "every
number traces to a document in the input" checkable rather than merely requested.

## What would change this recommendation

- If E1 (adversarial QA) shows Sol at `high` still emitting a number without a
  resolvable `source_url`, the fix is the **validator**, not the model — the validator
  already drops such numbers by design (§3.4). Escalating to `max` would be treating a
  guaranteed-by-construction property as a probabilistic one.
- If the truncation cap is raised above 6,000 chars/document, recompute the cost table
  and re-check the 272K threshold before shipping.
- If credits run low, drop to `medium` before dropping to Terra. Reasoning depth is
  cheaper to trade away here than tier quality.
