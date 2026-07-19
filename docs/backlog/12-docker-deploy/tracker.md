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

## STRATEGY SHIFT (operator, ~14:xx) — ANONYMIZE instead of reduce-to-synthetic

Operator's better idea: instead of wiping down to feature-11's sparse synthetic set, **anonymize the
whole rich corpus** — de-identify all real people (reuse the already-computed scores/claims, no
re-run) so the dashboard stays rich AND safe. This SUPERSEDES the SWAP-to-synthetic-only plan
(SWAP-1/SWAP-2 no longer needed; synth-extract stood down). FIX-2 password: handled by feature 09
(dotenv), Caddy basic-auth dropped.

Also: live intake submit now WORKS (FIX-3, @devops) — activated f08 chain, remapped 6 workflows'
stale sub-workflow ids, verified e2e (200 + scoring), purged its test row back to baseline.

New deliverables:
- **Anonymize remote `vcbrain-db`**: consistent real→fake mapping across ALL text/jsonb fields +
  revoke anon on base tables (expose only api_* views) + zero-real-identifier verification.
- **Shippable mock data**: export the anonymized data → committed `db/fixtures/demo-seed.sql` +
  `db/load-demo.sh` loader (anyone can seed local/VPS).
- **`DEPLOYMENT.md`** (repo root) + README pointer: full local + VPS deploy, public-repo-safe.

| ID | Task | Executor | Depends | Status | Result / notes |
|----|------|----------|---------|--------|----------------|
| FIX-3 | live intake submit (activate + remap + CORS + e2e) | @devops | — | ✅ done | 200 e2e, scoring ran, test row purged to baseline |
| ANON-1 | anonymize remote DB (all vectors) + revoke anon→views + verify | @database-engineer (anonymizer) | — | 🔄 running | ethics-critical; I re-verify via public API after |
| SEED-1 | export anonymized → db/fixtures/demo-seed.sql + db/load-demo.sh | anonymizer | ANON-1 | 🔄 queued | public-safe mock data + loader |
| DOC-1 | DEPLOYMENT.md (local + VPS) + README pointer | @devops | — | 🔄 running | references demo-seed + load-demo |
| SWAP-1/2 | reduce-to-synthetic-only | — | — | ❌ superseded | replaced by ANON-1 |
| DOC-1 | DEPLOYMENT.md + README/README.ru pointer | @devops | — | ✅ done | 694 lines, both paths, secret-scan clean (verified by orchestrator); demo-seed subsection pending SEED-1 |
| REDEPLOY-1 | (see final row below) | | | | superseded by the ✅ done row at the bottom of this table |
| DEDUP-1 | collapse duplicate applications in demo data | anonymizer | ANON-1 | ✅ operator-approved, queued | both shapes: same-company_id apps AND same-name company merge w/ FK repoint; synthetic rows untouched; runs after anon-verify, before seed export |
| REDEPLOY-1 | rebuild+redeploy latest web (09 password gate) | @devops | — | ✅ done | gate creds verified in live bundle (investor/maschmeyer); all hosts green; npm install workaround for live-edited tree |
| QA-1 | independent QA gate | @qa-engineer | — | ✅ infra PASSED / 🔴 public-release BLOCKED (F1 data, F2 password) | full Playwright walkthrough clean; invariants confirmed live. F2 closed by REDEPLOY (password live). F1 closes on ANON commit+verify. **Final re-verify: OPERATOR himself (ruling ~15:0x) — no further QA agent pass.** |

## synth-extract findings (stood down, but delivered valuable intel)

- **Feature 11 generation is only PARTIAL** (measured on the 10 `11f0%` curated apps): market/idea_vs_market 10/10, trust 9/10, thesis_fit 4/10, founder-axis 2/10, thesis_evals 5/10, memos 1/10, interviews 0/10, founder_score 5/14. → confirms **anonymization > synthetic-only reduction** (synthetic set is too thin for a full demo).
- **Backup path exists** if anonymization ever fails: `db/synthetic-extract/{extract,load}.sh` + `synthetic-swap.md` — validated synthetic-only swap, zero leakage (tested on a throwaway PG container).
- **Load gotchas (forwarded to anonymizer for SEED-1):** `theses.id` is a random UUID → `apply.sh` regenerates it → FK dangling on fresh load; solved in `synthetic-swap.md` §4 (ship theses row with its id + promote active default). smoke.sql A1e assertion hardcodes a real founder id — harmless for anonymization (ids/metrics preserved), fatal for synthetic-only.

## 06 CLOSED → remote sync (operator, ~14:4x)

06 QA PASSED; `f06-generate-memo.json` exported (no executeWorkflow nodes → no remap needed);
local memos=16 (post-dump → NOT on remote). Dispatched to @devops (REDEPLOY-2): rebuild web from
current tree + import f06 + activate the frontend-called webhooks (`f06-generate-memo`,
`f09-suggest-followup`, `f10-nl-search`, `f11-purge`) with registration-only verification (no
DB-writing test executions while anonymizer owns the DB). f11-purge = unauthenticated deletion
webhook — accepted for demo, recorded in creds/known-gaps.

**Memo data note:** remote memos=0, but once f06 is active the demo can GENERATE memos live on
remote data — cleaner demo beat than migrating the 16 local test memos. If operator wants the
local memos too, that folds into a FINAL-SYNC (fresh dump → restore → re-run deterministic
anonymize+dedup scripts → re-export seed) — scripts are being built re-runnable for exactly this.

## URGENT SEED PATH (operator, ~15:15 — «2 минуты») — done by orchestrator inline

Operator ordered: export anonymized remote data, replace the local DB with it, ship seed+loader to
GitHub — without waiting for the anonymizer. Executed inline (time-forced deviation from
subagent-only): remote pg_dump → **full 717-id mapping sweep over the file** → 10 survivors
hand-scrubbed (levelsio/levels.io/Pieter Levels/photoai/nomadlist/clipmaker/kim0/northwind/rudo/
IP14 — all → mapped fakes) → file verified ZERO real identifiers → `db/fixtures/demo-seed.sql`
(21.7MB) + `db/load-demo.sh` created → **local DB truncated + reloaded with the anonymized set**
(operator order; verified fake names local) → @devops pushed as **`e2b6886`** (secret-scan clean;
`.ru.md` correctly excluded per repo policy). The 10 survivors were scrubbed in the FILE — the
REMOTE still had them at dump time; anonymizer given the exact target list to finish the remote
sweep, then dedup. Seed may be re-exported after dedup if data changes materially.

## Event log
- 2026-07-19 ~13:05 · Recon complete (server + local + web target). design.md + plan.md written.
- 2026-07-19 ~13:xx · Dispatching S0-A (@database-engineer) ∥ S0-B (@devops).
