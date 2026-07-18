# OSS Borrow-Map (scout report digest, Jul 19)

> What the 9 OSS references actually contain — analyses, cards, data models — and what we
> borrow where. Full detailed report (per-repo, with exact paths): [_oss-borrow-map.ru.md](_oss-borrow-map.ru.md).

## Table A — best-in-class per analysis/card type

| Analysis / card | Best source | Verdict |
|---|---|---|
| Living dossier schema (~30 sections) | vcbrain `packages/shared/src/types.ts` `StartupDossier` | **MVP** — company-card contract |
| Thesis-fit scoring, backend-owned formula | vantage 7-dim scoring; vcbrain mustHaves/dealBreakers | **MVP** («model proposes, backend decides») |
| Immutable versioned scores + AI-output ledger | vantage `CompanyScore` (prompt_version+formula_version), `AIOutput` | **MVP** (traceability invariant) |
| Evidence typing vocab | sieve-mcp: Documented / Discovered / Inferred / Missing | **MVP** |
| Per-claim citation & verification | reporting `paragraph_record` + `research_dossier.yaml` | **MVP** |
| IC memo structure | vcbrain `vc-memo-writer` + reporting `memo_output.yaml`; sieve internal/external split | **MVP** |
| Market sizing (numeric gates) | VCI `tam_calculator.py`: $1B TAM gate, 15% CAGR, 5-yr projection → PASS/WATCH/FAIL | **MVP** |
| Deck parsing + red-flag detectors | VCI analyze-pitch-deck (10 detectors: TAM-abuse, fake-2×2, hockey-stick) | **MVP** |
| Sourcing signal scoring | VCI 6-signal + scorer; vantage momentum bonus (hiring→timing+8) | post-MVP |
| Thesis/firm config engine | dealflow `firm-style.yaml`; reporting `firm_schemas`; vcbrain ThesisStudio | **MVP** (ThesisStudio-style UI) |
| Memory graph | InGa FalkorDB (6 nodes / 7 confidence-scored edges) | post-MVP |
| Card UX layouts | reporting `components/diligence/*`; vantage Deal Radar; vcbrain Dossier page | **MVP** design reference |

## Table B — the two operator priorities

| Question | Best source | Take |
|---|---|---|
| Product categorization | dealflow model Phase-1 enum + vcbrain free-text | MVP: light LLM classify → enum + free-text |
| Category momentum / why-now (numeric) | **VCI market-size gates** + **vantage momentum bonus & generated `why_now` line** | MVP numeric timing; post-MVP temporal ledger |
| `why_now` as a first-class card field | VCI (memo field + Sequoia lens) · vantage why-now card (trigger bullets + «Investor implication») · vcbrain tailwinds[]/headwinds[] | **MVP** |
| Competitor discovery (auto, incl. unnamed) | **Deal_flow_analyzer** dedicated competitive agent (web queries `'[co] vs [competitor]'`) + **reporting**: «most valuable output = competitors the company did NOT mention», build-vs-buy («a spreadsheet is the real competitor») | **MVP** |
| Typed competitor entity | **reporting `per_competitor_record`**: {name, category[direct/adjacent/incumbent/alternative], company_mentioned, positioning, stage, most_recent_funding, differentiation_vs_target, source_urls} + VCI funding/ARR/tech-stack | **MVP** contract |
| Moat / defensibility block | vcbrain moatVsCompetition + barriersToEntry[]; sieve dim-A vocab | MVP block, post-MVP numeric score |
| **`threat_level` + `switching_cost` as typed fields on a competitor** | **NOBODY has it — gap across all 9** (prose only everywhere) | **our differentiation opportunity** — cheap to add; decide at 04 grooming |

## Prompt/schema pantry (exact files)

- vcbrain `packages/server/src/skills/vc-research/SKILL.md` (dossier JSON contract ~L119-180)
- reporting `lib/memo-agent/defaults/research_dossier.yaml` + `rubric.yaml` (best competitive schema)
- VCI `skills/market-size/SKILL.md` + `scripts/tam_calculator.py` (numeric trend/TAM)
- Deal_flow_analyzer `backend/app/crew/{agents,tasks}.py` (dedicated competitive agent)
- vantage `vantage/services/{scoring,ai,memo}.py`, `models.py` (formula, why_now generator, ledger)
- sieve-mcp `src/sieve_mcp/server.py` + `openapi-spec.yaml` (IMPACT-X taxonomy, evidence typing)
- dealflow `scripts/dealflow_lib/firmstyle.py` + `config/defaults/venture-capital.yaml` (thesis config)
