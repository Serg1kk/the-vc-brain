# `thesis-attribute-extractor` — Model Recommendations

> Assigned by design.md §4: **`gpt-5.6-luna`**, `temperature = 0`, structured output.
> This document justifies that assignment, fixes the runtime parameters, and states the
> cost honestly. It does not reopen the choice.
> Pricing source: `internal/research/openai/02-models.md` (collected 2026-07-18), same
> figures feature 04 used.

## Token estimate

Measured, not guessed: the system message in `thesis-attribute-extractor-agent-prompts.txt`
is 27,153 characters.

| Component | Tokens | Notes |
|---|---|---|
| System prompt (XML, EAP-structured) | **~6,800** | Static across every call. Larger than 04's categorizer (~5,100) because the negative criteria are enumerated per field and there are five worked examples — both are load-bearing, see «Why the prompt is long» below. |
| User message — `structured_hints` | ~20–120 | Usually `{}`. |
| User message — `gate_text`, thin (Show HN post) | ~200–400 | |
| User message — `gate_text`, typical (HN + README + page text) | ~1,000–3,000 | |
| User message — `gate_text`, deck (capped at 24k chars) | ~2,000–6,000 | Cap set in the input spec; the head is kept. |
| **Input total** | **~7,000–13,000** | Typical ≈ 8,400. |
| Output (JSON) | ~350–550 | `reasoning` is capped at 1,200 chars (~300 tokens); five quotes at up to 300 chars each dominate the rest. The all-null record is the *cheapest* output, ~150 tokens. |

Nowhere near the 272K threshold at which Sol/Terra/Luna apply the 2× input / 1.5× output
surcharge, even for a maximal deck. This agent never ingests fetched web content.

## Cost per call

Luna: **$1.00 / 1M input · $6.00 / 1M output · $0.10 / 1M cached input.**

| Scenario | Input | Output | Cost |
|---|---|---|---|
| Thin (7,050 in / 350 out) — radar candidate | $0.0071 | $0.0021 | **$0.0092** |
| Typical (8,400 in / 450 out) | $0.0084 | $0.0027 | **$0.0111** |
| Full deck (13,000 in / 550 out) | $0.0130 | $0.0033 | **$0.0163** |

One call per application in `mode='full'`, and **zero** calls in `mode='keyword'` — the
radar's Tier 1 population, which is the high-volume path, never reaches this node at all
(§6.1). At ~$0.011 per gated application, 100 demo applications cost **≈ $1.10** against the
$50 shared hackathon pool.

**A discrepancy worth stating plainly.** Design §4 cites NotebookLM's «roughly $0.0014 per
deal» for the gate. Our arithmetic, on our own measured prompt at published Luna pricing,
lands about **8× higher**. §4 already labels that figure single-source (MIRAGE-VC), likely
conflating tiers, «order of magnitude only, **not** a pitch number» — this is what that
caveat looks like when cashed out. Use **$0.011/application** internally and do not put
$0.0014 in front of judges.

