# 04 · Market, Trend & Competition Intel — Design

> Status: **DRAFT rev.3 — spec-review rounds 1-2 applied, awaiting operator approval** (2026-07-19).
> Scope: the `market` and `idea_vs_market` screening axes as n8n research workflows over
> Tavily + OpenAI, writing into the feature-01 schema. Supersedes the «Implementation view»
> sketch in [README.md](README.md).
>
> Sources consulted (CLAUDE.md hard rule, all four channels):
> intel base (REQ-002/003/004, SCOPE-001/007, SIG-008/013/024/026/027, PAIN-008/009,
> RSK-002/003/004) · OSS references ×6 with exact file/line extraction
> (venture-capital-intelligence, reporting, Deal_flow_analyzer, vantage, vcbrain,
> company-research-agent — all MIT/Apache-2.0) · NotebookLM project notebook ×10 queries
> (early-stage framing) · Exa (report-mill credibility, bottom-up TAM practice) · live
> Tavily probe + Tavily API docs.
>
> Operator decisions (2026-07-19 ~03:55): **scope A+** (two workflows + numeric momentum
> layer); **competitors stored as `claims`**, following the feature-01 §9 handoff contract —
> no schema migration.
>
> **Provenance caveats on our own research** (recorded because this feature's entire thesis is
> that unaudited citation chains are how fabrication enters a system — we do not get to exempt
> ourselves): the NotebookLM batch ran all 10 questions in **one conversation thread**, so
> answers 2–10 saw the earlier turns and are not independent probes; its citation markers came
> back as bare `[n]` without resolvable source titles. Grounding is strong on Q2 (trend
> velocity), Q4 (idea-vs-market axis), Q8 (pre-seed moats) and Q10 (LLM failure modes) and
> those carry weight here. It is **weak on Q7** — the `threat_level`/`switching_cost` ordinals
> were authored by the model on request, and are labelled as our own rubric in §3.3 — and
> thinnest on Q6, whose quotes came back garbled and are therefore paraphrased, never quoted.

## 1. The finding that inverts the naive design

A live `/search` for `"AI agent observability market size 2026"` returns, in the top three:
`precedenceresearch.com`, `grandviewresearch.com`. These are exactly the domains that our
best-in-class OSS reference for market sizing (VCI `skills/market-size/SKILL.md` STEP 2)
**hard-codes as search targets**:

```
"[market category] market size 2024 2025 billion" site:statista.com OR
    site:grandviewresearch.com OR site:mordorintelligence.com
```

Independent research says these are the worst possible anchors:

| Finding | Source |
|---|---|
| «Report mills» maintain listings as placeholders, assemble content from public internet sources into a template on purchase; CAGRs cluster at 15–25% regardless of industry; methodology sections identical across unrelated reports | sectorial.io practitioner assessment |
| DD teams at MBB-level firms **explicitly prohibit** Grand View Research for market sizing in client work | sectorial.io |
| 153 such publishers profiled: 93.5% trace to India, half to one city (Pune); one publisher lists 2 employees on LinkedIn against a claim of 5,000 reports/year (Gartner: ~3,500/yr with 17,000 staff) | Nichau via bellandholmes.com |
| Estimates for the same market diverge 30–50% between providers — «at least one is materially wrong, often both» | sectorial.io |
| Reports cite each other in a chain until the trail dead-ends; «five sources agreeing means nothing if all five read the same upstream PDF» | bellandholmes.com |
| The fabricated number now propagates into LLM training data and comes back as a confident sourceless answer | bellandholmes.com |
| Tech companies at IPO have typically attained **0.1%–2%** share of their addressable market — pitch decks routinely assume 10% | Pear VC survey of 30 VCs |
| «Capturing 10% of the Fortune 100 is more realistic than capturing 10% of 100,000 SMBs» — attainable share depends on buyer concentration | Pear VC |

NotebookLM independently named the same mechanism **«AI source laundering»**: *«a weak claim
is cited and re-cited until it looks independently verified. Five citations do not mean five
independent sources»*, alongside **«AI claim drift»** (certainty inflation, scope broadening,
lost attribution) and **«AI context collapse»** (facts from different events merged into one
false account — «every detail is real, the story they tell together is not»).

**Consequence for this feature.** A generic ingestion+enrichment pipeline over web search
does not merely produce mediocre market analysis — it produces *confidently cited fabrication*,
which is the precise failure the rubric's Trust criterion (25%) and REQ-004 punish. Market
sizing is therefore designed **bottom-up first, evidence-tiered, and range-valued**, with the
report mills on a hard blocklist. This is the single largest design decision in feature 04.

## 2. Binding constraints

| Constraint | Where it comes from | Design answer |
|---|---|---|
| Axes never averaged; each carries a trend | REQ-002, brief FAQ-5 | Two independent `scores` rows (`market`, `idea_vs_market`), each with its own `trend`, `confidence`, `missing_flags`. No composite. |
| Missing → confidence down, never the score | REQ-003, Carl @1:10:40 | §6.0 unknown-state rule: **no scoring term may go negative on absence**. Gaps are `claims` rows with `verification_status='missing'`. |
| No fabrication | REQ-004 | Validator rejects any number without a resolvable `source_url`; unresolvable → `missing` claim. Abstention is a valid workflow output. |
| Trust per claim, not per company | brief FAQ-7, invariant #3 | Every market/competition assertion is one `claims` row with its own `evidence` rows and tier. |
| Weak market may be run against team potential | SIG-008 (Carl @19:23) | Underestimation guard (§7): a FAIL never auto-kills; it emits a shadow-market hypothesis and lowers confidence. |
| Zombie-startup ceiling must be caught pre-check | PAIN-009 | Venture-scale ceiling test with a concentration-dependent share (§6.2). |
| Founder's competitor knowledge = maturity signal | SIG-024 | Found-but-unmentioned competitors write to two axes (§8). |
| «If it can be a SKILL.md file, you can't invest» | SIG-027 | Non-code moat check on `idea_vs_market`, additive-only (§6.4). |
| Distribution > build speed in 2026 | SIG-013 | Build-speed claims carry no weight; distribution/switching-cost do. |
| Survivorship-bias-aware calibration | RSK-004 | Share assumptions calibrated to observed IPO bands, not deck-standard 10% (§6.2). |
| Verbatim layer against LLM echo chamber | RSK-003 | `evidence.quote_verbatim` stores the source sentence word-for-word alongside every derived number. |
| Early-stage only | operator, Jul 19 | No NRR/churn/LP/cohort fields anywhere. |
| Tavily budget 4,000 credits/month, shared | research/tavily | `/search` basic (1 credit) is the workhorse; `/extract` in **one batched call** on curated survivors; `/research` (4–110 credits, ×27 variance) **not used**. |

## 3. Data model — zero migrations

Feature 01 `design.md` §9 already assigned this feature its contract: *«Competitor entities
live as claims with structured `value` (typed per_competitor_record vocabulary from reporting),
not as a dedicated table in MVP.»* Operator confirmed. Everything below lands in existing
tables.

### 3.1 Registry additions (INSERT, not DDL)

```sql
INSERT INTO signal_sources (slug, label, base_tier) VALUES
  ('tavily_search', 'Tavily Search',        'discovered'),
  ('tavily_news',   'Tavily Search (news)', 'discovered')
ON CONFLICT (slug) DO NOTHING;
```

