# `market-categorizer` — Input Specification

> Agent: `market-categorizer` · Model: `gpt-5.6-luna` · Type: classifier / extractor
> Pipeline position: `f04-market-intel`, node 4 — immediately after
> «fetch company + deck claims», immediately before the deterministic query builder
> (design.md §4).
> Spec of record: `../../design.md` §3.2, §6.2, §9.

## Position in the workflow

```
webhook(application_id)
  → preflight: resolve card (§3.6), load thesis, open ai_run
  → fetch company + deck claims            [Supabase REST]   ◀── feeds this agent
  → LLM market-categorizer                 [luna]            ◀── THIS AGENT
  → query builder                          [Code, 5 queries] ◀── consumes this agent
  → Tavily /search ×5
```

**No web search has run when this agent executes.** It sees only what the company said
about itself. This is the single most important fact about its input, and it is why the
agent is forbidden from emitting any number at all (design §9: every numeric assertion
must carry the `source_url` it came from — this agent has no source URLs).

## Input variables

All variables are injected into the USER MESSAGE as n8n expressions. The upstream node
is a Supabase REST read unless stated otherwise.

| Variable | Type | Required | Source | Notes |
|---|---|---|---|---|
| `{{ $json.company_name }}` | string | **yes** | `companies.name` (NOT NULL) | Always present. |
| `{{ $json.company_domain }}` | string \| null | no | `companies.domain` | Nullable in schema. Also used later by the curator's first-party exemption (§4) — not by this agent. |
| `{{ $json.company_one_liner }}` | string \| null | no | `companies.one_liner` | The primary classification signal. |
| `{{ $json.company_category_existing }}` | string \| null | no | `companies.category` | A label a previous run or the intake form already set. Treated as a hint, not as truth. |
| `{{ $json.company_stage }}` | `"pre_seed" \| "seed"` | **yes** | `companies.stage` (NOT NULL, CHECK) | Context only. Early-stage-only by design; no later-stage vocabulary should ever appear in the output. |
| `{{ $json.known_categories }}` | string[] | **yes** (may be `[]`) | `SELECT DISTINCT category FROM companies WHERE category IS NOT NULL` | The canonical-normalisation target set (§9). An empty array is legitimate on a cold database — the agent then mints. |
| `{{ $json.deck_claims }}` | object[] | no (may be `[]`) | `claims` where `card_id = <pinned card>` and `source_kind = 'self_reported'` | **Empty for every `radar_activated` application** — those rows are deckless by schema design (`applications.deck_storage_path` nullable). Not an error condition. |
| `{{ $json.thesis_geos }}` | string[] | no (may be `[]`) | `theses.config.geos` via `applications.thesis_id` | `applications.thesis_id` is nullable → empty array means **global**, and the query builder sets `missing_flags.no_thesis_geography = true` (§4). Passed to the agent so `icp`/`buyer_unit` can be geography-appropriate. |

### `deck_claims[]` element shape

```jsonc
{
  "topic": "traction.pilots",              // dotted slug, claims.topic
  "text_verbatim": "3 paid pilots with…",  // claims.text_verbatim, word-for-word
  "value": { }                             // claims.value, JSONB, may be null
}
```

Only `source_kind = 'self_reported'` claims are passed. Derived/public claims from
earlier runs are deliberately excluded — this agent must classify what the founder
said, not re-read the pipeline's own prior conclusions back to itself.

## Volume and truncation

Typical payload is small: a one-liner plus 5–30 deck claims. Cap `deck_claims` at the
50 most recent by `created_at` in the upstream node; a deck that produced more than 50
self-reported claims contains nothing extra that changes a category label, and the
truncation keeps the prompt inside the flat-rate token band.

`known_categories` grows over the demo but stays in the tens; no cap needed for MVP.

## Degenerate inputs the agent must survive

| Input condition | Expected behaviour |
|---|---|
| Name only, no one-liner, no deck claims | `status.code = "abstained"`, `ok: true`, all category fields null, five `gaps[]` entries. Not an error. |
| One-liner is a slogan with no product content | Same as above. |
| Name, one-liner and deck claims all empty | `status.code = "insufficient_input"`, `ok: false`. The only true failure path. |
| `known_categories: []` (cold database) | Mint a canonical label; no gap. |
| `deck_claims: []` because the row is `radar_activated` | Normal. Classify from the one-liner alone. Never flag the missing deck as a data-quality problem — deckless is a supported funnel state. |
| Non-English one-liner | Classify normally; emit `canonical`, `icp` and `buyer_unit` in English (the whole claim vocabulary is English), keep `raw` in the company's own words. |

## Contract with the consumer node

The query builder (deterministic Code node, §4) reads:

- `data.category.canonical` → `{category}` in queries Q2, Q3, Q5
- `data.category.buyer_unit` → `{buyer_unit}` in queries Q1, Q2
- `data.category.adjacent[]` → the adjacent-entrant discovery searches in the
  competition sub-workflow (§8)
- `data.category.buyer_concentration` → **query phrasing hint only.** The
  authoritative value is derived later in the validator from the sizer's
  evidence-backed `buyer_count` (§6.2). If they disagree, the derived value wins and
  `missing_flags.concentration_revised = true` is set.

If `buyer_unit` is `null`, the query builder **must not** substitute a generic noun.
Q1 and Q2 are skipped, `missing_flags.no_buyer_unit = true` is raised, and the TAM
band ends `UNKNOWN` (§6.0/§6.1) — never `FAIL`.

The whole `data.category` object is written verbatim as the `value` JSONB of the
`market.category` claim (§3.2), which is why its six keys must be present in every
response including abstentions.