**Caching — the arithmetic, so the builder can decide rather than inherit.** The system
prompt is 82% of a typical call's input and is byte-identical across every call, which is
the ideal cache shape. Per-call saving on a cache hit: 6,800 × ($1.00 − $0.10)/1M =
**$0.0061**, taking a typical call from $0.0111 to ~$0.0050. If the provider charges a 1.25×
cache-write premium (the figure feature 04's D9 worked from), the write costs a one-time
$0.0017 and is repaid by the **first** subsequent hit inside the TTL — a far shorter payback
than 04 faced, because our static share is larger in absolute tokens.

**Verdict: still skip it for MVP, but for an operational reason rather than an economic
one.** $1.10 of total spend is not worth an explicit cache breakpoint that can misbehave on
stage, and a 30-minute TTL does not survive a demo where the gate is run once, live. If the
provider applies prefix caching automatically at no write premium, take it for free and
change nothing. Revisit only if a batch backfill runs hundreds of applications back to back.

## Model comparison

| | **Luna (assigned)** | Terra | Sol |
|---|---|---|---|
| Input / 1M | $1.00 | $2.50 | $5.00 |
| Output / 1M | $6.00 | $15.00 | $30.00 |
| Cost per typical call here | **$0.0111** | $0.0278 | $0.0555 |
| Context | 1.05M | 1.05M | 1.05M |
| Reasoning label (docs) | High | Higher | Highest |

**Why Luna fits this job.** The task is span location plus closed-set labelling: find a
sentence, apply a disqualification list, pick one of ten / six / four values, or emit `null`.
There is no evidence to weigh against competing sources, no arithmetic, and no synthesis —
by construction, because D-02 removed the only judgement that would have needed a bigger
model. The moment you put the thesis in this prompt you create a genuinely hard reasoning
task («does this company fit our mandate?») and simultaneously make the answer untrustworthy;
the design's decision to split extraction from evaluation is what makes a cheap model
correct here rather than merely affordable. Luna is also not a weak tier despite the naming
— per the model research the 5.6 rename came with a capability jump, and instruction
adherence on a strict JSON contract is not the binding constraint.

**Where the real risk sits, and why a bigger model is not the fix.** The failure mode that
matters is not «Luna picked the wrong sector»; it is «Luna inferred `DE` from a `.de`
domain», i.e. an inference that *feels* correct. That is a prompt-and-validator problem, and
we address it three ways that a larger model would not: explicit negative criteria per
field, a required verbatim quote, and a deterministic substring check downstream. Escalating
to Terra would cost 2.5× and leave all three of those doing the same work.

## Why the prompt is long, and why that is the right trade

6,800 static tokens is $0.0068 per call. The alternative — a terse prompt — buys back
~$0.004 per application and gives up the enumerated negative criteria, which are the only
thing standing between the model and the four inferences that look most reasonable
(ccTLD → country, product noun → `b2b`, waitlist → `early_revenue`, using AI → `ai-infra`).
Each of those, filed once, becomes a permanent sourced `claims` row that nobody re-reads.
At $1.10 of total feature spend, trading correctness for prompt length here would be
optimising the wrong number by two orders of magnitude.

## Runtime parameters

| Parameter | Value | Rationale |
|---|---|---|
| `temperature` | **0** | Mandated by design §4. Extraction with a fixed vocabulary has no creative surface, and a stochastic `sector` would make the gate's verdict irreproducible for the same input — which would in turn make `input_fingerprint` (§5.1) meaningless as a retry key. |
| `top_p` | 1 (default) | Do not tune alongside `temperature`. |
| `reasoning_effort` | **`low`** | Deliberate. The reasoning procedure is already externalised into the prompt's `<chain_of_thoughts>` and the required `reasoning` field, which is the cheaper and *more auditable* form of the same work: it is persisted on the `ai_runs` row and QA can read it, whereas hidden reasoning tokens are billed at output rates and inspectable by nobody. **Escalation trigger:** if the QA pass finds negative-criteria violations — a country grounded in a domain string is the canary — raise to `medium` before touching the prompt. |
| `text.verbosity` | `low` | Output is a fixed object; verbosity only inflates `reasoning` past its 1,200-char cap. |
| `response_format` | JSON Schema (**strict**), from `thesis-attribute-extractor-agent-json-schema.json` | Non-negotiable. Strict mode is what guarantees all eight top-level keys and all five `quotes` keys are present in every response, and that the vocabulary values are exactly §1.1's closed sets — enforced by the API rather than requested in prose. |
| `max_output_tokens` | 1,500 | Comfortably above the 550-token worst case. A response approaching this is malformed and should take the retry branch. |
| Retry | 1 re-ask with the schema restated, then the all-null record | Mirrors 04's error branch. The all-null record is a *legal* outcome that flows through the gate correctly (coverage → 0 → `insufficient_evidence`, D-07), so no error status code is needed in the schema. |

## Strict-mode schema caveat — read before wiring the node

OpenAI strict structured outputs support a **subset** of JSON Schema. The schema file is
written as valid draft 2020-12 for documentation value; if the API rejects it, strip the
following and rely on the downstream validator, which already checks all of them:

| Keyword used | If rejected |
|---|---|
| `minLength` / `maxLength` (strings) | Strip. Validator truncates `what_is_built` at 400 and `reasoning` at 1,200. |
| `pattern` on `geography_country` | Strip. Validator applies `/^[A-Z]{2}$/`. |
| `uniqueItems` / `maxItems` on `missing_fields` | Strip. Validator dedupes and filters to the five legal keys. |
| `enum` containing `null` alongside `"type": ["string","null"]` | If rejected, express as `anyOf: [{enum:[…]}, {type:"null"}]`. |

**What must survive under any circumstances:** `additionalProperties: false`, the full
`required` list at both levels, the property **order** with `reasoning` first, and the enum
value sets. Those four carry the design guarantees; the rest is belt-and-braces.

**What strict mode cannot do, and therefore must not be assumed:** the conditional
`quotes.X` non-null **iff** `X` non-null **iff** `X ∉ missing_fields`. `if`/`then`/`allOf`
are unsupported. This invariant is enforced by the deterministic validator node — see the
input spec. Wiring the LLM node straight into the `claims` writer without that validator
would allow an ungrounded value to reach a NOT NULL `text_verbatim` column.

## Endpoint

Chat Completions or Responses — both supported on 5.6, and no Responses-only feature is
required here (no tools, no web search, no multi-agent). Use whichever the n8n OpenAI node
targets by default. The `/v1/responses`-only restriction in CLAUDE.md applies to the Pro and
codex models, not to Luna.

## What would change this recommendation

- **QA finds ungrounded values surviving the validator** → the fix is the prompt's negative
  criteria and the substring check, in that order. Do not reach for Terra first.
- **QA finds `reasoning` composed after the fact** (a value that no part of the reasoning
  located) → raise `reasoning_effort` to `medium`; this is the one symptom that a bigger
  reasoning budget genuinely addresses.
- **Decks routinely exceed the 24k-char cap with attributes in the tail** → raise the cap
  before changing models; input is $1/1M and there is 1.05M of context.
- **The extractor is ever asked to score, rank, or assess fit** → that is a different agent
  and a different model tier, and it would violate D-02. Route it to feature 06's memo
  agent, which is where a mandatory decision legitimately lives.