This is the extensibility path the registries were built for (01 §4.1) — a new source is an
INSERT, and `tavily_extract` already exists.

**Configuration has no table and none will be created** (the zero-migration promise). All
tunables — report-mill blocklist, domain→tier map, credit cap, momentum window, share-by-
concentration table — live as **constants in a single shared n8n Code node**
(`f04-config`, referenced by both workflows) and are echoed into `ai_runs.output_json.config`
on every run so a stored decision remains reproducible. Thesis-derived values (geography,
sectors) come from `theses.config` at runtime.

### 3.2 Claim topic vocabulary (dotted slugs, per 01 convention)

| `topic` | `axis` | `value` (JSONB) |
|---|---|---|
| `market.category` | `market` | `{canonical, raw, adjacent[], icp, buyer_unit, buyer_concentration}` |
| `market.size_bottom_up` | `market` | `{tam_low, tam_high, currency, buyer_count, buyer_count_source_url, arpu_low, arpu_high, arpu_basis, assumptions[], gaps[]}` |
| `market.size_top_down` | `market` | same shape; **cross-check only, never the primary** |
| `market.growth` | `market` | `{cagr_pct_low, cagr_pct_high, basis, window}` |
| `market.venture_scale_check` | `market` | `{status: PASS\|WATCH\|FAIL\|UNKNOWN, tam_used, share_assumption, share_rationale, exit_multiple, implied_exit_value, scenarios[], rationale}` |
| `market.trend` | `market` | `{direction, recent_events, prior_events, undated_events, window_days, ratio}` |
| `market.why_now` | `market` | `{statement, catalyst_kind, catalyst_artifact_url, catalyst_date, evidence_claim_ids[]}` — `catalyst_kind` is a **required typed enum**: `technology_step_function \| regulatory_shock \| cost_curve \| behavior_shift`. Untyped or uncited → written as `missing` instead. Claim-only: consumed by feature 06, **not** an input to any §6 formula. |
| `market.tailwind` / `market.headwind` | `market` | one claim per item — `{statement}` |
| `market.shadow_market_hypothesis` | `market` | `{statement, displaced_alternative}` — only when the §7 guard fires |
| `market.outlook` | `market` | `{label: bullish\|neutral\|bear, basis}` — the brief's required Market-axis label; a label, never a substitute for the number |
| `competition.competitor` | `idea_vs_market` | `per_competitor_record` (§3.3) |
| `competition.status_quo_alternative` | `idea_vs_market` | `{alternative, why_it_wins_today}` — «sometimes a spreadsheet is the real competitor» |
| `competition.founder_claim_mismatch` | `trust` | `{nature, severity, founder_claim, found_reality, competitor_names[]}` |
| `*.gap` | (axis) | any topic with `verification_status='missing'` — the honest-omission channel |

`source_kind='derived'` for anything the workflow computed, `'public'` for anything lifted
from a fetched page, `'self_reported'` for anything taken from the founder's deck.

**`text_verbatim` semantics on derived rows.** The column is NOT NULL and 01 defines it as
word-for-word source text (the RSK-003 verbatim layer). For rows this feature *derives*, it
holds the human-readable assertion, and the word-for-word source sentence lives in
`evidence.quote_verbatim` instead. Stated explicitly so features 05/06 never read a derived
claim's `text_verbatim` as if it were a quotation. `base_confidence` is set per source_kind:
`public` 0.6, `derived` 0.5, `self_reported` 0.3.

### 3.3 `per_competitor_record` — reporting's schema plus our two typed fields

Borrowed verbatim (Apache-2.0) from `reporting/lib/memo-agent/defaults/research_dossier.yaml`:

```jsonc
{
  "name": "…",
  "category": "direct | adjacent | incumbent | alternative",
  "company_mentioned": false,          // did the founder name them?
  "positioning_summary": "…",          // 1-2 neutral sentences
  "stage": "seed | series_a | series_b | growth | public | private_mature | unknown",
  "most_recent_funding": { "round": "…", "amount": "…", "date": "…", "lead": "…" },
  "differentiation_vs_target": "…",    // neutral framing
  "source_urls": ["…"],

  // OUR ADDITION — a typed gap across all 9 OSS references (prose only everywhere else)
  "threat_level": 1,                   // 1..4 or null = unknown
  "switching_cost": 1                  // 1..3 or null = unknown
}
```

**`threat_level` (1–4) — OUR OWN RUBRIC.** Provenance stated honestly, because this feature
exists to punish laundered citations and must not commit one itself: the NotebookLM pass
name-drops Porter / SWOT / Blue Ocean only in a single vendor page and **authored these
ordinal levels on request rather than extracting them from a source**. What *is* genuinely
sourced is the JTBD «escape direct competition» framing and the observation that an
«absolutely identical product» leaves price as the only axis. So the tiers below are ours,
seeded by JTBD — they must never be attributed to Porter in the memo or the pitch:

| # | Label | Criterion |
|---|---|---|
| 1 | Disruptive innovation | The product eliminates the lower-level jobs entirely; incumbents are neutralised rather than beaten (Uber vs learning to drive / own / maintain a car). |
| 2 | Upstream interception | The product bypasses the competitor by capturing an earlier job in the customer's chain (Amazon capturing product research before the purchase). |
| 3 | Blue-ocean niche | A specific sub-segment is served well, but a large incumbent could pivot and copy. |
| 4 | Perfect competition / red ocean | Substantially identical product with no niche → the only remaining axis is price. **Red flag at pre-seed.** |

**`switching_cost` (1–3)** — the 10× heuristic. This one *is* sourced: the 10×
(cheaper / faster / more effective) threshold and the finding that a 10–20% improvement
«very rarely» triggers a switch both come from the corpus, not from the model:

| # | Label | Criterion |
|---|---|---|
| 1 | Crosses the 10× threshold | Verifiably 10× cheaper / faster / more effective → the switch happens despite friction. |
| 2 | Marginal improvement | 10–20% better → «such a switch very rarely happens»; the incumbent stays. |
| 3 | Zero differentiation | Feature parity with no multiplier → acquisition requires pure marketing spend. |

Both are LLM-*proposed* with cited evidence, then **range-checked deterministically**. Either
may be `null` when the evidence does not support a reading — `null` is a first-class value and
contributes **0** to §6.4, never a penalty.

### 3.4 Evidence tiering — the anti-report-mill enforcement, in data

Every `evidence` row carries `tier` (existing CHECK: `documented | discovered | inferred |
missing`). The mapping is a constant in `f04-config`, not prompt guidance:

| Source class | `tier` | `strength` |
|---|---|---|
| Government statistics, regulatory filings, industry-association data, peer-reviewed work, patents | `documented` | 0.90 |
| Named-methodology analyst firms (IBISWorld, Euromonitor, Gartner/Forrester with disclosed methodology), FT/WSJ/Bloomberg/Reuters, vertical trade press | `documented` | 0.80 |
| Company/competitor websites, product directories, GitHub, Product Hunt, G2 («signal, not statistic») | `discovered` | 0.60 |
| Report mills, SEO listicles, Reddit/HN/X threads | `inferred` | 0.30 |
| **Any domain not matching a rule above** | **`inferred`** | **0.30** |
| Searched and not found | `missing` | 0.00 |

