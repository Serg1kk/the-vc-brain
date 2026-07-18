# The VC Brain — Vision

> Status: DRAFT — being worked through with the operator (2026-07-18). Decisions are committed
> via process-meetings into the intel base. Russian version: [vision.ru.md](vision.ru.md).

## One-liner

An evidence-backed VC brain that discovers and scores founders BEFORE the market sees them,
and hands the investor a decision-ready $100K recommendation within 24 hours — on merit, not network.

## Who it's for (personas — draft, see personas.md)

1. **Fund investment manager** (primary, REQ-007) — lives in the dashboard, acts on the memo.
2. **Agent / automation** (primary, on par with humans) — works through API/CLI/MCP:
   fetch data, update, search. Operator's product requirement: the service = web + API.
3. **Founder-applicant** (secondary) — minimal application form (deck + company name + artifacts).

## Bets (what makes us not «yet another screener»)

- **Cold-start scoring** of founders with no track record — the rubric's main tiebreaker (30% Data).
- **Evidence ledger**: every claim → source → confidence; missing ≠ minus (REQ-003).
- **Axes never collapse** (REQ-002): Founder / Market / Idea-vs-Market + Trust, each with a trend.
- **Three defenses against naive implementations** (our findings, RSK-002..004): provenance checks
  instead of code volume, a verbatim layer against the LLM echo chamber, calibration aware of
  survivorship bias.
- **Agent-first access**: API/MCP as a first-class interface — The VC Brain plugs into other
  agentic pipelines (of the 9 OSS references, only sieve-mcp does this).

## Not doing (SCOPE rulings)

Sales-outreach mechanics, WhatsApp activation, non-VC adaptations, downstream
(portfolio / fund ops / exit).
