# `market-sizer` — Input Specification

> Agent: `market-sizer` · Model: `gpt-5.6-sol` · Type: pipeline step (reasoning / synthesis)
> Pipeline position: `f04-market-intel`, after the batched Tavily `/extract` and after the
> `f04-competition-intel` sub-call; immediately before the deterministic validator
> (design.md §4).
> Spec of record: `../../design.md` §3.2, §3.4, §5, §6.1, §6.4, §9.

## Position in the workflow

```
  → Tavily /search ×5                      [Q1 buyer-count · Q2 pricing · Q3 competitors
                                            · Q4 head-to-head · Q5 funding news]
  → curator                                [score >= 0.4, dedup, first-party exemption, top-8/bucket]
  → Tavily /extract — ONE call, urls[] <= 20
  → Execute Workflow: f04-competition-intel
  → LLM market-sizer                       [sol]     ◀── THIS AGENT
  → validator + vc_rule_check + ceiling    [Code, deterministic — §6]  ◀── consumes it
  → momentum                               [Code, deterministic — §5]
```

This agent is the **only** LLM in feature 04 that sees fetched page content, and it is
the only one permitted to emit numbers. Everything it emits must therefore trace to a
document in its own input — its training-data recollection is explicitly inadmissible
(prompt Instruction 2), because market figures in training data are disproportionately
laundered report-mill numbers that lost their attribution on the way in.

## Input variables

| Variable | Type | Required | Source | Notes |
|---|---|---|---|---|
| `{{ $json.company_name }}` | string | **yes** | `companies.name` | |
| `{{ $json.company_domain }}` | string \| null | no | `companies.domain` | Lets the agent recognise first-party documents. |
| `{{ $json.company_one_liner }}` | string \| null | no | `companies.one_liner` | |
| `{{ $json.category_canonical }}` | string \| null | **yes** (may be null) | `market-categorizer` → `data.category.canonical` | Null means the categorizer abstained → this agent abstains too (Instruction 1). |
| `{{ $json.category_raw }}` | string \| null | no | `market-categorizer` → `data.category.raw` | |
| `{{ $json.category_icp }}` | string \| null | no | `market-categorizer` → `data.category.icp` | Scopes what counts as an addressable buyer. |
| `{{ $json.category_buyer_unit }}` | string \| null | **yes** (may be null) | `market-categorizer` → `data.category.buyer_unit` | The noun the bottom-up model counts. Null + null canonical → abstain. |
| `{{ $json.geography }}` | string | **yes** | `theses.config.geos` joined, or the literal `"global"` | `applications.thesis_id` is nullable; absent thesis → `"global"` and the query builder has already set `missing_flags.no_thesis_geography = true` (§4). |
| `{{ $json.end_date }}` | string (`YYYY-MM-DD`) | **yes** | The pinned demo date used on every Tavily call (§4 reproducibility) | Passed as `as_of_date` so the agent frames figures relative to it rather than to an implicit "today". |
| `{{ $json.documents }}` | object[] | **yes** (may be `[]`) | Curator output + Tavily `/extract` results | The agent's entire admissible world. Empty → abstain. |
| `{{ $json.searches_performed }}` | object[] | **yes** | Query builder + Tavily response metadata | Lets the agent distinguish "searched and found nothing" from "never searched", which is the difference between a `missing` evidence row and silence (§3.5). |

### `documents[]` element shape

```jsonc
{
  "url": "https://www.fdic.gov/analysis/quarterly-banking-profile/",
  "title": "FDIC Quarterly Banking Profile",
  "published_date": "2026-05-28",   // null for most non-news results
  "tavily_score": 0.91,             // relevance, post-curator (>= 0.4 unless first-party)
  "query_id": "Q1",                 // which of the five queries surfaced it
  "content": "…extracted page text…"
}
```

Notes on this payload:

- **Report mills never appear here.** The 20-domain blocklist is passed to Tavily as
  `exclude_domains` and applied before the curator (§3.4). The agent must still treat
  unknown domains sceptically, because the blocklist provably cannot be complete — a
  live probe returned `astuteanalytica.com` at relevance 0.92, a mill that simply was
  not on the list.
- **Tier is NOT passed in.** Evidence tiering is a deterministic domain→tier map in
  `f04-config`, applied by the validator, not by the prompt (§3.4). The agent is asked
  to grade source *class* in prose (Instruction 2) so it does not build a model on a
  single weak page, but it never emits a tier value.
- **`/extract` partial failures arrive as empty `content`.** Per §4 those rows are
  dropped by the upstream node; if any survive, the agent treats an empty `content` as
  a document it cannot quote from, and therefore cannot cite.

### `searches_performed[]` element shape

