# 12 · Docker & Deploy (local-first, VPS at the end)

Status: backlog · Depends on: all

## What it is

The runtime: **docker-compose** with n8n + Supabase (self-hosted) + web (SPA static) —
developed and tested LOCALLY on the operator's test server; at the very end, deployed to the
operator's VPS and a public URL handed out for judges to try. Keys (OpenAI, Tavily,
ElevenLabs) wired via .env.

## Why (rubric & evidence)

- Operator (Jul 19): «делаем все в докере, в docker-compose, локально, тестируем… потом на
  серверок выльем, дам сайтик потестировать».
- Submission requires a working prototype link + GitHub repo + zip; a live URL beats a video-only.

## Where the idea comes from

- Operator's own production pattern: self-hosted n8n+Supabase via docker-compose on VPS
  (existing infrastructure experience — this is why the n8n+Supabase stack override wins on
  time-to-demo for THIS operator).

## Implementation view

1. `docker-compose.yml`: n8n (+ its Postgres or shared), Supabase self-hosted set, `web`
   (nginx serving SPA build). Volumes: supabase db, n8n data, voice storage.
2. `.env.example` (no real keys — repo hygiene rule); real `.env` local + on VPS.
3. n8n workflows exported as JSON into `n8n/workflows/` in the repo (versioned, judges can
   inspect — «visual and understandable» is part of the tech story).
4. Supabase schema as `supabase/schema.sql` applied on first boot.
5. End-of-hackathon: compose up on VPS, Caddy/nginx TLS, public URL; smoke test the demo
   script end-to-end; zip the repo for submission.

## Boundaries & stubs

No CI/CD, no backups, no monitoring (hackathon). One environment knob: DEMO_MODE (pre-warmed
data, faster crons).

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **@devops is the CENTER of this feature:** compose, volumes, .env wiring, VPS deploy, TLS, smoke of the demo script end-to-end.
- **Data model:** @database-engineer — `supabase/schema.sql` first-boot apply.
- **Build:** @backend-developer — compose wiring of n8n workflows export (`n8n/workflows/` versioned in repo).
- **n8n:** export/import discipline via the global `n8n` skill (instances management); workflows themselves come from features 02-11.
- **UX/Design:** none.
- **QA:** @qa-engineer — cold-boot test (fresh clone → compose up → demo works), DEMO_MODE pre-warm check.

## Open questions

- Reuse operator's existing local n8n instance for building workflows, then export → compose?
  (Faster than boot-from-zero; groom with operator at build start.)
- VPS target: which of the operator's servers — operator decides at deploy time.