**The unknown-domain row is default-deny, and it exists because the blocklist provably cannot
be complete.** Running the blocklist against live Tavily confirmed it blocks every mill on it —
and returned `astuteanalytica.com` at relevance 0.92, a report mill that simply was not on the
list. There are hundreds of these publishers and new ones appear continuously; a static
enumeration is whack-a-mole. So the blocklist is only the cheap first filter, and the actual
guarantee comes from the tier default: an unrecognised domain is `inferred`, which means it can
never be the sole support for a market-size claim (rule 1 below caps that at confidence 0.4).
A new mill we have never seen therefore fails safe. **Allow-listing is what earns a higher
tier; being unknown never does.**

`evidence.strength` is populated from this table — feature 05's rollup is
`f(tier, relation, strength)` per 01 §4.4, and writing nulls would degrade it silently.

**Two hard rules enforced in the deterministic validator node, not in a prompt:**

1. A `market.size_*` claim whose supporting evidence is *entirely* `inferred` gets
   `verification_status='unverified'` and its axis confidence is capped at **0.4**.
2. **Independence is counted by source, not by citation count** — the implementation of «five
   citations do not mean five independent sources». This is **two distinct mechanisms**, and an
   earlier draft of this rule conflated them into one (its worked example contradicted its own
   stated mechanism — caught during implementation):

   **2a. Distinct registrable domain.** Multiple URLs resolving to the same registrable domain
   count once. Catches one source cited via several paths or subdomains: `blog.x.com` and
   `x.com` are one source; a `.co.uk` pair is one source. Implemented as
   `independentDomainCount(urls)`.

   **2b. Tier collapse for laundered sources.** All `inferred`-tier sources **collectively**
   count as at most **one** independent source, however many distinct domains they span. This
   is the mechanism the research actually describes: report mills recycle each other's figures,
   so `grandviewresearch.com` and `mordorintelligence.com` agreeing is one number laundered
   twice, not two confirmations — *«five sources agreeing means nothing if all five read the
   same upstream PDF»*. Note 2a alone would score that pair as 2, which is exactly the
   over-count we are guarding against. Implemented as
   `independentSourceCount(urlsWithTiers)`:

   ```
   independentSourceCount = |distinct registrable domains among tiers {documented, discovered}|
                          + (1 if any inferred-tier source is present else 0)
   ```

   §6.5's `< 2 independent domains → confidence ≤ 0.55` cap reads **2b**, not 2a — a market
   size supported only by two different report mills must not clear that bar.

The report-mill blocklist is passed to Tavily as `exclude_domains` (hard blocklist, max 150
entries — verified against the API docs): `grandviewresearch.com`, `mordorintelligence.com`,
`marketsandmarkets.com`, `precedenceresearch.com`, `alliedmarketresearch.com`,
`fortunebusinessinsights.com`, `futuremarketinsights.com`, `technavio.com`, `imarcgroup.com`,
`marketresearchfuture.com`, `verifiedmarketresearch.com`, `zionmarketresearch.com`,
`expertmarketresearch.com`, `transparencymarketresearch.com`, `coherentmarketinsights.com`,
`straitsresearch.com`, `globalmarketinsights.com`, `credenceresearch.com`,
`businessresearchinsights.com`, `researchandmarkets.com`.

### 3.5 Write mechanics — idempotency without breaking the provenance chain

The append-only tables carry NOT NULL UNIQUE `content_hash` columns and revoked UPDATE/DELETE.
A re-run of the demo is an explicitly supported path, so every hash recipe is specified here
rather than left to the builder.

| Table | `content_hash` recipe | Conflict behaviour |
|---|---|---|
| `raw_signals` | `sha256(source ‖ source_url ‖ query ‖ observed_at)` | **select-by-hash first, INSERT only if absent, reuse the found id.** `ON CONFLICT DO NOTHING` returns zero rows over PostgREST, which would null out `evidence.raw_signal_id` and break the provenance chain on exactly the re-run we demo. A no-op `DO UPDATE … RETURNING` is not an option: it trips the append-only trigger. |
| `claims` | `sha256(card_id ‖ topic ‖ ai_run_id ‖ item_key)` | `ai_run_id` is in the recipe deliberately: a re-run **must** produce new rows so `scores.trend` has history. `item_key` is mandatory because several topics hold **N rows per run** — `competition.competitor` (one per competitor), `market.tailwind` / `market.headwind` (one per item), `competition.status_quo_alternative`. Without it every tailwind in a run hashes identically and the second INSERT raises 23505, taking the competitor set — this feature's highest-value output — down with it. `item_key` = normalised competitor name, or `sha256(statement)` for free-text items, or the literal `'_'` for singleton topics. |
| `evidence` | `sha256(claim_id ‖ relation ‖ coalesce(source_url,'') ‖ coalesce(quote_verbatim,'') ‖ coalesce(query,''))` | The `query` discriminator is what keeps multiple `tier='missing'` rows on one claim from colliding — those rows have NULL url *and* NULL quote, so without it every «searched and not found» row for a claim hashes identically and the second INSERT raises 23505. |

**`supersedes_claim_id` matches per `(card_id, topic, item_key)`**, not per `(card_id, topic)` —
once a topic holds N rows, «the prior claim with the same topic» is ambiguous. A competitor
found last run but absent this run has **no successor**: its old row is left unsuperseded and
untouched. Inventing a superseding row for a disappearance would assert that we re-checked and
disconfirmed it, when in fact we simply did not find it again.

`raw_signals.observed_at` (NOT NULL, no default) = `coalesce(result.published_date,
search_end_date)`. Only `topic='news'` returns `published_date`, so Q1–Q4 results fall back to
the pinned `end_date` — never `now()`, which would make re-runs non-reproducible.

`tier='missing'` evidence rows use `relation='context'` (they neither support nor contradict —
they record that a search was performed and returned nothing).

### 3.6 Card resolution (preflight)

`claims.card_id` is NOT NULL. Both workflows take `application_id` as input, so the very first
node resolves the card and pins its id for the whole run:

```
SELECT id FROM cards
 WHERE application_id = :application_id AND card_type = 'company'
 ORDER BY created_at ASC
 LIMIT 1
-- if absent: INSERT cards (card_type='company', company_id, application_id, status='draft')
```

`ORDER BY` is not decoration: `LIMIT 1` without it is nondeterministic should two company cards
ever share an application, and a run that silently switches cards between executions would
scatter one application's claims across two cards.

Both market and competition claims attach to the **company** card. A founder card may also
carry the same `application_id`, so filtering on `card_type` is mandatory, not incidental.

### 3.7 Scores written

