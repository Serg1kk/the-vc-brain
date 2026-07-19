# `thesis-attribute-extractor` — Input Specification

> Agent: `thesis-attribute-extractor` · Model: `gpt-5.6-luna` · Type: extractor
> Pipeline position: `f07-thesis-gate`, the single LLM node — after the preflight
> (`ai_runs` open, card resolved) and **before** the thesis is loaded (design.md §6.1).
> Spec of record: `../../design.md` D-02, §1.1, §4, §5.4, §6.1.

## Position in the workflow

```
webhook({application_id, text, mode, structured_hints?})
  → mode='keyword' ──────────────────────────────────────► this agent is SKIPPED entirely
  → mode='full':
      preflight: open ai_run, resolve card (§5.4)
      → LLM thesis-attribute-extractor        [luna]     ◀── THIS AGENT
      → deterministic validator (Code node)              ◀── consumes this agent
      → raw_signals → claims → evidence       (§5.4)
      → load default thesis, compile mandate → rules     ◀── FIRST TOUCH OF THE THESIS
      → three-valued evaluation → fit/coverage → verdict
```

**The thesis is loaded strictly after this agent has returned.** This is D-02 and it is
the entire architectural point of the feature, not an implementation convenience: an
extractor that knows the fund's criteria is «highly likely to hallucinate alignment even
if the evidence is weak» (NotebookLM Q12). The node ordering above is what makes the
property structurally true rather than a promise — there is no thesis in the workflow's
memory at the moment this node executes.

**Corollary for the builder:** the `ai_runs.prompt` payload written by the preflight must
contain no thesis field. §8.3 test 13 asserts exactly this against the persisted payload.

## Input variables

Two variables, injected into the USER MESSAGE as n8n expressions.

| Variable | Type | Required | Source | Notes |
|---|---|---|---|---|
| `{{ $json.gate_text }}` | string | **yes** | the workflow's `text` parameter | Deck-extracted text, HN post text, or page text — or any concatenation the caller assembled. Also the value of `_text` in §1.1, which is what makes the quote-substring check well-defined (below). |
| `{{ $json.structured_hints }}` | object | no (may be `{}`) | the workflow's `structured_hints` parameter | Flat JSON, string values only. Caller supplies whatever it already holds. |

**`application_id` is deliberately NOT passed to the model.** It carries no extractable
signal, and an opaque identifier in the prompt is one more thing a model can try to
pattern-match on. It stays in the n8n item and is used by the write path only.

### `gate_text`

There is **no deck parser in feature 07** (§6.1: `deck_parse` exists as a `signal_sources`
slug with no owning feature). The gate takes text; producing that text is the caller's job.
Expect all three shapes:

| Caller | Typical content | Typical size |
|---|---|---|
| 08 intake (`mode='full'`) | text extracted from an uploaded deck — broken line breaks, bullet fragments, page numbers, OCR noise | 500–8,000 tokens |
| 02 radar Tier 2 (`mode='full'`, post-enrichment) | HN post body + GitHub README + personal-site page text | 200–3,000 tokens |
| 02 radar Tier 1 | — | **agent not called** (`mode='keyword'`) |

The prompt tells the agent that messy slide text is normal input, not a defect. Do not
pre-clean it beyond whatever the extraction tool produced: cleaning risks destroying the
verbatim spans that `claims.text_verbatim` needs.

**Truncation.** Cap `gate_text` at ~24,000 characters in the upstream node, keeping the
head. Decks longer than that are appendices — team bios, financial projections, logo
walls — and none of the five attributes lives there. If truncation fires, record it on the
`ai_runs` row; do not tell the model, which would only invite speculation about the
missing part.

### `structured_hints`

A flat object of string values. Every key is optional and `{}` is the common case.

```jsonc
{
  "company_name": "Terrafix",
  "company_domain": "terrafix.io",
  "geography_country": "DE",      // e.g. 02's normalized GitHub location (02/design.md:113)
  "one_liner": "Soil health for arable farms"
}
```

Rules the prompt enforces (Instruction 5):

- A hint is a **lead, not a fact**. When the text supports the same value, the quote comes
  from the text.
- A hint may be the sole source of a field, in which case its **literal value string** is
  the quote. This is why the quote-substring check (below) runs against the text *and* the
  rendered hint values, not the text alone.
- A hint that **irreconcilably conflicts** with the text resolves to `null` +
  `missing_fields`, never to either side. Design §6.1 treats a contradicted claim as
  `unknown` for exactly this reason: «a contradicted attribute is precisely *we do not
  reliably know this*».

**Never put thesis-derived material in `structured_hints`.** Not `theses.config.geos`, not
the mandate sectors, not a fit hint, not a prior verdict — no matter how convenient a
narrowing hint looks. Passing the mandate through this channel would reintroduce D-02's
sycophancy trap through the back door while leaving the prompt technically thesis-free.
This is the one input-side rule a reviewer should check first.

## Output contract in one line

Five attributes + `reasoning` + `quotes` + `missing_fields`, flat, `reasoning` first. Full
schema: `thesis-attribute-extractor-agent-json-schema.json`.

