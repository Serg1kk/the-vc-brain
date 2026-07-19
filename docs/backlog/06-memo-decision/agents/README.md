# Feature 06 — memo-agent family (ai-agent-builder artifacts)

Four LLM agents author the narrative of the investment memo. The **recommendation is NOT here** —
it is a deterministic rule engine (`lib/f06/decision.js`, design §8). These agents produce prose
only, and are structurally forbidden from emitting a recommendation verb.

> Authored via the `ai-agent-builder` skill (EAP framework). Under the hackathon clock the standard
> 5-artifact-per-agent set is **consolidated**: this README carries the shared input-spec, model
> recommendation and TBD log; each agent ships its `*-prompts.txt` (system+user) and
> `*-json-schema.json` (the strict-mode output contract). Design source of truth: `../design.md`.

## The four agents

| Node | Agent | Writes (`sections` keys) | Prompt file |
|---|---|---|---|
| B1 | `memo-descriptive` | `snapshot`, `problem_product`, `traction` | `memo-descriptive/memo-descriptive-prompts.txt` |
| B2 | `memo-analytical` | `hypotheses`, `swot` | `memo-analytical/memo-analytical-prompts.txt` |
| B3 | `memo-optional` | `risk_matrix`, `competition`, `financials_lite` | `memo-optional/memo-optional-prompts.txt` |
| B4 | `deep-dive-questions` | (top-level `deep_dive_questions`) | `deep-dive-questions/deep-dive-questions-prompts.txt` |

## Shared input contract (the context-pack slice each agent receives)

`[A]` builds one pack; each agent's n8n Code node passes that agent its slice as the user-message
JSON. Common envelope (exact keys):

```jsonc
{
  "application_id": "<uuid>",
  "company": { "name": "...", "stage": "pre_seed|seed", "category": "...|null",
               "kind": "inbound|radar_activated" },
  "allowed_claim_ids": [ "<uuid>", ... ],          // THE hard whitelist — cite only from this set
  "claims": [ { "claim_id": "<uuid>", "topic": "founder.execution.provenance",
                "text_verbatim": "...", "value": { ... }|null,
                "source_kind": "self_reported|public|interview|voice|derived",
                "derived_status": "verified|partially_supported|unverified|contradicted|missing",
                "router_class": "factual_static|factual_dynamic|qualitative|forecast|unverifiable|precomputed" }, ... ],
  "gaps": { "not_disclosed":[...], "missing_axes":[...], "missing_fields":[...],
            "low_coverage":{...}, "contradictions":[ { "claim_id","severity","nature","topic" } ] },
  "axes": { "founder":{value,assessed}, "market":{...}, "idea_vs_market":{...} },
  "founder_score": { "value": 34.0|null, "assessed": true|false },
  "trust": { "value": 19.5|null, "assessed": true|false, "coverage": 0.667|null }
}
```

B3 additionally gets `competitors[]` (topic `competition.*` claims) and the contradiction list.
B4 gets `gaps` + contradictions + the ambiguous-claim subset + the weakest assessed axis label.

**`derived_status` is the authoritative per-claim verdict** (from `claim_trust`), never
`verification_status`. Agents may cite a `contradicted`/`unverified` claim, but must surface its
status honestly (the renderer badges it) — they must never silently present it as established.

## Universal rules (baked into every agent's `<restrictions>`)

1. **Cite `claim_id`s from `allowed_claim_ids` only.** A `fact` statement with an id outside that set
   is rejected downstream (`[D]` hard gate) and fails the whole memo. Never invent an id.
2. **Never fabricate.** A missing number → a `not_disclosed` statement, never an invented figure.
3. **Benchmarks are ranges, not valuations.** Any comparable is phrased as a labelled range with
   "range, not a valuation" and a survivorship caveat.
4. **No padding.** Say less. A section with nothing to say ships one honest line, not filler.
5. **Never emit a recommendation.** The strings `proceed`, `proceed-with-conditions`, `pass`,
   `watchlist` (or any invest/pass verdict) must not appear in any statement — that is the rule
   engine's sole output.
6. **English output.** Neutral, factual register. No superlatives, no hype, no accusation (esp. on
   contradiction-derived text — "consistent with a rewritten history", never "lied").

## Model recommendation

- **Model:** `gpt-5.6-luna` (extraction/generation workhorse; project stack rule for
  scoring/extraction/batch). Same model f03/f04/f05 use for their LLM nodes.
- **Temperature:** **omitted** — luna returns HTTP 400 on `temperature:0` and we do not want the
  variance of `1`. (This is why memo prose is not bit-reproducible across regenerations; each
  regeneration is a new `memos.version`, which is the honest record.)
- **Structured output:** `response_format` = `json_schema`, `strict:true`. Every schema in this
  folder MUST pass through the recursive `strictify()` in `build-f06-workflow.py` at embed time
  (OpenAI strict mode rejects `oneOf/allOf`, all `min/max/pattern/format`, free-form objects, and
  requires every property in `required` + `additionalProperties:false` everywhere — TRACKER 11:20).
  The schemas here are already written to those constraints.
- **Token envelope (typical):** input pack slice 1–4k tokens; output 400–1200 tokens per section
  group. Cost is negligible at luna rates; the four calls run in parallel (§5 fan-out).

## TBD / decisions

- **DECIDED (2026-07-19):** 3 narrative nodes grouped by cognitive type, not 8 one-per-section
  (design §5.4). Rationale there.
- **DECIDED:** the recommendation verb is a hard exclusion from all four agents (invariant I6 +
  OSS `reporting`'s partner-only ban); only `lib/f06/decision.js` emits it.
- **DECIDED:** benchmark = labelled range only (research contrarian #3, survivorship risk).
- **OPEN (non-blocking):** whether `memo-optional` should also draft a one-line "why the axes
  diverge" sentence for the snapshot, or leave axis-divergence rendering entirely to 09. Currently
  left to 09 (it renders the three axis chips). Revisit only if the demo needs it in-prose.
