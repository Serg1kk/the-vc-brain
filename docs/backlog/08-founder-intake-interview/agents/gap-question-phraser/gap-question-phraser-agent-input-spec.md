# `gap-question-phraser` — input specification

Agent type: **pipeline step** (generation, no tools). Called twice in the feature: once inside
`f08-intake-submit` to fill `gap_questions[]` in the frozen response, and once when a manager
generates a follow-up link (`design.md` §9), which uses the identical output shape
(`lovable-brief.md` §4.4 `questions[]`).

## The division of labour that defines this agent

**Selection is code. Phrasing is the model.** (`design.md` §6.)

The workflow reads `score_formulas.config.criteria` (a jsonb **array**, filtered to
`axis='founder_score' AND active`), keeps criteria whose `neg_src` contains **only** `deck_parse`
and `interview_answer`, drops the ones already covered, and ranks by `weight`. Against the live
seeded config exactly three qualify:

| Criterion | Weight | Anchor |
|---|---|---|
| L2 | 0.15000 | First customers / LOI / pilot evidence |
| L3 | 0.09000 | ICP specificity: vertical + size + buyer role + trigger + current alternative |
| X5 | 0.05625 | Describes competitors at insider granularity (where deals are lost, what breaks in production) rather than pricing-page level |

X1 (0.09375) and X2 (0.07500) carry `tavily_extract` in `neg_src` — public sources can reach them,
so they are **not** asked.

The model never sees this rule and never decides how many questions to write. It receives the
already-selected list and emits **exactly one item per entry**. That is what makes the choice
explainable, immune to eloquence, and identical on every run.

⚠️ **The coverage check excludes claims with `verification_status='missing'`** ⟨R-7⟩. Feature 07
writes gap markers as claims on every full gate call; a naive "does a claim exist for this topic?"
would read an explicit *absence* as coverage and suppress exactly the question worth asking.
Convention: base topic + `verification_status='missing'` (`07/design.md:734` is authoritative over
the `.gap` suffix in `07/handoff.md` §4). Handle both shapes defensively.

## Variables the n8n node receives

```jsonc
{
  "card_context": {
    "company_name": "Northbound Freight OS",       // required
    "what_is_built": "Route planning for regional carriers",  // from 07's company.what_is_built claim; null if absent
    "sector": "logistics",                         // from 07; null if absent
    "geography_country": "DE",                     // from 07; null if absent
    "deck_readable": true,                          // extraction_mode !== 'none'
    "public_footprint": [                           // what the system actually looked at
      { "kind": "github_repo", "url": "https://github.com/acme/core" },
      { "kind": "product",     "url": "https://acme.dev" }
    ],
    "known_claims": [                               // short verbatim echoes, ≤8, so the model never re-asks
      { "topic": "founder.expertise.vertical_tenure", "text_verbatim": "Previously at Halder Freight." }
    ]
  },
  "selected_criteria": [
    { "criterion_id": "L2", "anchor": "First customers / LOI / pilot evidence", "weight": 0.15 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `card_context.company_name` | yes | Never quoted back mechanically; context only |
| `card_context.deck_readable` | yes | **Load-bearing.** `false` forbids any "your deck doesn't mention…" `why` line — we never read it, and the founder would catch the lie |
| `card_context.what_is_built` / `sector` / `geography_country` | no | Present when 07's gate call produced them; all may be `null` on the `extraction_mode='none'` branch, where the gate returns `insufficient_evidence` (`design.md` §3.3) |
| `card_context.public_footprint` | no | Lets `why` name what we actually looked at, which is the personalisation that earns the answer |
| `card_context.known_claims` | no | Capped at 8 verbatim snippets. Prevents re-asking a fact already on the card |
| `selected_criteria` | yes | 1..3 entries, pre-ranked by weight. Empty ⇒ the workflow skips the call entirely and returns `gap_questions: []` |

`selected_criteria` is **never empty in practice**: the workflow does not call the model when the
selection is empty, because the frozen contract treats `gap_questions: []` as a valid, expected
response meaning the deck covered everything unreachable (`lovable-brief.md` §4.1). The prompt still
handles the empty case so a mis-wired branch fails visibly rather than inventing questions.

## Output goes straight to the founder

The four fields are rendered directly by the built frontend (`lovable-brief.md` §7.2): `question` as
the card title, `why` beneath it under a small "why we're asking" label, `placeholder` on the
textarea. **There is no human review step between this model and the founder's screen.** That is why
the forbidden-vocabulary rule is enforced in the prompt *and* must be enforced again in code — see
the validation gate below.

## Backend obligations around the call

- Write `ai_runs` **before** the questions reach the response ("model proposes, backend decides"),
  `task_type='question_generation'`, carrying `application_id` and `founder_id` (`design.md` §4.1).
- **Validate every item in code before returning it**, and drop the whole item on failure:
  1. `criterion_id` ∈ the ids that were sent, exactly one item per sent id, same order;
  2. length caps: `question` ≤ 140, `why` ≤ 120, `placeholder` ≤ 120;
  3. **forbidden-substring scan, case-insensitive**, over all three strings:
     `interview`, `assess`, `evaluat`, `screening`, `screen`, ` test`, `vetting`, `candidate`,
     `applicant`, `your score`, `ranking`. A stem list, not a word list — inflections are the leak.
  4. exactly one `?` in `question`.
- If validation drops an item, fall back to the **static per-criterion question** recorded in
  `tbd-items.md` D-4 rather than shipping nothing: a missing question silently loses 0.15 of
  reachable founder-score weight, which is worse than a slightly less personal one.
- Persist the generated set to `interviews.transcript` with per-question answered/skipped state,
  `kind='first'` here and `kind='follow_up'` for the manager-initiated set (`design.md` §8).
  Without this, `open_questions` in the status contract has no source.
