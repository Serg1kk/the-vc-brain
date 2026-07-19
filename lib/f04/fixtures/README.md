# lib/f04/fixtures/

Small synthetic fixture set for feature 04. Nobody owned this (plan.md B1c) even
though three consumers need it: this module's own tests, `f04-competition-intel`'s
standalone run (plan.md C1), and every QA attack in E1. All data below is fictional
(companies, domains, funding amounts) — none of it is a real founder or company.

| File | Shape | Feeds |
|---|---|---|
| `curated-results.json` | one `curate()`-input bucket (raw Tavily `/search`-shaped results, `company_domain`, `query`) with an `expected` block | `curate()` (provenance.js) — exercises the relevance gate, first-party exemption, blocklist, and URL-normalised dedup in one fixture |
| `news-results.json` | one `momentum()`-input set (`endDate` + `results[]` with RFC 1123 `published_date` strings) with an `expected` block | `momentum()` (scoring.js) — recent/prior/undated/out-of-window classification |
| `competitors.json` | `per_competitor_record[]` (design.md §3.3), all `company_mentioned: false` | the §8 severity ladder (`0 named, >=2 found` → `material`) and `ideaVsMarketScore`'s `threat_level`/`switching_cost` inputs |

## Conventions

- **Dates are real RFC 1123 strings**, generated via `new Date(iso).toUTCString()`,
  not hand-typed — the actual Tavily format (`"Fri, 26 Jun 2026 06:06:36 GMT"`),
  verified live per design.md §5. Do not add ISO 8601 dates to these fixtures; that
  is exactly the format `parseRfc1123Date()` must reject.
- **`endDate` in `news-results.json` is pinned**, matching design.md's own
  reproducibility requirement (§4: "the same scoring run produces different
  evidence tomorrow" without a pinned date). Never compute it from `Date.now()`.
- Each fixture carries its own `expected` block so a consumer can assert against
  it without re-deriving the arithmetic by hand, and so a future change to the
  fixture data forces a conscious update to what it's supposed to prove.
- All domains are either fictional (`*.example.com`, `*.example.org`,
  `*.example.net`) or the real report-mill blocklist itself (`grandviewresearch.com`
  in `curated-results.json`, used deliberately to prove the blocklist still wins
  even at a high relevance score).
