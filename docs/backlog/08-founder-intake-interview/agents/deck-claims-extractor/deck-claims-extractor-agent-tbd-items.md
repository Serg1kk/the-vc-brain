# `deck-claims-extractor` — decisions & open items

Built 2026-07-19 by the feature-08 agent-spec terminal. The operator was not available for the
usual per-question gate, so the decisions below were taken under delegated authority against
`design.md`, `lovable-brief.md` §4 (frozen) and `03/done.md`. Each records what was rejected and why,
so the operator can overturn any of them cheaply.

## Decisions taken

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D-1 | **The model emits no confidence field at all.** The schema has no place to put one. | Model self-reports confidence, backend clamps it. | LLM self-reported confidence is uncalibrated — models assign 0.9+ to fabricated fields (`design.md` §5). A field that exists gets read by somebody eventually. Removing it is stronger than clamping it. |
| D-2 | Confidence formula fixed at `span_factor × mode_cap`, caps **0.80 / 0.64 / 0.00**. | Leave the numbers to build time. | `design.md` §5 gives the accuracy bands (72–80%, 56–64%) but no cap values, and "cap it somehow" would have been decided ad hoc in an n8n node at 3am. Taking the top of each measured band is the defensible reading. |
| D-3 | **Absence is derived in code**, not requested from the model. | Ask the model for an `absent_topics[]` array. | The topic set is closed at five, so absence is a set subtraction — deterministic, free, and immune to a model that forgets one. The `missing` markers this produces are load-bearing for gap-question selection (`design.md` §6, ⟨R-7⟩); they must not depend on model recall. |
| D-4 | Topic vocabulary closed to **five leaves**, one per criterion (X1, X2, X5, L2, L3). | Free-form leaves under the two permitted prefixes. | 03's vocabulary is prefix-based and free-form after the prefix, so free-form leaves would validate — but gap-question coverage checking joins claims to criteria, and a fuzzy join there silently suppresses questions. A closed enum makes the join exact. |
| D-5 | **X6 is deliberately not extracted**, though a deck can speak to it. | Add a sixth topic for X6 ("substantial work nobody asked for, before funding"). | `design.md` §4 enumerates 08's territory as X1, X2, X5, L2, L3. X6's `neg_src` is `github_api` + `tavily_extract` — public sources reach it, and feature 02 already scores it. Adding it here is scope drift with a duplicate-writer smell. |
| D-6 | Max **3 claims per topic**, 15 overall. | Uncapped. | `topic_routing.prefix_map` sends every `founder.leadership.*` claim into one sub-scorer capped at `max_claims_per_agent: 40`. A chatty deck could otherwise crowd out public-source claims in 03's context pack — dilution, not enrichment (`design.md` §4 ⟨R-9⟩). |
| D-7 | `stated_metrics[].value_verbatim` typed as **string, not number**. | Numeric type. | "Two", "£4,000", "~14" are all real deck renderings. Coercing to a number is the first step of the extract-then-compute failure the agent exists to avoid, and it destroys the verbatim property. |
| D-8 | `failure_reason` enum added to the output so the backend can choose between `image_only_deck` and `extraction_failed`. | Single warning value. | The frozen contract (§4.1) has both codes; `design.md` §5 names only `image_only_deck`. See TBD-3 — this is a gap in the design, not a contradiction, and the enum closes it without touching the frozen shape. |
| D-9 | One call, no self-consistency voting. | Sample 3× and reconcile. | Two samples produce two different span sets with no principled reconciliation rule. The span check already removes the class of error voting would buy down, at 1/3 the cost. |
| D-10 | Deck text wrapped in explicit tags and never treated as instructions. | Plain concatenation. | Deck text is founder-supplied and reaches a model. This is the cheapest available boundary; it is not a guarantee, which is why the backend verifies output shape independently. |

## Open questions

| # | Question | Status | Who resolves |
|---|---|---|---|
| TBD-1 | **Does `gpt-5.6-luna` accept image input?** If yes, the vision branch collapses onto one model and one set of quirks. | Open — needs one live call against `/v1/chat/completions` with an image part. | Build agent, before wiring the vision branch |
| TBD-2 | **The text-layer → vision threshold** (chars below which the cascade falls through). | Open by design — `design.md` §12 parks it explicitly for empirical setting against the demo decks. | Build agent |
| TBD-3 | **When is `extraction_failed` emitted rather than `image_only_deck`?** `design.md` §5 defines only the latter; the frozen contract has both. Proposed mapping in `input-spec.md`: cascade completed but yielded nothing → `image_only_deck`; the pipeline threw (corrupt PDF, `ExtractFromFile` error) → `extraction_failed`. | Proposed, needs operator or QA sign-off. | Operator / QA gate |
| TBD-4 | **Near-verbatim matching rule.** `span_factor = 0.90` is specified for "whitespace, case and Unicode punctuation" normalisation only. Whether ligature and hyphenation artefacts from PDF text layers should also normalise is untested. | Open. If it is not resolved, PDF extraction artefacts will silently drop otherwise-good claims to `span_factor` zero. | Build agent, against the demo decks |
| TBD-5 | **Non-English decks.** The agent is told to transcribe what it reads and never translate, but this is untested, and `claims.search_tsv` is generated with the `'english'` text-search configuration. | Open — same untested-multilingual gap 03 recorded. | Deferred; disclose in `done.md` rather than overclaim |
| TBD-6 | **No validation against hand-labelled decks.** No measurement of this agent's own precision/recall exists — the 72–80% and 56–64% figures are from the literature, not from this prompt. | Open, and it should stay stated: the tech video must not claim measured accuracy for this component. | Operator |
