# The VC Brain — MVP Backlog

> One folder per feature, numbered 01-12. Each folder's README.md is the feature's full context:
> what it is, why, where the idea comes from (with sources), and how implementation is seen.
> Grooming / spec / plan / build per feature happens in separate terminals; artifacts of that
> work (spec.md, plan.md) land inside the feature folder. Russian versions: README.ru.md next
> to each file. Non-MVP ideas → [`post-mvp/`](post-mvp/).
>
> Read first: [`../roadmap.md`](../roadmap.md) (locked decisions) ·
> [`../personas.md`](../personas.md) · intel trackers in `internal/Meetings/`.

**Parallelization & dependencies: [TRACKER.md](TRACKER.md)** — waves, critical path, terminal rules. Update Status there as features move.

## Features (MVP)

| # | Feature | One-liner | Depends on |
|---|---|---|---|
| [01](01-memory-data-model/) | Memory & data model | Supabase schema: founders, companies, cards, claims+evidence ledger, append-only versioned scores, watchlist | — |
| [02](02-sourcing-radar/) | Sourcing radar | GitHub+HN scan → identity resolution → discovery feed; other channels as honest stubs | 01 |
| [03](03-founder-score/) | Founder Score (cold-start) | Signal/anti-signal scoring of the Founder axis; «model proposes, backend decides» | 01 |
| [04](04-market-trend-competition/) | Market, trend & competition intel | Product category → category trend dynamics → TAM sanity → competitive analysis (Tavily research) | 01 |
| [05](05-truth-gap-trust/) | Truth-gap & Trust Score | Per-claim verification, contradictions, trust score; missing → confidence down | 01, 03, 04 |
| [06](06-memo-decision/) | Memo & decision | Required-section memo + deep-dive questions + $100K recommendation | 03, 04, 05 |
| [07](07-thesis-engine/) | Thesis Engine | Configurable fund lens: sectors/stage/geo/check/risk; pre-filter gate + feed lens | 01 |
| [08](08-founder-intake-interview/) | Founder intake & interview | Minimal form → pre-filled chat interview (voice in/out via ElevenLabs) → cards live-build → share-link 2nd interview | 01, 02 |
| [09](09-investor-dashboard/) | Investor dashboard | Ranked feed (K1) + founder card + memo view (K2) + channel stubs + thesis lens | 01-07 |
| [10](10-api-cli-skill/) | API, CLI & Claude skill | REST (OpenAPI) + Typer CLI + ready-made Claude skill with full docs | 01-07 |
| [11](11-demo-data-ethics/) | Demo data & ethics layer | 3-5 real founders + 1-2 seeded-contradiction synthetics; opt-out, public-only, data minimisation | 02-08 |
| [12](12-docker-deploy/) | Docker & deploy | docker-compose (api+web), local test server, VPS at the end | all |

## Status legend

Each feature README carries a `Status:` line: `backlog → groomed → spec → in-build → done`.
All start as `backlog`.