**Three** `scores` rows per run, `application_id` as subject (satisfying the XOR constraint —
`founder_id` stays NULL, including on the `founder` row: it is the *application's* founder axis,
not the person's persistent score, which 03 owns):

```
axis            = 'market' | 'idea_vs_market' | 'founder'   -- see §6.6 for the third
value           numeric(5,2)      -- deterministic, see §6
trend           'improving' | 'stable' | 'declining'
confidence      numeric(3,2)      -- see §6.5
missing_flags   jsonb             -- what was absent
input_claim_ids uuid[]            -- every claim that fed the number
formula_version 'f04_v1'
prompt_version  'f04_market_v1' | 'f04_competition_v1'
model           'gpt-5.6-…'
thesis_id       -- carried through for reproducibility; may be NULL
```

Append-only: a re-run is a new row. **`scores.trend` is set by §5's momentum computation, which
is authoritative.** Row history is a display concern for feature 09 — it cannot define `trend`,
because run 1 has no history and the field must still be populated.

## 4. Workflow `f04-market-intel`

Topology ported from `company-research-agent` (Apache-2.0), whose LangGraph shape maps 1:1
onto n8n nodes: `grounding → parallel researchers → collector → curator → enricher → briefing`.

```
webhook(application_id)                          [responds 202 immediately; the run is async
                                                  from the caller's view — no Tavily polling]
  → preflight: resolve card (§3.6), load thesis, open ai_run
  → fetch company + deck claims                  [Supabase REST]
  → LLM market-categorizer                       [luna → category raw+canonical, ICP,
                                                  buyer_unit, buyer_concentration]
  → query builder                                [Code, deterministic — 5 queries]
  → Tavily /search ×5                            [basic, 1 credit each,
                                                  exclude_domains = report mills,
                                                  include_usage = true, end_date pinned]
  → curator                                      [Code: score ≥ 0.4, URL-normalised dedup,
                                                  first-party exemption, top-8 per bucket]
  → Tavily /extract — ONE call, urls[] ≤ 20      [advanced]
  → Execute Workflow: f04-competition-intel      [sub-call, §8 — returns competitor records]
  → LLM market-sizer                             [sol; bottom-up, every number carries
                                                  source_url; may abstain]
  → validator + vc_rule_check + ceiling          [Code, deterministic — §6]
  → momentum                                     [Code, deterministic — §5]
  → §7 underestimation guard                     [needs competition output — hence the
                                                  sub-call above]
  → writes: ai_runs → raw_signals → claims → evidence → scores(market)
```

**Ordering constraint resolved.** §7's guard needs `competition.status_quo_alternative` and
`switching_cost`, which are competition-intel's outputs, while competition-intel needs
market-intel's Q3/Q4 search results. A peer-to-peer handoff would deadlock. Competition-intel
is therefore an **Execute Workflow sub-call** invoked mid-flow: it receives the curated Q3/Q4
documents, returns its records, and market-intel writes `scores(market)` last.

**The five queries** (deterministic templates — buyer-count and pricing anchors first,
because those are the two inputs bottom-up sizing actually needs):

| # | Purpose | Shape |
|---|---|---|
| Q1 | Buyer-count anchor | `how many {buyer_unit} in {geography}` — statistics/association/government language |
| Q2 | Pricing anchor | `{category} pricing per {buyer_unit} annual cost` |
| Q3 | Competitor discovery | `{category} startups alternatives to {company}` |
| Q4 | Head-to-head | `{company} vs` — the Deal_flow_analyzer pattern, MIT |
| Q5 | Funding velocity | `{category} raises seed funding round` with `topic='news'`, `time_range='year'` |

`{geography}` comes from `theses.config.geos`; `applications.thesis_id` is nullable, so the
default when absent is **global** (no geographic qualifier in the query) with
`missing_flags.no_thesis_geography = true`.

**Curator's «first-party exemption»**, stated precisely: a document whose host matches
`companies.domain` bypasses the `score ≥ 0.4` relevance gate only. It is still deduplicated and
is still subject to the blocklist — the exemption exists because a company's own site is
definitionally relevant even when Tavily scores it low, not because it is trustworthy.

**Cost per card:** 5 search credits + one `/extract` call on ≤ 20 URLs (`advanced` = 2 credits
per 5 URLs → ≤ 8) ≈ **9–14 credits**, against a 4,000/month shared budget. Hard stop at 25
credits per card (config); `include_usage: true` on every call, the running total accumulated
by us and stored in `ai_runs.output_json.credits` — `/usage` lags, which is a known trap.

**Demo reproducibility:** `end_date` is pinned to the demo date on every search. Without it,
the same scoring run produces different evidence tomorrow — the judge sees one thing on video
and another in the repo.

**Error branches** (each writes an `ai_runs` row and degrades rather than failing the run):

| Failure | Behaviour |
|---|---|
| Tavily 429 / timeout | 2 retries with backoff → then treat that query as empty; `missing_flags.search_failed += query_id` |
| Tavily 432/433 (plan / PAYG limit) | abort remaining searches, proceed with what was gathered, `missing_flags.credit_limit_hit = true` |
| LLM returns non-conforming JSON | 1 re-ask with the schema restated → then abstain (write `missing` claims), never a partial parse |
| All five searches empty | no scores row is written at all; a single `market.gap` claim records that the category could not be researched. **A score with no evidence is worse than no score.** |
| `/extract` partial failure | per-URL failures return empty content and are dropped, matching company-research-agent's graceful-degradation pattern |

## 5. The momentum layer — why `trend` is computed, not asserted

`trend` is a required field on every axis (REQ-002). Feature 04's own name promises *«how the
category trend has moved and where it's heading»*. An LLM adjective does not survive the
question «how do you know?».

`topic='news'` is the only Tavily mode that returns `results[].published_date` — which makes a
funding-event histogram computable. Verified live before committing to this design: a
`topic='news'` funding query returned `published_date` on **10 of 10** results. The format is
RFC 1123 (`"Fri, 26 Jun 2026 06:06:36 GMT"`), not ISO 8601 — the Code node parses accordingly,
and an unparseable date is treated as undated rather than as `now()`.

`T` is the **pinned `end_date`**, never `now()`:

```
undated       = |{ r : r.published_date is absent }|          -- excluded from both buckets
recent_events = |{ r : r.published_date ∈ (T−90d,  T]      }|
prior_events  = |{ r : r.published_date ∈ (T−180d, T−90d]  }|

-- evaluated IN THIS ORDER; the first matching branch wins
1. recent_events + prior_events < 3   → 'stable',  missing_flags.thin_category_signal = true
2. ratio = recent_events / max(prior_events, 1)
   ratio ≥ 1.5                        → 'improving'
   0.67 < ratio < 1.5                 → 'stable'
   ratio ≤ 0.67                       → 'declining'
```

The thin-data branch is listed **first and is evaluated first** — written as a trailing
special case it would never execute, because a band always matches. Undated results are
excluded from both buckets rather than counted as recent (Tavily returns undated news
routinely, and counting them as recent biases every category toward «improving»); the count
is preserved in the claim and, when `undated > recent + prior`, raises
`missing_flags.undated_majority = true`.

**Undated-majority additionally forces the §6.3 momentum TERM to 0** — while the computed
direction is still recorded inside the `market.trend` claim for the memo to show. Without this
the exclusion rule violates §6.0: with 10 in-window events of which 8 lack dates, the survivors
might be `recent=2, prior=3` → ratio 0.667 → «declining» → **−4 on the axis value caused
entirely by absent publication metadata**. That is missing data moving a score, which REQ-003
forbids. Confidence already absorbs the cost through `missing_flags`; the value must not.

Grounding, three independent sources agreeing:
- reporting's market rubric names *«recent funding activity in the space (signal of investor
  conviction)»* as a scored signal;
