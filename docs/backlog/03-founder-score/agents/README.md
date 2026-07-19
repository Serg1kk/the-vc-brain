# Feature 03 — Sub-scorer agent specifications

Built via the `ai-agent-builder` skill (mandatory per CLAUDE.md: product AI logic is an artifact,
never improvised). Spec: [../design.md](../design.md) §3, §4.4, §4.7, §4.8, §4.9.

Four agents, all **pipeline-step classifiers** — they do not converse, do not call tools, and do
not produce prose for humans. Their consumer is a deterministic backend gate (`lib/f03/gate.js`),
which is why the output is a rigid JSON contract and why every field they emit is either
overridden or verified downstream.

| Agent | File | Criteria | Sub-scorer weight |
|---|---|---|---|
| execution-signals | [execution-signals.md](execution-signals.md) | E1, E3, E4, E5, E7 | 0.40 |
| expertise-signals | [expertise-signals.md](expertise-signals.md) | X1, X2, X5, X6 (+ `pedigree`) | 0.30 |
| leadership-sales-proxies | [leadership-sales-proxies.md](leadership-sales-proxies.md) | L2, L3, L5 | 0.30 |
| red-flags | [red-flags.md](red-flags.md) | R1, R2, R4 | none (separate stream) |

## Shared input contract (design §4.7)

Each agent receives one routed context pack. Packs are built by `lib/f03/run.js` (and by the n8n
workflow), routed by `claims.topic` prefix; `red-flags` receives the **union** of all claims
because it needs cross-cutting visibility to spot contradictions.

```jsonc
{
  "founder": { "id": "uuid", "full_name": "…", "headline": "…", "location_country": "…" },
  "company": { "name": "…", "one_liner": "…", "category": "…", "stage": "pre_seed" },
  "claims": [
    { "claim_id": "uuid",
      "topic": "founder.execution.merged_prs",
      "text_verbatim": "…",           // the ONLY quotable string, alongside evidence quotes
      "source_kind": "public",         // self_reported|public|interview|voice|derived
      "raw_signal_source": "github_api",
      "evidence": [
        { "tier": "documented", "quote_verbatim": "…", "source_url": "https://…" }
      ] }
  ]
}
```

Cap: `max_claims_per_agent` = 40, ordered by `evidence.tier` (documented → discovered → inferred)
then `claims.created_at` desc. Claim text is **formatting-normalised before judging** — style bias
is the dominant LLM-judge bias (0.10-0.76, vs ≤0.04 for position bias) and favours markdown; a raw
scraped footprint must not lose to a well-formatted deck on presentation alone.

## Shared output contract

```jsonc
{
  "subscorer": "execution-signals",
  "verdicts": [
    { "criterion_id": "E1",
      "reasoning": "…",               // ALWAYS before verdict — forces the analysis first
      "verdict": "met",               // met | self_asserted | not_met | cannot_assess (LOWERCASE)
      "claim_ids": ["uuid", …],       // REQUIRED for met/self_asserted; [] otherwise
      "quote_verbatim": "…",          // EXACT substring of a cited claim's text or evidence quote
      "rationale": "…",               // interpretation — kept separate from the quote (RSK-003)
      "what_would_close_it": "…" }    // REQUIRED for cannot_assess; null otherwise
  ]
}
```

`red-flags` uses a different shape — see its file.

## What the agents are forbidden to decide (design §4.4)

These are **backend** decisions. The gate overrides whatever the model says, but the prompts must
not invite the model to try:

- **`evidence_tier`** — assigned in gate step 6a from the cited claims' actual evidence.
- **Whether `not_met` is permissible** — gate step 5 coerces `not_met` → `cannot_assess` unless a
  claim from a competent source (`neg_src`) is present. The model may still *propose* `not_met`;
  it simply is not the authority on whether the absence was actually observed.
- **`credit`, `weight`, `contribution`, and the score itself** — pure arithmetic, computed in
  `lib/f03/scoring.js`. No agent ever sees or emits a number that reaches the score.

## Model & parameters (design §4.8)

**`gpt-5.6-luna`, temperature OMITTED**, JSON response format, one call per agent, 4 calls per
founder.

⚠️ The model **rejects `temperature: 0`** (HTTP 400, «Unsupported value: 'temperature' does not
support 0 with this model»), verified live 2026-07-19. Send no `temperature` at all rather than 0
or 1. The score stays deterministic regardless — the agents emit only booleans and citations, and
all arithmetic happens in `lib/f03/scoring.js`. Sampling variance can still flip an individual
verdict, which is what `db/fixtures/recorded/` exists to pin down for demos and tests.

Rationale: Exa's LLM-as-judge review found a mid-tier model with debiasing reached the highest
human agreement of any configuration tested (71.0%, κ=0.549) at ~15× lower cost than the best
frontier setup. With $50 of hackathon credits shared across the operator's other pipelines, and
`luna` being the designated extraction/classification/scoring model in CLAUDE.md, this is the
right tier. The task is classification against anchored criteria, not open reasoning — the
regime where mid-tier models are reliable.

Estimated cost per founder: 4 calls × (~2-4k input + ~600 output tokens). Three fixture founders
per full run. Recorded-mode replay (`run.js --recorded`) means integration testing costs nothing.

## Prompt-construction rules applied to all four (design §4.8)

1. `reasoning` before `verdict` in the schema — the model commits to analysis before a label.
2. Every criterion **anchored** with a concrete definition of what `met` looks like — never a bare
   label. Unanchored scales are how judges drift.
3. **Negative criteria stated explicitly** to counteract sycophancy — without them, judges strain
   to mark positive criteria MET across answers of wildly varying quality.
4. **`cannot_assess` is first-class and explicitly encouraged**, not a failure state. This is the
   single most important primitive for REQ-003: a founder we know nothing about must produce
   honest silence, not a low score.
5. Lowercase verdict enum, matching the DB CHECK exactly.
6. One agent = one concern. Never several dimensions in a single judgement.

## Decisions & open items

**Decided during this build (operator asleep, authority delegated):**

- *Agents emit `not_met` freely, gate polices it.* Alternative was forbidding `not_met` in the
  prompt entirely. Rejected: the model genuinely does observe absence sometimes, and suppressing
  the signal in the prompt would lose information the gate can use. Enforcement belongs in code.
- *`pedigree` extraction assigned to `expertise-signals`* rather than a fifth agent — it already
  reads tenure and employer claims, so it is free. A fifth call for a block that carries no weight
  would be poor value.
- *No few-shot examples drawn from real founders.* All examples are invented, to avoid teaching
  the model to pattern-match on a specific real person (RSK-004, survivorship bias).

**Open, deliberately not resolved now:**

- No Cohen's κ validation against hand-labelled cases (design §7 parks it). Until that exists,
  these prompts are unvalidated against human judgement — an honest gap, and one the tech video
  should not overclaim past.
- Multi-language claims: the packs may contain non-English text. Agents are told to judge content,
  not language, but this is untested.
