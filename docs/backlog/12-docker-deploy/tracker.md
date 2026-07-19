# 12 · Docker & Deploy — Execution Tracker

Single writer = orchestrator. Design `design.md`, plan `plan.md`. Scope: **data-backed** remote deploy.
Server: `prodsignal.me` (5.231.45.174), Caddy net `localai_default`, wildcard DNS ✅.

## Task board

| ID | Task | Executor | Depends | Status | Result / notes |
|----|------|----------|---------|--------|----------------|
| S0-A | Local data dump + restore script + verify queries | @database-engineer | — | ✅ done | dump 21MB/25 tbl/8708 lines; baseline: founders 167, companies 250, applications 359, claims 1276, evidence 1034, thesis_eval 243, memos 0, cards 224; scores by axis founder 2/founder_score 34/idea_vs_market 18/market 16/thesis_fit 30/trust 32. restore.md written. Container untouched. ⚠️ data-only dump re-inserts lookup rows apply.sh seeds → PK collision; restore.md handles. |
| S0-B | vcbrain slim stack up + schema + decks bucket | @devops | — | ⏳ dispatched | prefix `vcbrain-`, no host ports, `localai_default` |
| S0-B | vcbrain slim stack up + schema + decks bucket | @devops | — | ✅ done | 8 containers `vcbrain-*` healthy, zero host ports, ~1.3GB RSS, 8.5Gi free. smoke green. |
| S1-B2 | web (node SSR) + 4 Caddy confs + n8n import | @devops | S0-B | ✅ done | 4 hosts live HTTPS. n8n owner set + 20 workflows imported (inactive=data-backed scope). storage healthcheck bug fixed (IPv4 alias). |
| S1-A2 | restore dump + verify counts | @devops + @database-engineer | S0-A, S0-B | ✅ done | EXACT baseline match (founders 167/claims 1276/scores 132/…); restored as supabase_admin (postgres not superuser); truncate+clean reload after a seed-vs-dump thesis UNIQUE conflict. Independently re-verified by db-dump. |
| S2 | Caddy reload + TLS verify + e2e smoke | @devops | S1-* | ✅ done | dashboard renders real data (Mila Sørensen fs 82.80); vc-api CORS from dashboard origin OK; Studio 401-gated; n8n login up. |
| FIX-1 | dashboard root → /app redirect | @devops | S2 | ✅ done | `@root path /` → 302 /app; deep links unaffected; submit plain. |
| FIX-2 | rebuild web for new favicon.svg (+__root/sidebar) | @devops | S2 | ✅ done | rsync --delete rebuild; favicon.svg 200 image/svg+xml, favicon.ico 404 — verified by orchestrator curl. 09 tree buildable. |
| S3 | QA gate (Playwright over HTTPS, both faces) | @qa-engineer | FIX-2 | 🔄 dispatched | independent adversarial pass on final state |
| S4 | creds to operator + commit + re-sync note | orchestrator + @devops | S3 | ⛔ pending | commit HELD for operator ruling; creds file ready in scratchpad |

## Frozen decisions (do not re-litigate)
- Data-backed scope (operator ruling). Full live pipeline = optional later.
- Containers `vcbrain-*`; zero host ports; ingress on `localai_default`.
- Hosts: submit / dashboard → vcbrain-web · vc-api → vcbrain-kong · vc-n8n → vcbrain-n8n.
- Slim Supabase: db/kong/rest/storage/meta/studio. Drop auth/realtime/imgproxy/functions/pooler/analytics/vector.
- Reuse local `infra/supabase/.env` values so imported tokens & Studio login stay valid.
- All server `.env` chmod 600 + gitignored; only `*.env.example` committed.

## ⚠️ DATA POLICY CHANGE (operator, 2026-07-19 ~14:xx) — synthetic-only demo DB

The first deploy loaded the FULL local DB = ~93% REAL people (232/250 companies real, sourced from
public GitHub/HN/web by the hackathon pipelines). **Operator ruling: the public demo DB must hold
ONLY the feature-11 synthetic demo dataset** (ethics: no AI-generated claims about real people on a
public URL). Chosen path: **wait for feature 11 to finish generating the curated synthetic dataset
(scores/claims/memos on the synthetic founders), then ONE clean swap** — wipe remote person-data,
load synthetic-only.

- 🔴 **HARD GATE: do NOT make the URL public / put it in the submission until the synthetic swap is
  done.** Real people on a public URL is the project's ethics red line.
- Current synthetic set (local): 14 synthetic founders, 18 synthetic companies, 10 `11f0…` demo apps.
  Generation INCOMPLETE — only ~11 partial `founder_score`, no market/trust/thesis/memo on synthetic
  founders yet; `memos`=0 project-wide (06 in-build). That's why we wait for 11.
- Swap tooling being pre-built read-only by @database-engineer (`synthetic-swap.md` + extraction
  script), fires when 11 signals done.
- @devops on standby for the wipe+load step.

## Task board — swap tasks (added)

| ID | Task | Executor | Depends | Status | Result / notes |
|----|------|----------|---------|--------|----------------|
| SWAP-0 | Build+validate synthetic-only extraction procedure | @database-engineer | — | 🔄 dispatched | read-only prep; `synthetic-swap.md` |
| SWAP-1 | When 11 done: extract synthetic from local | @database-engineer | 11 complete, SWAP-0 | ⛔ waiting | flag-based, captures generated scores/memos |
| SWAP-2 | Wipe remote person-data + load synthetic + verify | @devops + @database-engineer | SWAP-1 | ⛔ waiting | keep config/registry (apply.sh); truncate person-data |

## SCOPE CHANGE (operator, ~14:xx) — live intake submit must work

Operator tested submit.prodsignal.me: fills form, clicks Submit, nothing; n8n shows no execution.
Cause: workflows imported but INACTIVE (data-backed scope) → production webhook unregistered → 404.
Operator now wants the live intake submit working. Diagnosed: path matches, f08 uses `$env.*` (no
n8n credentials). Two fixes dispatched to @devops: (1) activate `f08-intake-submit`; (2) **remap the
2 `executeWorkflow` sub-workflow `workflowId`s** — stale local ids after import (the non-obvious
breakage) — plus verify CORS for `https://submit.prodsignal.me` and $env→remote-DB, then e2e test.
Data-loading confirmed as feature-12's own responsibility (operator).

| ID | Task | Executor | Depends | Status | Result / notes |
|----|------|----------|---------|--------|----------------|
| FIX-3 | activate f08-intake-submit + remap sub-workflow ids + CORS + e2e | @devops | S1 | 🔄 dispatched | make live submit work |

## Event log
- 2026-07-19 ~13:05 · Recon complete (server + local + web target). design.md + plan.md written.
- 2026-07-19 ~13:xx · Dispatching S0-A (@database-engineer) ∥ S0-B (@devops).