- vantage implements a momentum bonus on repeated signals within a window (`hiring_ct >= 2 →
  timing +8`) and calls its temporal table *«the moat table … velocity is the alpha»*;
- NotebookLM: *«velocity within a tight time window is the true signal … 10 hires in 6-8 weeks.
  A monthly data refresh makes that signal invisible»*, plus the 30-day convergence rule.

The event counts, the undated count and the window are stored inside the `market.trend` claim,
so the dashboard and the memo can show the arithmetic rather than the adjective.

## 6. Scoring — model proposes, backend decides

The LLM never emits the axis number. It emits sub-assessments with citations; a deterministic
Code node owns the formula (`vantage` pattern; `formula_version` stored on the row).

### 6.0 The unknown-state rule (REQ-003, binding on every term below)

**Every term in §6.3 and §6.4 has an explicit `unknown` state contributing exactly 0, and no
term may go negative on absence — only on a verified negative reading.** Absence moves
`confidence` and `missing_flags`, never `value`. This is stated once here and applies to every
band in the tables that follow; a band table that does not name its unknown case is a defect,
not a shorthand.

The distinction that makes this real: *«no TAM could be established»* is `UNKNOWN` → 0. *«TAM
was established and is $80M»* is `FAIL` → a genuine negative. Three separate paths produce the
first case — the sizer abstained, the TAM was incumbent-anchored and rejected (§6.4), or all
supporting evidence was `inferred` — and none of them may land in the FAIL branch.

### 6.1 `vc_rule_check` — ported from VCI (MIT), thresholds unchanged, half-open intervals

| Metric | PASS | WATCH | FAIL | UNKNOWN |
|---|---|---|---|---|
| TAM | ≥ $1B | [$500M, $1B) | < $500M | no TAM established |
| CAGR | ≥ 15% | [5%, 15%) | < 5% | no growth figure established |

Applied to `tam_low` (the conservative end), **not** VCI's `tam_high` — the generous end is
what report-mill inflation attacks, and we are explicitly guarding against optimism. When
bottom-up abstains but a top-down cross-check exists, the top-down figure may set the band
**only** with `missing_flags.top_down_only = true` and the §6.5 confidence cap applied; it
never becomes the primary `market.size_bottom_up` claim.

### 6.2 Venture-scale ceiling — share depends on buyer concentration

```
implied_exit = tam_used × share_assumption × exit_multiple
tam_used     = tam_low            (same conservative end as §6.1)
exit_multiple = 5                 (PAIN-009 / NotebookLM Q3 worked example)
```

A **constant** share makes this test a degenerate restatement of §6.1's TAM band — it would
add no information. It is not constant in reality either: per Pear VC, *«capturing 10% of the
Fortune 100 is more realistic than capturing 10% of 100,000 SMBs»*. So the share varies with
`buyer_concentration`:

| `buyer_concentration` | Definition | `share_assumption` |
|---|---|---|
| `concentrated` | < 10k addressable buyers (enterprise, regulated, institutional) | 0.020 |
| `mid_market` | 10k–500k buyers | 0.010 |
| `long_tail` | > 500k buyers (SMB, prosumer, consumer) | 0.004 |
| `unknown` | not established | **status = UNKNOWN**, no ceiling computed |

Bands on `implied_exit`: **PASS ≥ $100M · WATCH [$30M, $100M) · FAIL < $30M · UNKNOWN when
`tam_used` or `buyer_concentration` is absent.**

**Why these shares and not the 10%/5%/2% the Pear quote might suggest.** §1's own evidence row
says tech companies at IPO have attained **0.1%–2%** of their addressable market, and §2 binds
us to calibrate on that observed band rather than the deck-standard 10% (RSK-004). Adopting
10% as the score-driving case would contradict both. So the whole scale sits inside the
empirical band, with Pear's *relative* 5× spread between buyer types preserved — the quote
licenses the variation, not the magnitude.

This rescaling is free: **the TAM breakpoints are invariant under scaling share and the exit
thresholds by the same factor.** Dividing the shares by 5 and the bands by 5 ($500M/$150M →
$100M/$30M) leaves every breakpoint below unchanged. The lower thresholds are also the honest
ones for this fund: the brief's check is **$100K at pre-seed**, where a $100M outcome is a real
venture result — the $500M bar belongs to a large multi-stage fund, not to this mandate.

Breakpoints this implies, written out in full so the two gates can be checked against each
other rather than asserted to agree. `factor = share × exit_multiple`:

| Concentration | `factor` | ceiling FAIL below | ceiling WATCH | ceiling PASS at |
|---|---|---|---|---|
| `concentrated` | 0.10 | `tam_low` < $300M | [$300M, $1B) | ≥ $1B |
| `mid_market` | 0.05 | < $600M | [$600M, $2B) | ≥ $2B |
| `long_tail` | 0.02 | < $1.5B | [$1.5B, $5B) | ≥ $5B |

Read against §6.1's single TAM gate (PASS at ≥ $1B), the same $1B market lands in three
different places: **concentrated → PASS on both gates** (they coincide at this threshold),
**mid_market → §6.1 PASS but ceiling WATCH** ($50M implied exit), **long_tail → §6.1 PASS but
ceiling FAIL** ($20M implied exit). **That disagreement is the point, not a defect**: identical
market size,
very different reachability — which is precisely what a single TAM number hides and what
«capturing 10% of 100,000 SMBs» is not. Both readings are written to the claim (`scenarios[]`
additionally carries the 10% and 20% cases, so the investor sees what the founder's own
assumption would imply) and both surface in the memo. The axes never average, and neither do
these two gates.

**`buyer_concentration` is derived, not guessed.** It swings `implied_exit` by 5×, so it may
not be an unsourced pre-search opinion. The `market-categorizer` emits it *only as a query
hint* before any search runs; the **authoritative value is computed deterministically in the
validator** from the sizer's evidence-backed `buyer_count` using the tier definitions above
(< 10k / 10k–500k / > 500k). If the two disagree, the derived value wins and
`missing_flags.concentration_revised = true` records it. When `buyer_count` itself was never
established, concentration is `unknown` → ceiling `UNKNOWN`. This keeps the highest-leverage
input to the ceiling under the same «every number carries a source» rule as every other
number (§9) — it was the one exemption, and exemptions are where fabrication enters.

**The `concentrated` tier coincides with §6.1 at the PASS threshold only, and that is stated
rather than engineered away.** Its ceiling PASS lands at exactly `tam_low` ≥ $1B — §6.1's own
gate — because `0.020 × 5 = 0.10` and `$100M / 0.10 = $1B`. **The tier is not degenerate,
though:** the two gates' WATCH floors differ ($300M here vs $500M in §6.1), so over
[$300M, $500M) they genuinely disagree — §6.1 reads FAIL (base 25) while the ceiling reads
WATCH (−5, not −15), and §7 does not fire. What coincides is one threshold, not the tier.
Two reasons the coincidence at that one point is accepted rather than tuned out:

1. **It is the substantively right answer for that tier.** When there are fewer than 10k
   buyers, reachability and size genuinely converge — 2% of a small institutional buyer set is
   attainable in a way that 2% of 100k SMBs is not. A test that agreed with §6.1 *everywhere*
   would be degenerate; one that agrees where the underlying reality agrees is calibrated.
