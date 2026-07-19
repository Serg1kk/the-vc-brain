# `suggest-followup-questions` — input specification

Agent type: **pipeline step** (generation, no tools). Called once inside `f09-suggest-followup`
(investor dashboard, feature 09), after the workflow has already resolved the application, pulled
its gap sources and run deterministic selection.

## The division of labour that defines this agent

**Selection is code. Phrasing is the model.** Same split as the sibling agent
`gap-question-phraser` (feature 08) — but this agent phrases for a different mouth.

The workflow reads three gap sources for an application and turns two of them into `gap_items` for
this agent:

1. **Contradictions** (`events` where `event_type='claim_contradicted'`) — **never reach this
   agent.** They already carry a fully-formed `payload.question` string written by feature 05's own
   pipeline at verification time. The workflow reuses that string verbatim and builds its `why` from
   `payload.founder_claim` / `payload.found_reality` / `payload.checked_at`, all in code, zero model
   calls. Mentioned here only so it's clear why contradictions never appear in `gap_items`.
2. **Founder-score gaps** (`api_founders.founder_score_gaps[]`) — become `kind: "founder_score_gap"`
   items. Each carries `what_would_close_it`, a string already written in investor-facing prose by
   feature 03's own evidence-audit process (e.g. *"Evidence of a real customer commitment, such as a
   paying customer, signed LOI, named pilot with an outcome..."*). That string describes **what
   evidence would close the gap**, not a question — this agent's job is exactly that conversion.
3. **Missing claims** (`claim_trust.derived_status = 'missing'`, joined to `api_claims` for the
   `topic` slug, application-scoped) — become `kind: "missing_claim"` items. Each carries only a
   dotted taxonomy slug, e.g. `company.business_model`. No prose is supplied; the agent derives the
   question from the topic name itself, the same way `gap-question-phraser` derives phrasing from an
   `anchor` string for an unlisted `criterion_id`.

The model never sees which gap source produced an item, never sees weights or ranking, and never
decides how many questions to write — it receives an already-capped, already-ranked list (0–6 items,
never called on an empty list — see below) and emits **exactly one item per entry, same order**.

## Register — the one thing this agent must get right

This is the fact that makes this agent different from `gap-question-phraser` and is worth stating
plainly rather than inferring from the output shape: **the founder-facing sibling writes to a
first-time applicant filling in an optional web form**, so it is deliberately coaxing and hides that
anything is being evaluated (the "Mom Test", forbidden words like `assess`/`screening`). **This agent
writes words for the investor's own mouth**, spoken out loud on a call the founder already agreed to,
one professional to another. It should sound like a prepared, curious colleague — direct and
businesslike, never a coaxing form, and never an interrogation. The founder already knows this is a
diligence call; the agent does not need to hide that, it only needs to avoid sounding like an
accusation (see restrictions).

## Variables the n8n node receives

```jsonc
{
  "company_context": {
    "company_name": "Northbound Freight OS",        // required
    "one_liner": "Route planning for regional carriers",  // string | null
    "sector": "logistics"                             // string | null
  },
  "gap_items": [
    {
      "ref_id": "fsg:03f00001-...:L2",                 // required, opaque, ECHOED verbatim
      "kind": "founder_score_gap",
      "criterion_label": "First customers / LOI / pilot evidence",
      "what_would_close_it": "Evidence of a real customer commitment, such as a paying customer, signed LOI, named pilot with an outcome, documented discovery interviews showing consistent demand, or a waitlist with measured conversion."
    },
    {
      "ref_id": "mc:010e717b-...",
      "kind": "missing_claim",
      "topic": "company.business_model"
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `company_context.company_name` | yes | Used for natural phrasing only ("your company" is fine too); never quoted back mechanically |
| `company_context.one_liner` / `sector` | no | Light context only — may be `null`. Do not lean on these to invent specifics the gap item itself doesn't state |
| `gap_items[].ref_id` | yes | Opaque correlation id. Echoed **exactly**, never altered, never re-derived |
| `gap_items[].kind` | yes | `"founder_score_gap"` or `"missing_claim"` — determines which of the two fields below is present |
| `gap_items[].criterion_label` / `what_would_close_it` | yes when `kind="founder_score_gap"` | `what_would_close_it` is already investor-language prose describing missing evidence, not a question |
| `gap_items[].topic` | yes when `kind="missing_claim"` | Dotted taxonomy slug. See the topic playbook in the prompt for the topics seen live; derive phrasing from the slug's own words for anything unlisted |
| `gap_items` | yes | **1–6 entries.** The workflow never calls the model on an empty list — when deterministic selection produces zero items across all sources, the workflow returns `{"questions": [], "reason": "..."}` directly, no model call. The prompt still states the empty-in/empty-out rule so a mis-wired caller fails visibly rather than inventing a question. |

## Output goes straight to the investor's screen

The two fields (`question`, `why`) are rendered directly in the "Suggest follow-up questions" modal
(`lovable-brief.md` §9.4) with **no human review step between this model and the screen** — same
"model proposes, backend re-validates in code" pattern as `gap-question-phraser`. That is why the
forbidden-vocabulary and accusation-framing rules are enforced in the prompt *and* re-checked in code
after the call (stem scan + length caps + question-mark count), with a static per-`kind` fallback
question substituted for any item that fails validation rather than dropping it silently.

## Backend obligations around the call

- Write `ai_runs` (`task_type='question_generation'`, `application_id`, model, input hash) before the
  questions reach the response — same "model proposes, backend decides" audit convention as feature
  08's identical write.
- **Validate every item in code before returning it, drop-and-substitute on failure:**
  1. `ref_id` present in the input set, exactly one item per sent id, same order;
  2. length caps: `question` ≤ 160, `why` ≤ 140;
  3. **forbidden-substring scan, case-insensitive, stems not whole words** — see the prompt's
     restrictions section for the exact list;
  4. exactly one `?` in `question`.
- On a validation failure for a given item, substitute a static fallback built from the item's own
  `kind` (`founder_score_gap` → a generic-but-safe rephrasing of `what_would_close_it`;
  `missing_claim` → a generic-but-safe rephrasing of `topic`) rather than shipping nothing — a
  dropped question silently shrinks the "where to dig" set the whole feature exists to produce.
