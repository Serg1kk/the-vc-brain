# `gap-question-phraser` — decisions & open items

Built 2026-07-19 by the feature-08 agent-spec terminal, under delegated authority (the operator was
not available for the usual per-question gate). Sources: `design.md` §6/§7/§10,
`lovable-brief.md` §4.1/§4.4/§7 (frozen), `03/done.md`, the live `score_formulas` seed row.

## Decisions taken

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D-1 | **Exactly one question per supplied criterion**, always, same order. | Let the model decide how many questions the context deserves (0–3). | The frozen contract says 0–3, and that range is produced by the *selection* step, which is deterministic code. Giving the model the count too would make the ask non-explainable and let eloquence decide what gets asked — the property `design.md` §6 was built to remove. |
| D-2 | **`deck_readable` is a required input** and gates the `why` line. | Let the model infer readability from an empty context. | On the `extraction_mode='none'` branch every topic is "missing", so a naive `why` reads "your deck doesn't mention a first customer" — false, and instantly catchable by a founder who knows what is in their deck. One boolean removes an entire class of credibility damage. |
| D-3 | **Forbidden vocabulary enforced twice**: in the prompt and again as a code-side stem scan. | Prompt only. | The output reaches a founder's screen with no human in between (`input-spec.md`), and this is the one constraint in feature 08 with a measured cost attached to violating it (>50% drop in continuation, worst among the strongest applicants and among women). A prompt is a strong prior, not a guarantee. Stems, not whole words — inflections are the leak. |
| D-4 | **Static per-criterion fallback questions** ship alongside the agent, used whenever the validation gate drops an item. | Ship nothing when validation fails. | A dropped question silently forfeits up to 0.15 of reachable founder-score weight, and coverage is the number the demo turns on (`design.md` §6). A slightly less personal question beats a missing one. Proposed text below. |
| D-5 | **`why` names what we already looked at** ("We found your GitHub and your site, but neither shows who is using it") rather than stating a generic reason. | Generic explanatory line. | The `why` is the entire personalisation budget of this screen. A generic line makes the question look like a form field and forfeits the one thing that makes answering feel worthwhile. |
| D-6 | Length caps **140 / 120 / 120**. | No caps. | `question` renders as a card title at 16px and `placeholder` inside a 3-row textarea (`lovable-brief.md` §7.2). Uncapped strings break the layout that has already been built, and long questions read as work. |
| D-7 | Same agent serves the intake set and the manager follow-up. | A second agent for follow-ups. | `lovable-brief.md` §4.4 `questions[]` is field-for-field identical to §4.1 `gap_questions[]`. Two agents on one shape is two places for the register to drift. |
| D-8 | `temperature` omitted (not 0), on both feature-08 nodes. | `temperature: 0` for reproducibility. | `luna` returns HTTP 400 on `temperature: 0` (rule 7). Configuring both nodes identically means the extractor node cannot be copied into the phraser node with a poisoned parameter. Reproducibility for demos comes from recorded fixtures instead. |
| D-9 | The model never sees the selection rule, the weights' meaning, or the coverage arithmetic. | Give it the full scoring context "for better questions". | It would invite the model to prioritise, i.e. to re-litigate a decision code already made, and every extra scoring detail in a founder-facing generator is one more thing that can leak into founder-facing copy. |

### D-4 fallback text (reviewed, static, no model call)

| Criterion | question | why | placeholder |
|---|---|---|---|
| L2 | Who is using it today, and how did the first one find you? | Nothing we found publicly shows who is using it yet. | A name, a date, and how the conversation started is enough. |
| L3 | Who was the last person who really wanted this, and what were they using before? | We couldn't tell from public sources who actually signs. | Their job title, their company size, and what they did instead is plenty. |
| X5 | When someone chose a different tool over yours, what did they pick and what did it do better? | We can find who your competitors are; we can't find where you actually lose. | One specific instance is more useful than a full comparison. |

These are deliberately close to the worked examples in the prompt: the fallback should be
indistinguishable in register, only less specific to the company.

## Open questions

| # | Question | Status | Who resolves |
|---|---|---|---|
| TBD-1 | **Is the frontend's grammar rule satisfiable?** `lovable-brief.md` §7 titles the screen "Three things your deck didn't cover", varying by count — but on the `deck_readable: false` branch nothing was read, so the title is false for every count. The `why` lines adapt (D-2); the **screen title does not**. | **Open, and it touches built frontend copy.** Not a contract disagreement — a copy gap the design did not anticipate. Suggested fix: a `deck_readable` flag in the submit response and a second title string. | Operator, before QA |
| TBD-2 | **Should `known_claims` include 07's `company.*` claims?** Including them makes the model better at not re-asking; it also puts another feature's output inside a founder-facing generator. Currently: yes for `what_is_built`/`sector`/`geography_country` as flat fields, no for raw claim rows. | Decided provisionally as above; revisit if questions come back generic. | Build agent |
| TBD-3 | **No measurement of continuation rate.** The >50% deterrence figure that shapes this entire agent is from the literature; we will not measure our own version during a hackathon. | Open, and it should stay stated — the videos must not claim a measured improvement. | Operator |
| TBD-4 | **Criteria-transparency tension**, recorded in `design.md` §10 and inherited here verbatim: a gap question reveals what is scored, and disclosed criteria measurably increase deceptive impression management. Accepted, with defences living in feature 05's evidence verification, not in phrasing. | Accepted, not resolved. | — |
| TBD-5 | **Non-English founders.** The prompt writes English questions regardless of the deck's language. For a product whose thesis is global cold-start sourcing, this is a real limit — and it interacts with guardrail 9 (no AI-text detectors, precisely because errors land on non-native speakers). | Open; disclose in `done.md`. | Operator |