```jsonc
{ "query_id": "Q1", "query": "how many US community banks", "result_count": 8, "failed": false }
```

`failed: true` corresponds to §4's Tavily 429/timeout branch, where
`missing_flags.search_failed` was already raised.

## Volume, truncation and the token cliff

`/extract` runs on up to 20 URLs in one batched `advanced` call. Extracted pages vary
wildly; a 20-page payload of long pages can reach 150K+ tokens.

**Hard rule for the C1 builder: truncate each document's `content` to 6,000 characters
and cap the payload at 20 documents.** Two reasons:

1. Prompts above **272K input tokens incur 2× input and 1.5× output pricing on the
   whole request** (`internal/research/openai/02-models.md`). At Sol's $5.00/1M that
   turns a $0.15 call into a $0.60 call silently. 20 × 6,000 chars ≈ 30K tokens keeps
   an order of magnitude of headroom.
2. Buyer-count and pricing figures sit near the top of the pages that carry them
   (statistics summaries, pricing tables). Deep-page truncation loses navigation
   boilerplate, not anchors.

Truncation must be marked (`…[truncated]`) so the agent knows it is not seeing the full
page and does not read absence of a figure as evidence the figure does not exist.

## Degenerate inputs the agent must survive

| Input condition | Expected behaviour |
|---|---|
| `documents: []` (all five searches empty) | `status.code = "abstained"`, `ok: true`, all objects null, gap `no_documents_retrieved`. Downstream, §4's branch writes **no `scores(market)` row at all** — a score with no evidence is worse than no score. |
| `category_canonical` and `category_buyer_unit` both null | Abstain with `no_category_established`. Do not attempt to re-derive the category. |
| Documents exist, none contains a buyer count | `size_bottom_up: null` + `no_buyer_count_anchor`. TAM band → UNKNOWN (§6.0), never FAIL. |
| Documents exist, buyer count present, no pricing anywhere | `size_bottom_up: null` + `no_pricing_anchor`, but `why_now` / tailwinds / growth still emitted if sourced. See Desired Example 3 in the prompt. |
| The only quantitative anchor is incumbent-industry revenue | **Abstain**, gap `incumbent_anchored_tam_only`, naming the declined figure. §6.4 hard rule; band → UNKNOWN with `missing_flags.incumbent_anchored_tam = true`. |
| Two sources give materially different buyer counts | Both endpoints emitted as the range; the lower-credibility one recorded as `relation: "contradicts"`; the disagreement named in `assumptions[]`. **Never averaged.** |
| Several documents that all trace to one upstream figure | Counted as ONE source and said so in `assumptions[]`. Independence is counted by distinct registrable domain downstream (§3.4 rule 2), so the agent must not present them as corroboration. |
| Non-English source documents | Quote `quote_verbatim` in the original language, unedited and untranslated; write `assumptions[]` / `basis` / `statement` in English. |

## Contract with the consumer node

The deterministic validator (§6) reads:

| Agent field | Consumer |
|---|---|
| `size_bottom_up` | `market.size_bottom_up` claim (§3.2); `tam_low` drives `vc_rule_check` (§6.1) and the venture-scale ceiling (§6.2) |
| `size_bottom_up.buyer_count` | **The authoritative `buyer_concentration` derivation** (§6.2): < 10k → `concentrated`, 10k–500k → `mid_market`, > 500k → `long_tail`. Overrides the categorizer's hint; disagreement sets `missing_flags.concentration_revised = true`. |
| `size_top_down` | `market.size_top_down` claim; may set the TAM band **only** with `missing_flags.top_down_only = true` and the §6.5 confidence cap ≤ 0.45 |
| `growth` | `market.growth` claim; `cagr_pct_low` drives the CAGR band (§6.1) |
| `why_now` | `market.why_now` claim (§3.2). Claim-only — consumed by feature 06's memo, **not** an input to any §6 formula. Untyped or uncited → written as `missing` instead. |
| `tailwinds[]` / `headwinds[]` | one `market.tailwind` / `market.headwind` claim per item (§3.2), `item_key = sha256(statement)` (§3.5) |
| `evidence[]` | `evidence` rows: `source_url`, `quote_verbatim` (the RSK-003 verbatim layer), `relation`; `tier` and `strength` assigned by the validator from the domain map (§3.4) |
| `gaps[]` | `*.gap` claims with `verification_status = 'missing'` (§3.2) and `scores.missing_flags` (§3.7); `missing_count` feeds the confidence formula (§6.5) |

The agent emits **no** score, band, verdict, implied-exit value, outlook label or trend
adjective — all of those are computed deterministically (§5, §6). Momentum/`trend` in
particular is a news-histogram computation over `published_date`, never an LLM
adjective (§5).
