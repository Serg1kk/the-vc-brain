# `gap-question-phraser` — model recommendation

## Recommendation

| | |
|---|---|
| Model | **`gpt-5.6-terra`** |
| Temperature | **omitted entirely** |
| Response format | JSON (array) |
| Calls | 1 per application, plus 1 per manager-initiated follow-up |

⚠️ Omit `temperature` rather than sending `0`. `gpt-5.6-luna` returns HTTP 400 on `temperature: 0`
(cross-feature rule 7, `03/done.md`); the parameter is omitted here as well so the two feature-08
nodes are configured identically and nobody re-introduces it by copying one node into the other.

## Why `terra` and not `luna`

`luna` is this project's extraction/classification/scoring model, and this task is neither. It is
**short-form generation of founder-facing copy with a hard register constraint** — the output goes
to a real person's screen with no human review step in between (`input-spec.md`). The failure mode
is not a wrong label, it is a sentence that sounds like a form, an evaluation, or a demand — and
that failure is invisible to a schema validator. Register control is where the workhorse tier earns
its cost.

The volume is also negligible: at most one call per application producing ~150 output tokens. There
is no batch-economics argument for dropping a tier here, which is the argument that puts feature 03
on `luna`.

## Why not `sol`

Three reasons, in order of weight:

1. **Latency inside a frozen budget.** This call sits inside `POST /webhook/f08-intake-submit`,
   whose contract allows **90 s total** (`lovable-brief.md` §4.1) — already shared with a PDF parse,
   the deck extraction call and feature 07's full thesis gate. A reasoning-tier model on the tail of
   that chain is the most likely single cause of a contract timeout.
2. **The hard part is not reasoning.** Selection — the genuinely analytical step — is deterministic
   code (`design.md` §6). What remains is rewriting three known anchors into three short questions
   in a specified register, with worked examples for every one of them in the prompt.
3. **Shared credit budget.** The $50 of hackathon OpenAI credit is shared with the operator's other
   pipelines.

`sol` stays on the table for one thing only: **offline re-drafting of the static fallback questions**
(`tbd-items.md` D-4), which are written once, reviewed by a human, and then cost nothing at runtime.

## Token estimate

| | Tokens |
|---|---|
| System prompt | ~1.9k (constant — prompt-caching candidate) |
| `card_context` + 3 criteria | ~250–500 |
| Output (3 questions × 3 fields) | ~150–220 |
| **Per application** | **~2.3–2.6k in / ~200 out** |

One call per application. No voting, no re-ask loop: on a validation failure the backend substitutes
the static fallback question rather than paying for a second sample, because a second sample has the
same forbidden-vocabulary risk as the first and costs another second of the 90 s budget.

## Determinism note

With `temperature` omitted the wording will vary between runs on the same input. That is acceptable
and slightly desirable — it is copy, not a score, and nothing downstream keys on the exact string.
The question text that was actually shown is persisted to `interviews.transcript` (`design.md` §8)
and echoed back in `POST /webhook/f08-gap-answers`, so the record is exact even though the generator
is not. **For demo and video runs, pin the output** via a recorded fixture, the pattern
`03/done.md` established with `db/fixtures/recorded/`.

## Tiers

- **MVP / demo (chosen):** `terra`, one call, code-side validation gate, static per-criterion
  fallback, recorded fixture for the demo path.
- **Production:** unchanged model; add a logged counter of validation-gate rejections per stem. If
  the forbidden vocabulary ever fires in production, that is the signal to move the constraint from
  the prompt into a constrained-decoding setup rather than to swap models.
- **Premium:** `sol` for the follow-up path only, where a manager's free-text note has to be turned
  into questions and latency is not on a 90 s budget. Not in MVP.