2. **The alternative is manufacturing a spread the evidence does not contain.** Rescaling to
   force disagreement (e.g. shares that push PASS to $5B/$10B/$20B) would fail nearly every
   pre-seed market and make §7 fire constantly, destroying its signal value. Inventing constants
   so that two gates look independent is the same error §1 is written against.

What must not happen is the coincidence going unnoticed: a reader who sees both gates read PASS
at $1B for a concentrated market must not treat that as two independent confirmations. At that
one threshold it is one gate reported twice; below it, the two carry different information.

**The disagreement runs in both directions**, and the reverse case matters for §7. At
`tam_low` = $400M with `concentrated` buyers the ceiling reads WATCH ($40M implied) while
§6.1 reads FAIL — a small but highly reachable market, where capturing the tier's 2% share is a
real, if modest, outcome. Because §7's guard keys on ceiling `FAIL`, such a market does **not**
trigger the shadow-market hypothesis: nothing about it is mispriced by our own measurement, it
is simply small and honestly so. The guard exists for markets that look small *because we
measured the wrong thing*, not for markets that are small.

`UNKNOWN` never triggers §7 either — a shadow-market hypothesis written on an absent TAM would
be fabrication (REQ-004), which is exactly what the guard is not for.

### 6.3 `market` axis value

| Term | Values |
|---|---|
| base (TAM band) | PASS 70 · WATCH 50 · FAIL 25 · **UNKNOWN 50** |
| CAGR band | PASS +10 · WATCH 0 · FAIL −10 · **UNKNOWN 0** |
| momentum trend | improving +4 · stable 0 · declining −4 · **thin-signal 0** |
| **venture-scale ceiling** | PASS 0 · WATCH −5 · FAIL −15 · **UNKNOWN 0** |

`value = clamp(0, 100, base + cagr + momentum + ceiling)` — range 0…84; the clamp is now
load-bearing at the bottom. UNKNOWN base is 50, deliberately the same as WATCH: an unmeasured
market is treated as *undetermined*, not as a bad one, and the whole cost of that ignorance is
paid in `confidence`.

**The ceiling term exists because without it PAIN-009 is not actually closed.** In rev.2 the
ceiling was computed, stored, and consumed only by §7's narrow three-condition guard — so a
long-tail market at $1.2B with a FAIL ceiling scored 70 and nobody acted on it. That is exactly
the zombie-startup ceiling Carl asks us to catch *before* the check. §6.0 permits this: a
*measured* ceiling FAIL is a verified negative reading, not an absence, so it may move `value`.
UNKNOWN contributes 0, as everywhere else. The double-counting with a FAIL TAM band is
intentional and not redundant — §6.1 measures how big the market is, §6.2 measures how much of
it this company could ever reach.

The momentum term is **±4, not ±8**: at the thin-data threshold of 3 events, `prior=1,
recent=2` reads «improving», and a swing of 8 points on three news articles over-weights a
signal the spec itself calls thin.

`market.outlook` (`bullish | neutral | bear | undetermined`) is written as its own claim
(§3.2), not as a `scores` column — the table has no field for it:
`value ≥ 70 → bullish`, `[40, 70) → neutral`, `< 40 → bear`. **When the TAM band is UNKNOWN
the label is `undetermined`**, never `neutral`: an unresearched market otherwise scores exactly
50 (UNKNOWN 50 + 0 + 0 + 0) and would render a confident-looking «neutral outlook» on zero
evidence — fabrication-by-label, in the one feature built to prevent it.

### 6.4 `idea_vs_market` axis value

| Term | Values |
|---|---|
| base | 50 |
| switching_cost | 1 → +20 · 2 → 0 · 3 → −15 · **null → 0** |
| threat_level | 1 → +15 · 2 → +8 · 3 → 0 · 4 → −20 · **null → 0** |
| articulated accumulating advantage w/ public evidence | present → +10 · absent or unknown → 0 |
| status-quo alternative identified **and displaced** | → +7 · else 0 |
| founder named zero competitors while ≥ 2 were found | → −10 · **not assessable → 0** |

`value = clamp(0, 100, Σ)`. **«Displaced» is a stricter predicate than «identified»** and the
two must not be conflated (§7 keys on *identified*, this term on *displaced*): the +7 requires
the competitive-analyst to assert, with a cited source, that the product removes the manual
work the alternative currently requires — the «mass murder of lower-level jobs» reading. Merely
noting that a spreadsheet exists earns nothing.

The raw sum ranges 5…102, so the clamp would be load-bearing at the top and would make the two
best outcomes indistinguishable. The accumulating-advantage term is therefore **+8 rather than
+10 when `threat_level = 1 AND switching_cost = 1`**, holding the maximum at exactly 100
(50+20+15+8+7). This is a deliberate nonlinearity, not an oversight — do not «simplify» it back
to a flat +10, which would silently collapse the top of the scale.

**The −10 term requires a founder competition view to exist.** `applications.deck_storage_path`
is nullable by design (schema.sql — `radar_activated` rows are deckless cold-outreach entries
created before the founder ever applies). For those, «named zero competitors» is *no data*, not
a claim, and charging −10 would penalise every radar-sourced application for the founder's
silence. The term is gated on a parsed deck or interview being present; otherwise
`missing_flags.founder_competition_view_absent = true` and the delta is 0.

**The moat term is additive-only, and that is deliberate.** NotebookLM Q8 is explicit that
demanding empirically proven network effects or a data moat *at pre-seed* is **«way too strict
a bar»** and generates massive false negatives — precisely the cold-start failure the brief
warns about (FAQ-10). So an absent moat costs **nothing**; what earns the bonus is an
*articulated accumulating advantage backed by a public artifact*. The evidenceable pre-seed
moats, from the same source and consistent with SIG-013/027: owned distribution and
build-in-public footprint · regulated or deep-domain positioning (research grants outrank
patents as a signal) · production-grade architecture depth · OSS community convergence. Raw
build speed earns nothing — it is table stakes (SIG-013), and 90–98% of AI startups are
wrappers over foundation-model APIs.

**Incumbent-sizing prohibition.** A hard rule in both the prompt and the validator: TAM must
**never** be derived from the current size of the incumbent industry the startup displaces.
That is the exact mechanism of the «error of omission» (sizing Uber against the taxi
industry). If the sizer's only buyer-count anchor is an incumbent-industry revenue figure, the
claim is written as `missing` with `missing_flags.incumbent_anchored_tam = true` and the TAM
band becomes **UNKNOWN** (§6.0) — never FAIL.

### 6.6 `founder` axis value — composed, never copied

**Scope addition (2026-07-19, cross-terminal).** Feature 03's design review established that 03
writes `scores(axis='founder_score')` only — the persistent, person-scoped score that 01 §9
assigns it. That left the application-scoped `axis='founder'` screening row unowned, and without
it REQ-002's three independent axes are two. It is reassigned here. 03's reasoning for not
writing it itself is sound and worth recording: a derived `axis='founder'` row written by 03
would race us on a table with no `(application_id, axis)` uniqueness, and would leak
person-derived data past a GDPR erasure for **multi-founder** companies, since `purge_founder`
sweeps application-scoped scores only for sole-founder ones.

