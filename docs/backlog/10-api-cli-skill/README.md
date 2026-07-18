# 10 · API, CLI & Claude Skill (agent-first access)

Status: backlog · Depends on: 01-07 · Operator's hard requirement + P3 persona

## What it is

The machine interface, equal to the human one: **REST API** (Supabase PostgREST for data +
n8n webhooks for actions) + **CLI** wrapping it + a **ready-made Claude skill** that ships
complete documentation — how to work with the CLI, the database structure, every method,
query patterns — so a fund's agents plug in a token from their system and work with the
service directly.

## Why (rubric & evidence)

- Operator (Jul 18): «мне нужно одно — API… чтобы через CLI подключаться со стороны агента
  и работать. Получать данные, обновлять данные, искать». Skill idea (Jul 19): «делаем
  готовый скилл для CLI, чтобы агенты венчуров подключали токен и работали».
- Multi-Attribute NL reasoning is an MVP-must (brief §Must-demonstrate 3): «technical founder,
  Berlin, AI infra, enterprise traction, no prior VC backing» resolved in ONE pass (FAQ-12).
- Differentiator: of 9 OSS references only sieve-mcp is agent-facing at all (vision.md #4).

## Where the idea comes from

- P3 persona (personas.md): stable contract, evidence in every response, honest confidence
  fields. investor-agent (MIT) — clean MCP/server pattern reference. Our own process-meetings
  skill = the shape of «skill over CLI» the operator loves.

## Implementation view

1. **REST**: PostgREST endpoints over Supabase tables (founders, cards, claims, scores,
   memos) — read/search free of charge; n8n webhook endpoints for actions: POST /apply
   (submit candidate), POST /score/{card}, POST /interview/{token}/message, GET /nl-search.
2. **NL-search**: n8n workflow — query → LLM → structured filter (sector/geo/traits/tech) +
   Postgres FTS over claims → ranked results with evidence snippets. No vector DB (operator).
3. **CLI** (`vcbrain`): thin Python Typer or Node commander over REST; commands: `submit`,
   `list --ranked`, `card <id>`, `score <id>`, `memo <id>`, `search "<nl query>"`, `watch`;
   `--json` everywhere; token via env `VCBRAIN_TOKEN`.
4. **Claude skill** (`skills/vcbrain-cli/SKILL.md` in repo): frontmatter + full reference —
   DB structure, method catalog, query patterns, evidence-field semantics, example flows
   («find and memo a founder», «monitor watchlist»). This file IS a submission artifact:
   judges see agent-first access documented.
5. OpenAPI: PostgREST serves a schema; n8n endpoints documented by hand in the skill +
   a short api.md.

## Boundaries & stubs

MCP server — post-MVP (skill covers the agent story cheaper). Auth = single service token
(no per-fund keys). Rate limiting — none (demo).

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED) — here the plan defines the API surface contract FIRST (endpoints, tokens, error shapes), then build. Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** NL-search agent (query → structured filter + FTS).
- **n8n (MANDATORY, two n8n agents):** action webhooks (`/apply`, `/score`, `/nl-search`).
- **Data model:** @database-engineer — PostgREST exposure (views, service tokens, what's public vs internal); reconcile with 01.
- **Build:** @backend-developer — CLI (`vcbrain`, --json everywhere) + thin custom endpoints; the Claude skill is written with the global `skill-creator` conventions.
- **UX/Design:** none (api.md + skill docs only).
- **QA:** @qa-engineer — contract tests per endpoint, evidence fields present in every response, CLI smoke on all commands.

## Open questions

- CLI language: Python (Typer, matches ops) vs Node (single runtime with front) — groom at
  build; leaning Python.
- Does NL-search also cover «ask about one founder» QA? (cheap add if prompts are ready).
