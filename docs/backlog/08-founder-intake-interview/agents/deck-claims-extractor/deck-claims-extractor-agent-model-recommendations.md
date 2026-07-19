# `deck-claims-extractor` — model recommendation

## Recommendation

| Branch | Model | Temperature | Response format |
|---|---|---|---|
| `text_layer` | **`gpt-5.6-luna`** | **omitted entirely** | JSON object |
| `vision` | **`gpt-5.6-terra`** (multimodal) | **omitted entirely** | JSON object |
| `none` | no model call | — | — |

⚠️ **`gpt-5.6-luna` rejects `temperature: 0` with HTTP 400** ("Unsupported value: 'temperature' does
not support 0 with this model"), verified live 2026-07-19 during feature 03. Send **no
`temperature` key at all** — not `0`, not `1`. This is recorded as cross-feature rule 7 in
`docs/backlog/TRACKER.md` and in `03/done.md`. Omit it on the `terra` branch too, so the two
branches are configured identically and nobody re-introduces it by copying one node.

## Why `luna` on the text-layer branch

- CLAUDE.md designates `gpt-5.6-luna` as the extraction / classification / scoring / batch model.
  This task is pure extraction against a closed five-topic vocabulary with a verification pass — the
  regime where mid-tier models are reliable, not open reasoning.
- **Every output string is verified against the source before it is written.** The backend's span
  check (`input-spec.md`) means a frontier model buys less here than it usually would: its advantage
  is judgement, and this agent is forbidden from exercising judgement. Errors that a bigger model
  would avoid are exactly the errors the span check catches for free.
- Feature 03 already runs four `luna` calls per founder on the same corpus of claims, so the intake
  path stays on one model family and one set of known quirks.
- Cost: the hackathon's $50 of OpenAI credit is shared with the operator's other pipelines. Intake
  is the highest-volume model call in the product (one per application, plus the phraser).

## Why `terra` on the vision branch

`luna`'s multimodal support is **not verified** (TBD-1). `gpt-5.6-terra` is the designated
general-purpose workhorse and the safer assumption for page-image input. The branch is also the
rarer path — it only fires on image-only decks — so its cost weight is small.

The vision branch is additionally capped at `mode_cap = 0.64` regardless of model, matching the
measured 56–64% accuracy of image-only extraction. **A better model does not raise that cap**: the
cap describes the channel, not the reader. If the model tier changes, the cap does not move without
a fresh measurement.

## Token estimate

| Deck | Input tokens | Output tokens |
|---|---|---|
| 10-page text-layer deck, ~6k chars | ~1.5k prompt + ~1.6k deck ≈ **3.1k** | ~400–900 |
| 20-page dense deck, ~14k chars | ~1.5k prompt + ~3.6k deck ≈ **5.1k** | ~600–1.2k |
| 14-page image deck (vision) | ~1.5k prompt + 14 images | ~400–900 |

System prompt is ~1.5k tokens and identical on every call — a **prompt-caching candidate** if the
provider supports it on this model, since only the deck text varies.

One call per application. No self-consistency voting: a second sample produces a second set of spans
with no principled way to choose between them, and the span check already removes the failure mode
voting would be buying down.

## Tiers

- **MVP / demo (chosen):** `luna` + `terra` as above, one call, span-verified, recorded fixtures for
  offline replay so demo runs cost nothing (the pattern `03/done.md` established with
  `db/fixtures/recorded/`).
- **Production:** unchanged models; add prompt caching and a per-topic extraction-rate metric so
  drops in yield are visible rather than silently reducing coverage.
- **Premium:** `gpt-5.6-sol` on decks where the text layer is present but the first pass returns zero
  claims across all five topics — a plausible symptom of an unusual layout rather than a quiet deck.
  Deliberately **not** in MVP: it doubles the cost of exactly the decks that most often genuinely
  say nothing, and the honest empty result is a feature.