## The deterministic validator (consumer node — required, not optional)

OpenAI strict structured outputs cannot express a conditional (`quotes.X` required *iff*
`X` is non-null): `if`/`then`/`allOf` are unsupported in strict mode. The schema therefore
enforces presence, types and enums; the **pairing and grounding invariants are enforced by
a Code node** immediately downstream. Four checks, all cheap:

| # | Check | On failure |
|---|---|---|
| 1 | For each of the five fields: `value === null` ⇔ `quotes[field] === null` ⇔ `field ∈ missing_fields` | Drop that field to `null`, add to `missing_fields`, drop the quote |
| 2 | Every non-null quote is a **contiguous substring** of `gate_text` **or** of some `structured_hints` value | Same as #1 — the value is ungrounded and cannot become a `claims` row |
| 3 | `missing_fields` contains only the five legal keys, no duplicates | Filter |
| 4 | No emitted key outside the schema (`geography_region`, `stage`, any confidence) | Strip |

Check 2 is the one that matters: it is the mechanical defence against a fabricated span,
which is the most damaging failure mode here because `claims.text_verbatim` is NOT NULL and
a fabricated span would be persisted as sourced evidence. Recommend a whitespace-normalised
comparison (collapse runs of whitespace on both sides before `indexOf`) so that a quote
spanning a slide line-break is not rejected for a cosmetic reason.

**The validator never repairs upward.** It can only demote a value to `null`; it may never
supply a value or synthesise a quote.

**Retry policy** (mirrors 04's error branch): non-conforming JSON → one re-ask with the
schema restated → then treat the run as an all-null record. An all-null record is a legal
outcome that flows through the gate correctly — coverage → 0 → `insufficient_evidence`
(D-07) — so there is no need for an error status code in the schema.

## Degenerate inputs the agent must survive

| Input condition | Expected behaviour |
|---|---|
| `gate_text` empty, `structured_hints` `{}` | All five attributes `null`, all five quotes `null`, all five in `missing_fields`, `reasoning` states there was no extractable content. **Correct, not an error.** Coverage → 0 → `insufficient_evidence`. |
| Four-line Show HN post | 2–4 attributes filled, the rest `null`. Sparse is the normal case at this stage. |
| Tagline only («the operating system for logistics») | Near-all-null. Undesired Example 2 in the prompt is this exact case. |
| Deck self-labels one sector, describes another | Record what is described; state the override in `reasoning` (Instruction 5). |
| Hint `geography_country: "US"` vs text «team relocated to Germany» | `null` + `missing_fields` + explanation. Never pick a side. |
| Company in a sector outside the vocabulary (agriculture, logistics, defence) | `sector: "other"` with a quote. `other` is a determination, not a gap — it does **not** go in `missing_fields`. |
| Non-English deck | Extract normally. Vocabulary values and `what_is_built` in English; **quotes stay in the source language, verbatim** — a translated quote is not a verbatim span and would fail validator check 2. |
| Text mentions a funding round but no product state | `stage_evidence: null`. A round name is not a company state (§1.1: OpenVC company-state, not round names). |
| Text supports `scaling` | Emit `scaling`. It maps to no `stage` value and yields `unknown` on stage rules (§1.1) — that is the evaluator's business, not the extractor's, and the extractor must not down-grade to fit. |

## Contract with the claims write path (§5.4)

Each non-null attribute becomes one `claims` row under the `company.*` prefix that 07 owns
(§5.4.1):

| Attribute | `claims.topic` | `text_verbatim` | `value` |
|---|---|---|---|
| `sector` | `company.sector` | `quotes.sector` | normalized label |
| `business_model` | `company.business_model` | `quotes.business_model` | normalized label |
| `geography_country` | `company.geography_country` | `quotes.geography_country` | ISO alpha-2 |
| `stage_evidence` | `company.stage_evidence` | `quotes.stage_evidence` | normalized label |
| `what_is_built` | `company.what_is_built` | `quotes.what_is_built` | the summary text |

Each field in `missing_fields` becomes a `company.<field>.gap` row with
`verification_status = 'missing'` (§5.4.1 convention).

`source_kind = 'self_reported'` for all of them — the agent reads what the company says
about itself, and feature 05 is what later verifies any of it.

**This table is why `quotes` is structurally mandatory.** `claims.text_verbatim` is NOT
NULL, and a normalized label (`b2b-software`) is not a verbatim span. Without a quote there
is no legal row to write, which is precisely why the prompt routes an unquotable field to
`missing_fields` rather than letting it through as a bare value.

## What this agent does not produce

`geography_region` and `stage` are **derived**, not extracted — `region_of(country)` and
the `stage_evidence → stage` map, both in `lib/f07/vocabulary.js` (§1.1, plan task B1). The
prompt forbids emitting them. Two sources of truth for a derived field is how a German B2B
company came to soft-fail a geography rule in rev.2.

`_text` is synthetic — the concatenated gate input, assembled by the workflow. The agent
never emits it.
