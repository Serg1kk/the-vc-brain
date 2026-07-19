# Demo data — `11-demo-data.sql`

10 synthetic applications for the investor-dashboard demo, written against the live
`db/schema.sql` (2026-07-19) in the style of the repo's existing fixtures
(`03-founder-score.sql`, `07-thesis-engine.sql`).

## Apply

Copy the file to `db/fixtures/11-demo-data.sql` in the repo, then:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/11-demo-data.sql
```

Idempotent: fixed UUIDs in the reserved `11f0…` range, every INSERT is
`ON CONFLICT (id) DO NOTHING`, whole file in one transaction.

## What it deliberately does NOT insert

No `scores`, `score_components`, `thesis_evaluations`, or `memos` rows — same stance as
fixture 07. This file supplies the **source-of-truth rows** (founders, companies, identities,
edges, applications, cards, claims, raw_signals, evidence, metric_observations, events);
run the pipelines against it to produce the numbers:

- `lib/f03/run.js` → founder scores. Verified live 2026-07-19: tracewire 82.80 · quietgpu
  23.68 (low-conf) · saltmarsh 82.44 · ferrofluid 71.62 (R2 red flag visible on the scored
  row) · patchbay's Yuki Andersen correctly hits the `insufficient_evidence` branch (0 score
  rows, `founder_score_insufficient_evidence` event). Recorded sub-scorer replays for quietgpu
  and ferrofluid live under `lib/f03/recorded/11-demo-fixture/{andrei,tomas}/` — re-runnable
  via `--recorded` without spending OpenAI budget.
- `lib/f07/run.js` → thesis verdicts (Kelpgrid = geo miss; Playdrift = insufficient evidence)
- `lib/f05/run.js` → trust (Voltaic's pilot claim should derive `contradicted`)

## The 10 companies

**Inbound (5)** — deck applications:

| # | Company | Founder | What it exercises |
|---|---|---|---|
| 1 | Voltaic Labs (Berlin, ai-infra) | Jonas Reiter | On-thesis; **documented contradiction** — deck "three paying pilots" vs own homepage "join the waitlist" + `claim_contradicted` event with the full rich payload |
| 2 | Cassia Health (Amsterdam, healthtech) | Femke de Winter | On-geo; `stage_evidence` is a first-class **not-disclosed gap** |
| 3 | Kelpgrid (Copenhagen, climate) | Nikolaj Brandt | Strong company **outside thesis** → "Outside thesis" lane, never "rejected". ⚠️ verified-live correction: the actual driver is **sector** (climate, off the b2b-software/ai-infra/devtools mandate — `M_sector` missed), NOT geography — Copenhagen/DK **satisfies** the EU/US geo rule (`M_geography` weight 20 applied). Verdict `borderline`, coverage 1.00. The "Outside thesis, never rejected" beat holds; the label just reads sector, not geo. |
| 4 | Ledgerline (Paris, fintech) | Claire Bosquet | **Forecast claim** (`market.size_tam`, never verdict-eligible) + qualitative claims |
| 5 | Playdrift (Austin, consumer) | Marcus Vale | Sparse deck, 3 of 5 attributes missing → **insufficient_evidence** by construction |

**Radar (5)** — `radar_activated`, deckless by design:

| # | Company | Founder | What it exercises |
|---|---|---|---|
| 6 | tracewire (Berlin, ai-infra) | Mila Sørensen | Flagship radar story: high obscurity (14 gh followers, 89 karma), documented E1/E3/E5, **searched-nothing-found** provenance row (tier=`missing`, no quote) |
| 7 | quietgpu (Bucharest) | Andrei Balan | **HN-only identity** (no cross-platform link — zero github identity rows); 31 author replies (coachability proxy). Now carries a **real low-confidence founder score** (23.68, confidence 0.22, coverage 0.285) after 2 HN-derived self-reported claims (L2/X6) were added — shows the system *can* score an HN-only founder and honestly flags low confidence, rather than collapsing to insufficient-evidence. |
| 8 | saltmarsh (London, devtools) | Priya Raman | Low-obscurity, strong documented execution: PRs into postgres/postgres, live URL, 130 dependents |
| 9 | ferrofluid (Lisbon, ai-infra) | Tomás Aguiar | **Star-farming red flag R2**: 9,200 stars · 3 forks · issues disabled; same snapshot supports and contradicts the usage claim. Now carries a **real founder score (71.62, confidence 0.59, coverage 0.409)** with R2 **visible on the scored row** — `E5` demoted to `self_asserted` / `evidence_tier=missing` / `demoted_by='R2'` in `score_components`. Marquee "intelligent analysis" beat: a scored founder where the system caught the star-farming. Two documented-tier claims (E1 merged-PR into a foreign repo, X1/X6 pre-funding work) from repos *separate* from the star-farmed snapshot pushed coverage over the 0.25 floor without touching the R2 evidence. |
| 10 | patchbay (Oslo, ai-infra) | Yuki Andersen | Cold start: 1 claim, coverage 0.06, karma-only obscurity basis → "We looked. We are not guessing." + `founder_score_insufficient_evidence` event |

## Ethics note

All people and companies are **fictional** (`is_synthetic = true` everywhere, per feature 11
and the `api_founders.is_synthetic` badge contract). Scenarios are modeled on real 2026
pre-seed patterns (on-prem inference, ambient clinical docs, grid arbitrage, agent audit
trails, eBPF tracing, Postgres lineage) — but fabricating claims, contradictions, or red
flags about **real founders** is exactly the defamation the entity gate exists to prevent,
so none of these rows reference real people. Domains use the `.example` convention.

## Column-shape notes (in case the schema moves)

- `claims`: gap rows use `verification_status='missing'`, `source_kind='derived'`,
  `content_hash=NULL` (gaps have no content to hash).
- `evidence`: `tier='missing'` + `quote_verbatim=NULL` is the searched-nothing-found state.
- `founder_identities` kinds used: `github`, `hn`, `site`.
- `metric_observations` uses `(id, metric, founder_id, value, observed_at)`.
- Radar applications have `deck_storage_path = NULL` (deckless by design).
