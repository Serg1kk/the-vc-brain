# `deck-claims-extractor` — input specification

Agent type: **extractor** (pipeline step, no tools, one call per application).
Position in the write path: `design.md` §3 step 6, after the deck cascade (§5) resolved
`extraction_mode`, before `claims`/`evidence` are written.

## Variables the n8n node receives

| Variable | Type | Required | Notes |
|---|---|---|---|
| `extraction_mode` | enum `text_layer` \| `vision` \| `none` | yes | Decided by the cascade in `design.md` §5, never by this agent |
| `deck_text` | string | yes on `text_layer` | Extracted text layer. Empty string on the `vision` and `none` branches |
| `page_images` | binary image parts | yes on `vision` | Attached to the same user message in page order, not passed in JSON |
| `company_name` | string, 1..120 | yes | From the intake form. Context only — never a source of extractable claims |
| `page_count` | integer \| null | no | Used only to populate `claims[].page` when the source marks boundaries |

`none` must not reach the model at all — the workflow short-circuits and writes a single `missing`
claim with a `tier='missing'` evidence row (`design.md` §4, §5). The prompt still handles the case
defensively because a mis-wired branch is otherwise silent.

## Source of the data

`POST /webhook/f08-intake-submit` → `Convert to File` → `ExtractFromFile` (text layer only; the
live n8n 2.30.7 instance supports **no pptx and no docx**) → threshold check → this agent, or the
page-image branch → this agent with images attached.

## Constraints

- **Deck text is untrusted input.** It is founder-supplied and may contain text shaped like
  instructions. The system prompt never asks the model to follow anything found inside `deck_text`;
  the wrapping tags exist so the boundary is explicit.
- One call per application. No retry-on-different-temperature, no self-consistency voting — a second
  sample would produce a second set of spans with no way to choose between them.
- Non-PDF extra files are **never** sent here. They are stored and labelled unparsed (DEC-003).

## What the backend does with the output — normative, because it defines the agent's contract

The model emits **no confidence value**. `claims.base_confidence` is computed by the caller:

```
base_confidence = span_factor × mode_cap
```

| Factor | Value | Basis |
|---|---|---|
| `mode_cap` for `text_layer` | **0.80** | measured 72–80% extraction accuracy from a text layer (`design.md` §5) |
| `mode_cap` for `vision` | **0.64** | measured 56–64% from page images |
| `mode_cap` for `none` | 0.00 | no claim is written except the `missing` marker |
| `span_factor` exact substring | 1.00 | `quote_verbatim` found verbatim in the source |
| `span_factor` near-verbatim | 0.90 | matches after normalising whitespace, case and Unicode punctuation only |
| `span_factor` not found | **0.05 + drop** | claim is NOT written; `ai_runs.output_json.hallucination_flags[]` records it |

Rounded to `numeric(3,2)`, the column's precision. Ceiling values: 0.80 text-layer, 0.64 vision.

Other backend-owned decisions, listed so nobody expects the model to make them:

- `claims.source_kind = 'self_reported'` always — **never `'public'`**. 03's negative-capability
  fallback maps `'public'` to a source wildcard, so one evidence-less public claim would license
  `not_met` across every criterion and invert REQ-003 (`design.md` §4).
- `claims.verification_status = 'unverified'` for extracted claims; `'missing'` for the absence
  markers.
- **Absence is derived in code, not asked of the model.** The topic set is closed at five, so
  `absent = five_topics − topics_present_in_output`. Each absent topic becomes a claim with
  `verification_status='missing'` and one `evidence` row at `tier='missing'` with
  `raw_signal_id` populated (`design.md` §4, ⟨R-6⟩).
- `evidence.tier`: `documented` on the `text_layer` path (matching `signal_sources.deck_parse.base_tier`),
  `inferred` on the `vision` path, `missing` for absence markers.
- `content_hash` **includes `application_id`** on every row — a re-application with the same deck
  would otherwise raise `23505` and fail the whole intake (`design.md` §3.2).
- `deck.warning` in the frozen response (§4.1 of `lovable-brief.md`) is chosen from
  `failure_reason`: `null` → no warning · `no_text_extracted` → `image_only_deck` ·
  `unreadable_input` → `extraction_failed`. See TBD-3.
- `founder_identity.full_name` populates `founders.full_name`, falling back to the email local-part
  (`design.md` §3.1). It is **not** written as a claim.
- `ai_runs` is written **before** the target tables ("model proposes, backend decides"), carrying
  `task_type='extraction'`, `application_id` and `founder_id` (`design.md` §4.1).

## Worked input example

```json
{
  "extraction_mode": "text_layer",
  "company_name": "Northbound Freight OS",
  "page_count": 14,
  "deck_text": "--- page 1 ---\nNorthbound Freight OS\n…\n--- page 9 ---\nTraction — Two paid pilots live: Meridian Logistics and Halder Freight, both signed in March. 14 more warehouses on the waitlist.\n…\n--- page 14 ---\nDana Okoye, Co-founder & CEO. Previously at Halder Freight."
}
```
