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

## Differentiators — what makes this product different

**Against the 9 OSS references** (vcbrain, vantage, reporting, InGa, sieve-mcp,
company-research-agent, VCI, dealflow, Deal_flow_analyzer) and the closed precedents
(Parley, SeedForge, Platvix):

1. **Two-sided by design.** Every OSS reference is investor-side only (forms and deck parsing
   at best). We give the founder an active counterpart: a pre-filled voice/chat interview agent
   that builds their evidence card live, answers in 24h instead of silence, and turns rejection
   into a watchlist trajectory. The founder's #1 pain is not rejection — it's time and
   repetition (37% + repetition trap); nobody in the field answers that. We do.
2. **Cold-start founder scoring as the core, not an afterthought.** The field scores what's
   already visible (Crunchbase-style data, deck claims). We score founders who have NO track
   record — from primary public footprints, with 2026-fresh signal calibration: prototype
   signal decayed by vibe-coding, GitHub stars are vanity, persuasion is devalued, distribution
   beats build-speed. Signals nobody else has priced in yet.
3. **Trust you can click.** Per-claim evidence ledger with confidence; missing data lowers
   confidence, never the founder's score; verbatim quotes preserved against LLM echo-chamber
   flattening; survivorship-bias-aware calibration. Most references cite sources; none carry
   the three naive-implementation defenses.
4. **Agent-first access.** The same service speaks human (dashboard) and machine (REST + CLI +
   a ready-made Claude skill a fund's agents plug into with their token). Of the references,
   only sieve-mcp thinks about agents at all.
5. **Voice-native intake.** Spoken answers are stored as provenance artifacts (a voice original
   is harder to fake than pasted text) — and the path to a voice agent that hears hesitation
   and LLM-assisted answering is on the roadmap (next phase).
6. **The judge-facing meta-differentiator:** the system is honest about what it knows and what
   it doesn't — which is literally the top line of the rubric's Data criterion.

## Not doing (SCOPE rulings)

Sales-outreach mechanics, WhatsApp activation, non-VC adaptations, downstream
(portfolio / fund ops / exit).
