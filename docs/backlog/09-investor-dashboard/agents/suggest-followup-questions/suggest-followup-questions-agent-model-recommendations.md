# `suggest-followup-questions` — model recommendation

## Recommendation

| | |
|---|---|
| Model | **`gpt-5.6-terra`** |
| Temperature | **omitted entirely** |
| Response format | `json_schema`, strict, object root `{"questions": [...]}` |
| Calls | 1 per `Suggest follow-up questions` click, only when deterministic selection produced ≥1 item |

Same choice, same reasoning, and the same "omit rather than send `temperature: 0`" convention as the
sibling agent `gap-question-phraser` (feature 08) — kept identical on purpose so a future maintainer
copying one node's HTTP config into the other does not reintroduce a parameter that makes `luna`
return HTTP 400.

## Why `terra` and not `luna`

`luna` is this project's extraction/classification/scoring tier — reading evidence and producing a
verdict. This task is the opposite: it receives an already-decided verdict (the gap is real, the
selection already happened in code) and only has to phrase it. The failure mode here is not a wrong
label, it is a sentence that leaks internal vocabulary or reads as an accusation — a register
failure, not a classification failure — and register control is exactly where this project's
workhorse tier earns its keep (see the identical argument in the sibling agent's own doc).

Volume is negligible: at most one call per click, producing ≤6 short question/why pairs.

## Why not `sol`

1. **This call sits behind a user-facing "pending" state, not a background job.** `lovable-brief.md`
   §12.5 requires an explicit, disabled-while-in-flight control with no optimistic UI — the
   investor is watching a spinner. A reasoning-tier model adds latency with no corresponding quality
   need: the hard part (deciding what is worth asking) already happened in code before this call.
2. **The task is short-form rewriting with worked examples for every shape it will see** (both
   `kind`s are covered by desired/undesired examples in the prompt) — not open-ended reasoning.
3. **Shared credit budget** — same constraint as every other agent in this project ($50 of hackathon
   OpenAI credit, shared across pipelines).

## Token estimate

| | Tokens |
|---|---|
| System prompt | ~1.7k (constant — prompt-caching candidate) |
| `company_context` + up to 6 `gap_items` | ~300–700 |
| Output (up to 6 questions × 2 fields) | ~180–350 |
| **Per call** | **~2.0–2.4k in / ~200–350 out** |

One call per click. No voting, no re-ask loop: on a per-item validation failure the backend
substitutes a static fallback (built from the item's own `kind`, see `tbd-items.md` D-4) rather than
re-querying the model — a second sample carries the same forbidden-vocabulary risk as the first and
costs another second of a UI the investor is actively waiting on.

## Determinism note

With `temperature` omitted, wording varies run to run on identical input — acceptable here, same as
the sibling agent: this is call-prep copy, not a score, and nothing downstream keys on the exact
string. Unlike feature 08, this output is **not** persisted into a shared record the founder later
sees echoed back — it lives only in the modal for this one session — so exact-string determinism
matters even less here than in the founder-facing case. For demo/video runs, pin the output via a
recorded fixture if a stable script is needed, same pattern as `03/done.md`.

## Tiers

- **MVP / demo (chosen):** `terra`, one call per click, code-side validation gate with per-`kind`
  static fallback, no retry loop.
- **Production:** unchanged model; add a logged counter of validation-gate rejections by stem, same
  as the sibling agent's production note. A sustained rejection rate on one restriction is the signal
  to move that constraint into constrained decoding rather than to swap models.
- **Premium:** not warranted for this task — there is no reasoning-depth ceiling this call is hitting
  that a larger model would move.
