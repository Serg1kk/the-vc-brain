# `competitive-analyst` — Input Specification

> Agent: `competitive-analyst` · Model: `gpt-5.6-terra` · Type: pipeline step (typed extraction / landscape mapping)
> Pipeline position: `f04-competition-intel` (sub-workflow), after the two additional
> discovery searches and the curator, before the deterministic mismatch node
> (design.md §8).
> Spec of record: `../../design.md` §3.2, §3.3, §6.4, §8, §9.

## Position in the workflow

`f04-competition-intel` is invoked by `f04-market-intel` as an **Execute Workflow
sub-call** (design §4), because §7's underestimation guard needs competition output
while competition needs market-intel's curated Q3/Q4 documents — a peer-to-peer handoff
would deadlock.

```
input: application_id, card_id, thesis_id, curated Q3/Q4 documents
  → extract founder-named competitors     [from deck claims; LLM only if a deck exists]
  → 2 additional discovery searches       [adjacent entrants, status-quo alternatives]
  → curator                               [same heuristics as §4]
  → LLM competitive-analyst               [terra]   ◀── THIS AGENT
  → deterministic mismatch                [Code: found \ named → mismatch]  ◀── consumes it
  → writes: ai_runs → raw_signals → claims → evidence → scores(idea_vs_market)
  → returns records to the caller
```

## Input variables

| Variable | Type | Required | Source | Notes |
|---|---|---|---|---|
| `{{ $json.company_name }}` | string | **yes** | `companies.name` | |
| `{{ $json.company_domain }}` | string \| null | no | `companies.domain` | Lets the agent recognise first-party pages and avoid listing the screened company as its own competitor. |
| `{{ $json.company_one_liner }}` | string \| null | no | `companies.one_liner` | Defines what would count as a competitor. |
| `{{ $json.category_canonical }}` | string \| null | **yes** (may be null) | `market-categorizer` → `data.category.canonical` | Null → abstain (Instruction 1). |
| `{{ $json.category_raw }}` | string \| null | no | categorizer | |
| `{{ $json.category_icp }}` | string \| null | no | categorizer | Who the buyer is; a "competitor" for a different buyer is not one. |
| `{{ $json.category_adjacent }}` | string[] | **yes** (may be `[]`) | categorizer → `data.category.adjacent` | Drives the `adjacent_competitors` bucket. |
| `{{ $json.founder_competition_view_present }}` | boolean | **yes** | `true` iff `applications.deck_storage_path IS NOT NULL` **or** an interview claim exists on the card | **The most consequential input in this spec — see below.** |
| `{{ $json.founder_named_competitors }}` | string[] | **yes** (may be `[]`) | `competition.*` claims with `source_kind='self_reported'` on the pinned card | Empty + `view_present: true` is the "we have no competitors" case. Empty + `view_present: false` is *no data*. |
| `{{ $json.founder_competition_statements }}` | object[] | no (may be `[]`) | Same claims, `text_verbatim` + `value` | The founder's own competitive framing, verbatim. Needed so the agent can see what was claimed, not just which names were listed. |
| `{{ $json.end_date }}` | string (`YYYY-MM-DD`) | **yes** | Pinned demo date (§4 reproducibility) | Passed as `as_of_date`. |
| `{{ $json.documents }}` | object[] | **yes** (may be `[]`) | Curated Q3/Q4 from the parent + the two discovery searches | The agent's entire admissible world. Empty → abstain. |
| `{{ $json.searches_performed }}` | object[] | **yes** | Query builder + Tavily metadata | Lets the agent set `bucket_coverage` to `searched_none_found` rather than `not_searched`, and lets the write node create `tier='missing'` evidence rows with `relation='context'` (§3.5). |

`document[]` and `searches_performed[]` element shapes are identical to the
`market-sizer` input spec.

## `founder_competition_view_present` — why this flag carries so much weight

`applications.deck_storage_path` is **nullable by design**: `radar_activated` rows are
deckless cold-outreach entries created before the founder ever applies (schema.sql,
`applications_deck_required_for_inbound` CHECK restricts the requirement to the
`inbound` track only).

For those rows, "named zero competitors" is **not a claim — it is the absence of a
question we never asked**. Design §6.4 gates the −10 market-awareness term on a parsed
deck or interview being present, precisely so that a radar-sourced company is not
penalised for our own outreach design; §8's severity ladder ends with "no deck / no
founder competition view → **no mismatch claim at all** (not assessable)".

The agent therefore:
- sets `founder_view_assessable: false`,
- sets `company_mentioned: false` on every record (nobody was named because nobody was
  asked),
- sets `bucket_coverage.company_named_competitors = "not_applicable"`,
- emits a `gaps[]` entry `reason_code: "founder_view_absent"`,
- and **must not characterise the founder's competitive awareness in any field.**

Downstream this raises `missing_flags.founder_competition_view_absent = true` and the
§6.4 delta is 0.

## Volume and truncation

Same constraints as `market-sizer`: **truncate each `documents[].content` to 6,000
characters, cap at 20 documents**, mark truncation with `…[truncated]`. Competitor and
pricing information sits near the top of the pages that carry it (product pages, pricing
tables, funding-announcement ledes).

The 272K-token cliff (2× input / 1.5× output on the whole request) applies to Terra
exactly as it does to Sol. At the cap the payload sits around 30K tokens — an order of
magnitude of headroom.

## Degenerate inputs the agent must survive