**The binding constraint is that Founder Score is an *input*, never a replacement**
(01 §4.1, brief FAQ-6). A passthrough copy would violate it. So:

```
base   = latest scores.value WHERE axis='founder_score' AND founder_id ∈ this application's founders
         (resolved via founder_company.is_current → applications.company_id)
```

| Term | Values |
|---|---|
| base | latest `founder_score`; **no such row → axis UNKNOWN, no row written** |
| founder-market fit (SIG-026) | domain expertise directly in the resolved category **+10** · adjacent category **+5** · **not established → 0** |
| competitor-knowledge maturity (SIG-024) | mismatch `material` −10 · `moderate` −5 · `minor` 0 · no mismatch **and** founder named ≥3 competitors **+5** · **not assessable → 0** |

`value = clamp(0, 100, base + fmf + maturity)`.

**Why these two terms and why they belong to feature 04 rather than 03.** They are the only
founder-relevant evidence that is *application*-scoped rather than person-scoped, and both sit
at the founder × market intersection — which is the axis this feature already researches:

- **Founder-market fit** is the intersection of the founder's domain expertise (claims under
  03's `founder.expertise.*` vocabulary) with **the category this workflow resolved**. Nobody
  else knows the category. SIG-026 rates FMF above market size outright: strong ideas arise at
  the seam of founder experience and market opportunity, and AI does not substitute for the
  founder's domain expertise.
- **Competitor-knowledge maturity** is already computed in §8 as the mismatch severity.
  SIG-024: knowing competitors in detail is the first sign of a mature founder. Reusing the
  severity we already derive costs nothing and closes the loop between the two workflows.

