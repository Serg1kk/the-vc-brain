# Live AI-layer probe — 2026-07-19 ~04:35, before n8n wiring

Purpose: de-risk the AI layer independently of n8n. If the prompts and schemas do not
behave, that must surface before they are buried in workflow nodes.

Company: **Medows** — «An AI clinical workspace for doctors on ward rounds»
(real Show HN post, pre-seed, no track record — exactly our target profile).
Models: `gpt-5.6-luna` (categorizer), `gpt-5.6-sol` (sizer). Tavily `/search` basic,
`end_date` pinned to 2026-07-19, report-mill blocklist applied. **2 credits spent.**

## Result 1 — categorizer abstained on the one field it could not ground

Emitted `category.canonical = "clinical workflow software"`, `buyer_unit = "acute care
hospitals"`, a specific ICP — and `buyer_concentration = "unknown"` with a structured gap
(`concentration_not_determinable`: geography absent, the buyer population could fall in
different bands depending on it).

It did **not** guess the concentration tier. That matters because concentration swings
`implied_exit` by 5× (§6.2), which is why the design demotes the categorizer's value to a
non-authoritative hint and derives the real one from the sizer's `buyer_count`.

## Result 2 — the sizer refused to fabricate, and caught more than the design asked for

The pricing-anchor query (Q2) returned **zero results** from Tavily. The buyer-count query
returned strong sources: `aha.org` (industry association → `documented`), `jamanetwork.com`
(peer-reviewed → `documented`), `definitivehc.com` (company site → `discovered`).

Given a good buyer anchor and no price anchor, the sizer returned `status: "abstained"` with
six typed gaps and **no numbers at all**:

- `geography_mismatch` — **not a rule we wrote.** The sources are US-only while the company
  geography is global, so they cannot establish the global population. This fell out of the
  general «every number carries a source» constraint rather than any specific instruction.
- `no_buyer_count_anchor` — explicitly refused to treat «7,378 tracked active U.S. hospitals,
  more than half short-term acute care» as an exact count: not exact, not global.
- `no_pricing_anchor` — «ARPU and TAM were not estimated».
- `no_top_down_figure`, `no_growth_figure`
- `why_now: no_typed_catalyst` — §3.2's rule (untyped/uncited why-now is written `missing`,
  never prose) working as specified.

## Why this is the feature's thesis, demonstrated

A naive pipeline over the same query would have taken a report-mill «$X billion by 2030»
page and produced a confident, cited, wrong number. Ours produced an honest, structured,
machine-readable «we do not know, and here is precisely what is missing» — which is what
REQ-003/REQ-004 demand and what the rubric's Trust criterion (25%) actually rewards.

**Reusable as:** the QA baseline for the abstention attacks (E1), and a demo-video beat —
the same company run before and after the pricing anchor is supplied.

**Caveat:** this exercised the categorizer and sizer only. The competitive-analyst, the
deterministic validator, the write path and the momentum layer were not in this probe.
