# The VC Brain 🧠

**An AI-first VC operating system: evidence-backed $100K investment decisions in 24 hours.**

Built solo during the [HackNation 6th Global AI Hackathon](https://hack-nation.ai) — Challenge 02 «The VC Brain», sponsored by Maschmeyer Group.

🇷🇺 [Русская версия](README.ru.md)

---

## The problem

The best founders might never get funded — not because the idea is weak, but because nobody with a checkbook knows their name. Their story is scattered across pitch decks, GitHub repos, half-built websites and social posts nobody reads carefully. Classic diligence takes weeks of calls, references and dinners — economics that don't work for $100K checks. **Capital flows through networks, not merit.** And early-stage teams are simply invisible to existing VC tooling: they are not on Crunchbase or Dealroom yet.

## About the challenge

The sponsor's brief (public, from the hackathon) asks for a data- and AI-first operating system that changes how venture works — *«the world's largest Shark Tank for AI innovation»*:

- **Pipeline in scope:** `Sourcing → Screening → Diligence → Decision`. Downstream stages (portfolio monitoring, follow-on, fund ops, exit) are explicitly out of scope.
- **Three pillars:** **Sourcing** (find exceptional founders before they formally fundraise — the most important part), **Assessment & Intelligence** (the reasoning layer: transparent about confidence, uncertainty and evidence), **Memory** (the data foundation: deduplicated, timestamped, source-tagged; nothing is thrown away).
- **Founder Score** — a "credit score for founders": a living, evidence-backed profile of skills and track record that persists across applications and sharpens with every milestone.
- **Two intake tracks:** founders apply through a minimal form (deck + company name), or the system discovers them from signals (GitHub, launches, hackathons, papers, accelerator cohorts) — both converge into one screening funnel.
- **Multi-axis screening:** Founder / Market / Idea-vs-Market are scored **independently** (never averaged into one number), each with a trend.
- **Evidence-backed memos:** every claim — traction, revenue, team background, market size — must trace to evidence with a confidence level (Trust Score). Missing data is flagged honestly, never fabricated.
- **Output:** a decision-ready investment memo + a $100K recommendation a human investor can act on within 24 hours.

Judging rubric: Data Architecture & Intelligence (30%) · Investment Utility & Execution (30%) · Intelligent Analysis & Trust (25%) · User Experience & Design (15%). The hardest — and most valued — problem: the **cold-start founder** with no track record yet.

## What we're building

A working prototype of that pipeline with a deliberate focus on the parts that matter most:

- **founder discovery & scoring from primary public footprints** — before the founder ever fundraises,
- **per-claim trust scores** — every statement traced to evidence; gaps lower confidence, not the founder,
- **independent scoring axes with trends** — disagreement between axes is shown, not hidden,
- **decision-ready memos** — honest about what the system knows and what it doesn't,
- **API-first design** — the same service works for humans (web UI) and for agents (API / CLI / MCP).

## Status

🚧 **Hackathon in progress** (July 18–19, 2026). Code, docs and demo are landing here as they are built.

## Deployment

Full deployment instructions: see [DEPLOYMENT.md](DEPLOYMENT.md) — local Docker Compose setup
and a generalized VPS/production deployment behind a reverse proxy.

## License

[MIT](LICENSE).