Both terms obey §6.0: «expertise not established» and «no deck to assess» contribute **0**, not
a penalty. Only a *verified* negative — a material mismatch between what the founder claimed and
what we found — moves the value down. And an absent `founder_score` yields **no row at all**
rather than a zero: feature 04 must never manufacture a founder axis for a person 03 has not
scored (§11's «absent axis = not assessed» contract covers the render side).

### 6.5 Confidence (vantage formula, adapted — REQ-003)

```
missing_count = number of `missing`-status claims written this run, capped at 5
evidence_ct   = evidence rows on this axis's claims with relation ∈ {supports, contradicts},
                capped at 6   -- `context` rows are EXCLUDED: tier='missing' rows record that
                                 a search returned nothing, and counting them would let an
                                 empty search raise confidence

completeness = 1 − min(1, missing_count × 0.2)
confidence   = clamp(0, 1, evidence_ct/6 × 0.55 + completeness × 0.45)

hard caps, applied after:
  evidence_ct = 0                                       → confidence ≤ 0.15
  no `documented`-tier evidence behind the size claim   → confidence ≤ 0.40
  independentSourceCount < 2 (§3.4 rule 2b, tier-aware) → confidence ≤ 0.55
  top-down-only sizing (§6.1)                           → confidence ≤ 0.45
```

The `evidence_ct = 0` cap matters: without it the formula floors at 0.45 for a run that found
nothing at all, which would read as moderate confidence in an empty result. Missing data moves
confidence only — the axis value is untouched by absence, enforced by §6.0's shape rather than
by prompt instruction.

## 7. The underestimation guard — the counterweight nobody implements

Every reference in the set (and every commercial screener) applies a market-size floor and
stops. The research is emphatic that this is where the expensive mistakes live:

- Andreessen, via NotebookLM: investors *underestimate* market size more often than they
  overestimate it; sizing Uber against the legacy taxi industry produces the **«error of
  omission»** — rejecting the outlier.
- **Shadow markets:** when technology drastically lowers price, the true market is
  exponentially larger than the legacy one that current data can measure.
- Carl, SIG-008: a weak market reading *may be run against team potential* — it is explicitly
  not an auto-kill.
- NotebookLM Q4 names the exact configuration: high founder + high idea-fit + low market =
  the **«ugly baby»**, where the real alpha sits.

**Rule.** When `venture_scale_check.status = FAIL` — a *measured* market that came up short,
never `UNKNOWN` — **and** a `competition.status_quo_alternative` was identified **and**
`switching_cost = 1` (the 10× threshold is crossed), the workflow:

1. writes a `market.shadow_market_hypothesis` claim naming the displaced alternative,
2. applies a **−0.15 penalty to `confidence`** (floor 0.1): the low reading is now contested,
   and a contested reading is a less certain one. **Order: §6.5's hard caps apply first, this
   penalty second** — a capped-then-penalised value can only go lower, whereas the reverse
   order would let a cap silently restore confidence the guard just removed,
3. sets `missing_flags.shadow_market_unpriced = true`,
4. and lets the memo (feature 06) present **both** readings side by side.

**What this rule deliberately does not do is change `value`.** The low market score still
stands and is still written — raising it would be inventing market size the evidence does not
support (REQ-004), and lowering confidence is precisely the REQ-003-sanctioned response to
«we may be measuring the wrong thing». The guard's job is to make the disagreement *visible*,
not to resolve it. The disagreement between the `market` and `idea_vs_market` axes is
preserved rather than resolved — which is the whole point of REQ-002, and which NotebookLM
stated independently: *«the final decision should not erase the disagreement that preceded
it»*.

## 8. Sub-workflow `f04-competition-intel`

Invoked by market-intel via Execute Workflow (§4), receiving the curated Q3/Q4 documents and
the pinned `card_id`, returning its competitor records so the §7 guard can run.

```
input: application_id, card_id, thesis_id, curated Q3/Q4 documents
  → extract founder-named competitors            [from deck claims; LLM only if a deck exists]
  → 2 additional discovery searches              [adjacent entrants, status-quo alternatives]
  → curator                                      [same heuristics as §4]
  → LLM competitive-analyst                      [terra; per_competitor_record[] with
                                                  company_mentioned, threat_level,
                                                  switching_cost, cited]
  → deterministic mismatch                       [Code: found \ named → mismatch]
  → writes: ai_runs → raw_signals → claims → evidence → scores(idea_vs_market)
  → returns records to the caller
```

`ai_runs` is written here too, not only in the parent: this sub-workflow makes its own LLM call
(`competitive-analyst`), and 01 §4.5 is binding — *«LLM output ALWAYS lands here; target tables
only after the n8n validation node passes it»*. `thesis_id` is threaded through because §3.7
requires it on **both** scores rows.

Five required output buckets, contract borrowed from `reporting` (Apache-2.0), which states
the rationale verbatim: *«The most valuable output of competitive research is usually the
competitors the company did NOT mention. Companies systematically under-represent competition
in pitch materials.»*

1. `company_named_competitors` — required
2. `company_unnamed_competitors` — required, **highest-value output**
3. `adjacent_competitors` — required
4. `incumbent_competitors` — required
5. `build_vs_buy_alternatives` — *«sometimes a spreadsheet is the real competitor»*

**The mismatch writes in two shapes, because two features consume it differently:**

- a `competition.founder_claim_mismatch` **claim** on the `trust` axis, typed with
  `reporting`'s `contradiction_record` enums — `nature: factual | definitional | methodological
  | temporal | scope`, `severity: minor | moderate | material`;
- **and** an `evidence` row with `relation='contradicts'` attached to the founder's original
  competition claim. 01 §4.4 is explicit that *«a contradiction is data, not a flag»* and
  feature 05 recomputes claim status from `evidence` rows — a mismatch that exists only as a
  new claim would never reach 05's recompute path.

**That evidence row needs a target, and in the worst case there isn't one.** `evidence.claim_id`
is NOT NULL, and the founder's competition claim is written by deck-parse, not by us. In the
«we have no competitors» case — the exact scenario this rule targets — the deck often has no
competition slide at all, so no such claim exists. Therefore: if no `competition.*`
`self_reported` claim is present on the card, this workflow **first writes one** with
`verification_status='missing'` and `text_verbatim` recording that the deck stated no
competitive position, and attaches the contradiction to that. The gap becomes a first-class
row, which is what REQ-004 asks for anyway.

Feature 04 writes the mismatch; it never computes a Trust number (per-claim trust stays
computed-live, invariant #3).

Severity is deterministic, not an LLM judgement:

```
0 named, ≥2 found                        → material   («we have no competitors»)
named ≥1, ≥3 found unnamed incl. funded  → moderate
named ≥1, only adjacent ones unnamed     → minor
no deck / no founder competition view    → no mismatch claim at all (not assessable)
```

**A «we have no competitors» claim is a named, hard-coded flag.** The research reading (Q6 —
the thinnest answer in the NotebookLM batch, and several of its quotes came back garbled, so
this is paraphrased rather than quoted): the claim signals that the founder has not researched
how customers solve the problem today and has not defined a differentiation — a failure of
market awareness, on top of the sincerity failure.

**The omission writes to TWO places and must not be collapsed into one penalty:**

1. the `trust` axis, as the mismatch claim + contradicts-evidence above, consumed by feature 05
   (sincerity — did they hide it?);
2. the `idea_vs_market` axis, as the −10 market-awareness term in §6.4 (maturity — do they
   even know their landscape? SIG-024: knowing competitors in detail is the first sign of a
   mature founder).

These are different failures with different remedies, and REQ-002's whole logic is that
collapsing distinct signals hides the disagreement the investor needs to see.

## 9. AI logic — routed through `ai-agent-builder`

Per CLAUDE.md, every product prompt is specified through the `ai-agent-builder` skill, not
written ad hoc. Three agents, each with input spec, system prompt, JSON output schema and
model choice:

| Agent | Model | Job |
|---|---|---|
| `market-categorizer` | `gpt-5.6-luna` | classification/extraction — category (canonical + raw), adjacent categories, ICP, buyer unit, buyer concentration |
| `market-sizer` | `gpt-5.6-sol` | the hard reasoning step — bottom-up construction with per-number provenance and explicit assumptions |
| `competitive-analyst` | `gpt-5.6-terra` | landscape mapping into typed records |

Category handling closes the README's open question: **free-form label + canonical
normalisation**, per NotebookLM Q1 — a fixed taxonomy *«forces novel, ill-defined startups
into generic, inaccurate legacy buckets»*, while unconstrained free-form produces a synonym
zoo («AI Infra» / «LLM Infrastructure» / «Artificial Intelligence Backend»). Both fields are
kept (`raw` and `canonical`); the canonical one is normalised against categories already
present in `companies.category`. Full clustering (embeddings/Leiden) is post-MVP — noted, not
built, and the notebook's own recommendation there assumes a vector DB we deliberately lack.

**Prompt-level guardrails**, each traceable to a named failure mode:

- every numeric assertion must carry the `source_url` it came from — the validator drops
  numbers that fail to resolve (REQ-004, no fabrication);
- **abstention is explicitly permitted**: *«insufficient evidence»* is a valid answer and
  produces a `missing` claim rather than a guess (NotebookLM Q10);
- ranges, never point estimates — *«a single TAM number is a red flag; a triangulated range is
  defensible because it shows your work»*;
- **triangulate, do not average** — divergence between sources is reported as an uncertainty
  band, not smoothed into a mean;
- verbatim quote preserved next to every derived number (RSK-003, echo-chamber defence);
- inverted from `company-research-agent`'s `INDUSTRY_BRIEFING_PROMPT` rule 4 (*«Never mention
  'no information found'»*) — that instruction is the exact opposite of REQ-004, so ours
  **mandates** explicit gap declaration.

## 10. Boundaries & stubs

No paid data providers (Crunchbase, PitchBook — post-MVP). No vector DB. No GraphRAG /
Leiden clustering (NotebookLM's ideal architecture — honestly labelled post-MVP in the UI).
Competitor tech-stack fingerprinting — post-MVP. Deck-vs-codebase AI-washing detection belongs
to feature 05, not here. `/research` deep-research API deliberately unused (§2). Full
temporal category ledger beyond the single funding-velocity signal — post-MVP.

## 11. Handoff to other features

- **05 truth-gap:** consumes `competition.founder_claim_mismatch` claims **and** the
  `relation='contradicts'` evidence rows on the founder's competition claim, then writes the
  application-level `trust` rollup. Feature 04 writes the mismatch, never the Trust score.
  `evidence.strength` is populated (§3.4) so 05's `f(tier, relation, strength)` rollup works.
- **06 memo:** `market.*` claims populate Market sizing (with stated assumptions — brief
  requirement) and Competition (named clusters, differentiation, future threats). Both
  venture-scale readings, the `market.outlook` label and `market.why_now` render there.
  Citations are `claim_id`s only.
  **Two contracts 06's deterministic decision node must honour:**
  (a) **never threshold on `scores.value` alone.** UNKNOWN base is deliberately 50, identical
  to WATCH — an unmeasured market and a measured $700M market produce the same number and are
  distinguishable only by `confidence` and `missing_flags`. That is correct under REQ-003 and
  it makes `value` uninterpretable in isolation.
  (b) **an absent axis row means «not assessed», not zero.** §4's all-searches-empty branch
  writes no `scores(market)` row while the sub-workflow will usually already have written
  `scores(idea_vs_market)` — so an application can legitimately end with one axis scored and
  one missing. 06 and 09 render that as «not assessed»; treating it as 0 would turn our
  honesty about ignorance into a penalty, which is the precise inversion of REQ-003.
- **07 thesis:** `thesis_id` carried onto both `scores` rows; `theses.config.geos` narrows Q1.
- **09 dashboard:** the card's «Market» tab — category chip, trend arrow with its event counts,
  TAM range with tier badges, competitor table sorted by `threat_level`, unnamed-competitor
  callout, outlook badge. Score history across runs renders here (not as `scores.trend`).
- **10 API/CLI:** claims are exposed as-is over PostgREST; `competition.competitor` records are
  queryable by `value->>'threat_level'`.
- **11 demo data:** synthetic profiles seed a deliberate competitor omission so the mismatch →
  Trust path demos safely.

## 12. Open items for the plan

- Whether the momentum window (90/180d) stays constant or becomes thesis-configurable —
  leaning constant for MVP, demo-tuned.
- Whether a second-model check on the size claim is worth it (would populate
  `ai_runs.disagreement`, which NotebookLM argues is *«a signal about the evidence
  underneath»*) — stretch, only if the QA gate clears early.
- Backfill of `metric_observations` from the funding-velocity histogram (01 §11 nice-to-have)
  — would give feature 09 a real sparkline; cheap, but not on the critical path.
