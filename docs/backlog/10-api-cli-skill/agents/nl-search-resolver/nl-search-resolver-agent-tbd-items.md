# NL-Search Resolver — Decisions & Open Questions

## Decisions made

| # | Date | Decision | Rationale |
|---|---|---|---|
| D-01 | 2026-07-19 | **The resolver emits no `weight`.** Weights live in a fixed `WEIGHTS` table in `lib/f10/`, keyed by attribute `kind`. | `gpt-5.6-luna` cannot take `temperature: 0` (HTTP 400), so a model-assigned weight makes `rank_score` vary between identical runs. A judge running the demo query twice would see two different rankings and discount the whole Trust axis. Spec review B4. |
| D-02 | 2026-07-19 | **The live corpus catalogue is passed on every call**, not baked into the prompt. | The corpus changes as 02 and 08 ingest. A hard-coded topic list emits targets that no longer exist, and the failure is silent — an attribute matching nothing looks identical to one that legitimately found nothing. |
| D-03 | 2026-07-19 | **A negative attribute whose subject matter the corpus never records is `unresolvable`, not a satisfied `NOT EXISTS`.** | No funding topic exists in this corpus, so "no prior VC backing" would be trivially true for all 122 founders and award every one a fabricated match. This is the one-sided-label-noise trap: at pre-seed, absence of a record is not evidence of a negative fact. Enforced twice — in the prompt (restriction 2) and independently in the executor (design §5.4 rule 3). |
| D-04 | 2026-07-19 | **`unresolvable[]` is a first-class output with a machine-readable `reason`.** | Silently dropping a fragment makes the system answer a different question than the one asked, with no signal to the caller. |
| D-05 | 2026-07-19 | **Model: `gpt-5.6-luna`, `reasoning_effort: low`, `temperature` omitted.** | Closed-catalogue classification is the documented Luna use case; omitting `temperature` is forced by the HTTP 400. |
| D-06 | 2026-07-19 | **Protected and personal characteristics resolve to `out_of_scope`.** | Data-minimisation policy: the system collects only signals about professional capability to build a product. This is both compliance and bias defence, and it is cheaper to enforce at the resolver than to filter downstream. |
| D-07 | 2026-07-19 | **Executor re-validates every target against the same catalogue.** | The resolver is trusted to be helpful, never to be correct. An invalid target yields `invalid_target` rather than a query that quietly matches nothing. |

## Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| Let the LLM emit SQL directly | No Postgres driver in the repo (no `package.json`), n8n Code nodes cannot `require()` from the repo, and an LLM writing SQL against a database with no RLS and a full-write token is an injection surface. Spec review B2. |
| Vector search / embeddings for the query | Operator ruling: no vector database in the MVP. Also unnecessary — the discriminating signal is a closed set of ~40 claim topics, not open semantic similarity. |
| Two-pass resolver (decompose, then a second call to map targets) | Doubles latency inside a synchronous webhook for a task one call handles. Revisit only if QA shows systematic mis-targeting. |
| Have the resolver score or rank candidates | It has never seen a founder. Ranking belongs to the deterministic executor, where it is reproducible and auditable. |
| Bake the topic catalogue into the system prompt for cache efficiency | Saves ~900 tokens (~$0.001/call) and breaks D-02. Not a trade worth making. |

## Open questions

| # | Question | Status |
|---|---|---|
| Q-01 | Should `unresolvable` fragments with `reason: "no_data_source"` be surfaced to the investor as a **sourcing gap** — i.e. "you asked about funding history and we have no channel that collects it; here is what it would take"? It converts a limitation into a roadmap statement. | **Open — parked.** Cheap to add later (the reason code already carries the information); out of scope for the T-6h build. |
| Q-02 | Weight values in the `WEIGHTS` table (provenance 25, structural 20, velocity 20, negative 15, text 10) are a first guess, not calibrated. | **Open — accepted as-is for MVP.** Any calibration needs labelled relevance data we do not have. Documented in the skill so the numbers are inspectable rather than implied to be principled. |
| Q-03 | Multilingual queries — the prompt says "any language" for `query` but every few-shot example is English, and the closed vocabularies are English slugs. | **Open — low risk.** The demo is English. If a Russian query appears, mapping onto English slugs is exactly the kind of normalisation the model does well; untested. |
| Q-04 | Should the resolver see *which* founders exist (names) to disambiguate a query naming a person? | **Rejected for now**, folded here for the record: it would put PII in the prompt for a case the demo does not need, and `founder <id>` already covers "I know who I want". |