| Input condition | Expected behaviour |
|---|---|
| `documents: []` | `status.code = "abstained"`, `ok: true`, `competitors: []`, all five buckets `not_searched`, gap `no_documents_retrieved`. |
| `category_canonical: null` | Abstain with `no_category_established`. |
| Deckless entry (`view_present: false`) | `founder_view_assessable: false`; see above. Never a data-quality complaint — deckless is a supported funnel state. |
| Deck exists, `founder_named_competitors: []` | The **"we have no competitors"** case. The agent maps the landscape normally with `company_mentioned: false` throughout. It does **not** compute the severity — the deterministic ladder does (§8: 0 named + ≥2 found → `material`). |
| Founder named a company no document confirms | Still emit the record, `stage: "unknown"`, and note in `differentiation_vs_target` that no independent source was found. Do not silently drop it — a named-but-unfindable competitor is itself information. |
| Documents exist but contain no companies | `competitors: []` with `bucket_coverage` mostly `searched_none_found` and gap `no_competitors_found`. Distinguishable from the `documents: []` case. |
| Only the founder's own claim supports a 10× advantage | `switching_cost: null`. The founder's claim is the thing under examination, not evidence for it. |
| Non-English documents | `quote_verbatim` in the original language, unedited; all narrative fields in English. |

## Contract with the consumer nodes

| Agent field | Consumer |
|---|---|
| `competitors[]` (each element) | One `competition.competitor` claim on the `idea_vs_market` axis (§3.2), `value` = the `per_competitor_record` (§3.3), `item_key` = normalised competitor name (§3.5) |
| `competitors[].company_mentioned` | The deterministic mismatch node (§8): `found \ named` → `competition.founder_claim_mismatch` claim on the `trust` axis **and** an `evidence` row with `relation='contradicts'` on the founder's competition claim. Severity ladder computed by rule, never by the agent. **The derived severity now has TWO consumers** — see the note below. |
| `founder_view_assessable` | §6.4's −10 gate, §8's "not assessable" ladder rung, **and** §6.6's competitor-knowledge-maturity term. Three consumers of one boolean. |
| `competitors[].threat_level` | §6.4 term: 1 → +15 · 2 → +8 · 3 → 0 · 4 → −20 · **null → 0**. Also sorts the competitor table on the dashboard's Market tab (§11 / feature 09) and is queryable over PostgREST as `value->>'threat_level'` (§11 / feature 10). Range-checked deterministically after emission (§3.3). |
| `competitors[].switching_cost` | §6.4 term: 1 → +20 · 2 → 0 · 3 → −15 · **null → 0**. Also the third condition of §7's underestimation guard (fires only when `switching_cost = 1`). Range-checked deterministically. |
| `competitors[].most_recent_funding` | Memo Competition section (§11 / feature 06); funding recency also colours the §8 severity ladder ("≥3 found unnamed **incl. funded** → moderate"). |
| `status_quo_alternatives[]` | `competition.status_quo_alternative` claims (§3.2). `displaced: true` drives §6.4's +7 term; **identification alone earns nothing**. Identification (not displacement) is also the second condition of §7's guard. |
| `accumulating_advantage` | §6.4's additive-only moat term (+10, or **+8 when `threat_level = 1 AND switching_cost = 1`** — the deliberate nonlinearity holding the axis maximum at exactly 100). Absent moat costs nothing. |
| `bucket_coverage` | §8's five required output buckets; `searched_none_found` vs `not_searched` distinguishes a finding from a hole. |
| `evidence[]` | `evidence` rows; `tier` and `strength` assigned by the validator from the domain map (§3.4), never by the agent. |
| `gaps[]` | `*.gap` claims with `verification_status='missing'` (§3.2) and `scores.missing_flags`; `missing_count` feeds the confidence formula (§6.5). |

The agent emits **no** severity, no Trust number, no axis score. Feature 04 writes the
mismatch; it never computes a Trust number — per-claim trust stays computed-live
(invariant #3), and feature 05 owns the application-level rollup (§11).

### The mismatch severity now has two consumers (design.md §6.6, added 2026-07-19)

§6.6 reassigned the application-scoped `scores(axis='founder')` row to feature 04, and
its **competitor-knowledge-maturity term reuses the same severity §8 already derives**:
`material` −10 · `moderate` −5 · `minor` 0 · no mismatch **and** founder named ≥3
competitors +5 · not assessable 0.

So one deterministic severity value now moves **three** axes from a single set of
`company_mentioned` flags:

| Axis | Term | What it measures |
|---|---|---|
| `trust` | the mismatch claim + `contradicts` evidence (§8), consumed by feature 05 | sincerity — did they hide it? |
| `idea_vs_market` | the −10 market-awareness term (§6.4) | maturity — do they know their landscape? |
| `founder` | the competitor-knowledge-maturity term (§6.6) | the same maturity signal, person-scoped |

**Consequence for this agent: nothing changes in what it emits, but the cost of getting
`company_mentioned` wrong tripled.** The prompt's Instruction 9 now states this
explicitly, because a model that softens a flag on the reasoning that an omission "seems
innocent" is not making one lenient judgement — it is silently moving three axes that
were deliberately kept separate. §8 and REQ-002 are emphatic that these are different
failures with different remedies and must not be collapsed; the agent's job is to report
the literal fact (this name is in the founder's list, or it is not) and let each rule
draw its own conclusion.

**Note for the Stage B / validator author:** §6.6's maturity term also needs the count of
competitors the founder named (its +5 rung keys on "named ≥3"). That count comes from
`founder_named_competitors[]` in this agent's *input*, not from its output — the agent
does not echo it back. Read it from the deck claims directly.

### Note on `threat_level` / `switching_cost` provenance

Both are **our own rubrics** (§3.3), and `threat_level` in particular was authored on
request rather than extracted from a source. The prompt forbids attributing it to
Porter, SWOT or Blue Ocean in any generated text — design §3.3 is explicit that these
tiers "must never be attributed to Porter in the memo or the pitch". `switching_cost`'s
10× threshold *is* sourced from the corpus. This asymmetry is carried into the prompt
deliberately rather than smoothed over.
