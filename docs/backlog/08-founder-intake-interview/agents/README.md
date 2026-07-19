# Feature 08 — AI agent specifications

Built via the `ai-agent-builder` skill (mandatory per CLAUDE.md: product AI logic is an artifact,
never improvised). Normative sources: [`../design.md`](../design.md) §4, §5, §6, §7, §10 ·
[`../lovable-brief.md`](../lovable-brief.md) §4 (**frozen** API contracts) ·
[`../../03-founder-score/done.md`](../../03-founder-score/done.md) · the live `score_formulas` row
in `db/seed.sql`.

| Agent | Folder | Type | Model | Calls |
|---|---|---|---|---|
| `deck-claims-extractor` | [deck-claims-extractor/](deck-claims-extractor/) | extractor | `gpt-5.6-luna` (text) / `gpt-5.6-terra` (vision) | 1 per application |
| `gap-question-phraser` | [gap-question-phraser/](gap-question-phraser/) | generation, pipeline step | `gpt-5.6-terra` | 1 per application + 1 per follow-up |

Each folder holds the five `ai-agent-builder` artefacts: `-prompts.txt`, `-input-spec.md`,
`-json-schema.json`, `-model-recommendations.md`, `-tbd-items.md`.

Also in this folder: [`spec-review-rev1.md`](spec-review-rev1.md) — the adversarial review of
`design.md` rev.1 whose 19 findings are folded into rev.2 as ⟨R-n⟩ marks.

## The property both agents share

**Neither model is trusted with a number that reaches a score, and neither is trusted with a
decision code already makes.**

- The extractor emits **no confidence field at all**. `base_confidence` is computed by the backend
  as `span_factor × mode_cap` — does the string actually appear in the deck, times a cap set by how
  the deck was read (0.80 text layer, 0.64 vision). LLM self-reported confidence is uncalibrated;
  models assign 0.9+ to fabricated fields.
- The phraser emits **no count and no priority**. Selection is deterministic code reading
  `score_formulas.config.criteria`; the model receives an already-chosen 1–3 and writes one question
  each.

This is the same "model proposes, backend decides" stance feature 03 established, and it is what
lets the system claim its outputs are traceable rather than merely plausible.

## Ownership boundaries these prompts enforce

| Boundary | Enforced where |
|---|---|
| 08 **never** writes `company.*` claims — 07 writes them from the same deck text on every `mode:'full'` gate call | extractor `<restrictions>`, plus a closed five-value `topic` enum in its schema |
| 08 writes only `founder.expertise.*` and `founder.leadership.*`, criteria X1, X2, X5, L2, L3 | same closed enum; X6 deliberately excluded (extractor TBD D-5) |
| Deck claims are `source_kind='self_reported'`, **never `'public'`** | extractor input-spec; a `'public'` claim without evidence licenses `not_met` across every criterion in 03 and inverts REQ-003 |
| Every claim gets an `evidence` row with `raw_signal_id` populated, including `missing` markers | extractor input-spec (backend obligations) |
| The words *interview, assessment, evaluation, test, screening* never reach a founder | phraser `<restrictions>` **and** a code-side stem scan (phraser TBD D-3) |
| Nothing forward-looking is ever asked — no TAM, no projections, no competitor lists | phraser `<restrictions>` and criteria playbook |

## Live-config facts these specs are built against

Three criteria — and only three — have `neg_src` reachable by **no** public source, so only these
are ever asked:

| Criterion | Weight | Anchor (verbatim from `score_formulas`) |
|---|---|---|
| L2 | 0.15000 | First customers / LOI / pilot evidence |
| L3 | 0.09000 | ICP specificity: vertical + size + buyer role + trigger + current alternative |
| X5 | 0.05625 | Describes competitors at insider granularity (where deals are lost, what breaks in production) rather than pricing-page level |

0.296 of the founder-score weight is unreachable by any public source. Three questions are the
mechanism that lifts coverage measurably on screen — not decoration.

## Shared operational quirks

1. **`gpt-5.6-luna` rejects `temperature: 0` (HTTP 400).** Omit the parameter entirely on both
   nodes — not `0`, not `1` — so one node cannot be copied into the other with a poisoned parameter.
2. **n8n Code nodes cannot `require()` from this repo** (no bind-mount). Any validation logic must be
   self-contained CommonJS pasted verbatim.
3. **Wire parallel branches through an explicit `Merge` node.** Four parallel nodes feeding one
   downstream node silently executed only 1–2 of them and still returned HTTP 200 (03 rule 6).
4. Both agents write `ai_runs` **before** their target tables, carrying `application_id` **and**
   `founder_id` — `purge_founder()` sweeps by those FKs and the tables are append-only, so a NULL FK
   survives an erasure request permanently (`design.md` §4.1).

## Design ⇄ frozen-contract check

The frozen shapes in `lovable-brief.md` §4 were checked field-for-field against `design.md` §7.
**No disagreement found.** `{criterion_id, question, why, placeholder}` matches exactly, 0–3 matches
exactly, and §4.4's follow-up `questions[]` is identical to §4.1's `gap_questions[]`, which is why
one agent serves both.

Two gaps in the design were found — neither is a contradiction with the frozen contract, and both
are recorded as open items rather than decided silently:

- **`deck.warning: "extraction_failed"`** exists in the frozen contract; `design.md` §5 defines only
  `image_only_deck`. A `failure_reason` enum on the extractor closes it (extractor TBD-3).
- **The `/apply/questions` screen title** ("Three things your deck didn't cover") is false on the
  `extraction_mode='none'` branch, where the deck was never read. The `why` lines adapt; the title
  cannot (phraser TBD-1). This touches already-built frontend copy and needs the operator.
