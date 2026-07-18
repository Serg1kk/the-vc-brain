# 04 · Market, Trend & Competition Intel

Status: backlog · Depends on: 01 · Operator-requested (Jul 19)

## What it is

The Market and Idea-vs-Market axes as research workflows: given a company card, determine the
**product category**, how the **category trend has moved and where it's heading**, a
**TAM sanity check**, and a **competitive analysis** — all via existing research services
(Tavily search/research), no own databases. Results live as claims (with sources) on the
company card and feed the memo.

## Why (rubric & evidence)

- Operator (Jul 19): «не только рынок потенциальный, но и продукт — в какой категории, как
  тренд менялся, меняется ли на перспективу… конкурентный анализ тоже надо делать».
- Brief: Market axis = sizing, competitors, SWOT with bullish/neutral/bear rating; memo
  requires Market sizing (explicit assumptions) and Competition (named clusters, differentiation,
  future threats).
- Carl: idea must address a huge market; weak market can be run against team potential
  (SIG-008, Q&A @19:23). Zombie-startup pain: catch the market ceiling BEFORE the check
  (PAIN-009: TAM × 20-30% share × 5 multiple sanity formula).
- **NotebookLM (project notebook, Jul 19 query):** investors expect TAM/outlook synthesized
  from multiple sources (industry reports, filings, news, social sentiment); category trends
  tracked over time via unstructured text + non-financial indicators (adoption, sentiment);
  competitive analysis = live sourced landscape (real competitors, funding histories),
  tech-stack benchmarking via public repos, **AI-washing detection: deck claims vs actual
  codebase**, adjacent-market threats from unstructured mentions.

## Where the idea comes from

- Intel: SIG-013 (moats: distribution/trust/proprietary data — build-speed is table stakes),
  SIG-027 (venture-scale test: «if it can be a SKILL.md file, you can't invest»), SIG-024
  (founder's competitor knowledge = maturity signal — we CHECK his deck's competition section
  against our own findings → feeds Trust), FACT-009 (base rates for calibration).
- OSS: company-research-agent (Apache-2.0, 2k★) — production LangGraph pipeline over Tavily:
  collector→curator→enricher→grounding→briefing; port its stage logic into n8n nodes.
  Thesis-Agent README: 13-dim scoring, «why now» timing thesis. dealscout README: Market/
  Product/Traction analysts debating.
- e/acc KB: thesis-template «two blocks: value mechanism + why-now timing» (screening →
  memo structure).

## Implementation view

n8n workflows:

1. **`market-intel`**: card → LLM categorizer (category + adjacent categories) → Tavily
   `/search`+`/research` fan-out: category size/growth, funding activity in category (recent
   rounds — «why now» evidence), trend direction (improving/declining/stable + 2-3 cited
   facts) → TAM sanity node (bottom-up: customers × revenue; flag if ceiling < venture-scale
   per PAIN-009 formula) → claims with sources → Market axis sub-scores + bullish/neutral/bear.
2. **`competition-intel`**: category + product description → Tavily search for direct
   competitors (same core job) + adjacent threats → per competitor: {name, url, funding (if
   public), differentiation vs target, threat_level} → compare founder's own competition
   claims vs found reality → mismatch → Trust flag (SIG-024) → Competition block for card+memo.
3. Both write versioned scores (same append-only pattern as 03) with trend field.

UI (feeds 09): company card gets «Market» tab: category chip, trend sparkline/arrow with cited
facts, TAM sanity verdict, competitor table with threat levels, bull/neutral/bear badge.

## OSS borrow-map (scout, Jul 19 — see backlog/_oss-borrow-map.md)

- **Competitor entity contract**: reporting `per_competitor_record` {name, category[direct/
  adjacent/incumbent/alternative], company_mentioned, positioning, stage, most_recent_funding,
  differentiation_vs_target, source_urls} + VCI's funding/ARR fields.
- **Unnamed competitors are the highest-value output** (reporting: «competitors the company
  did NOT mention»; build-vs-buy: «a spreadsheet is the real competitor») — mandatory block.
- **Dedicated competitive agent with active web-discovery**: Deal_flow_analyzer pattern
  (`'[company] vs [competitor]'` queries) → n8n workflow shape.
- **Numeric trend gates**: VCI `tam_calculator.py` — $1B TAM / 15% CAGR / 5-yr projection →
  PASS/WATCH/FAIL; vantage momentum bonus + generated `why_now` one-liner + tailwinds[]/
  headwinds[] fields (vcbrain).
- **Differentiation opportunity (gap in ALL 9 repos):** add `threat_level` and
  `switching_cost` as TYPED fields on the competitor record (everyone else has prose only) —
  cheap, decide at grooming.

## Boundaries & stubs

No paid databases (Crunchbase etc. — post-MVP). Funding histories only from public web via
Tavily. Tech-stack benchmarking of competitors (NotebookLM idea) — post-MVP note in UI.
Deck-vs-codebase AI-washing check lives in feature 05 (truth-gap), not here.

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** category classifier, market/trend researcher, dedicated competitive agent (web-discovery, unnamed competitors).
- **n8n (MANDATORY, two n8n agents):** `market-intel`, `competition-intel`.
- **Data model — LIKELY SCHEMA REVISION:** @database-engineer — typed competitor entity (per_competitor_record + our `threat_level`/`switching_cost` fields), `why_now`, tailwinds[]/headwinds[] on the company card. Reconcile with 01 BEFORE building.
- **UX/Design:** Market & Competition tabs of the card — mock with @designer here, implement in 09.
- **QA:** @qa-engineer — TAM-sanity math, competitor dedup, founder-claims-vs-found mismatch → Trust flag.

## Open questions

- Tavily credit budget per card (search is cheap, /research mini 4-110 credits) — cap in
  config; groom exact fan-out.
- Category taxonomy: free-form LLM or a fixed list? (I lean free-form + normalization node.)
