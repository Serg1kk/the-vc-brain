# 12 · Docker & Deploy — Plan (staged, parallel-marked)

Frozen design: `design.md`. Data-backed scope. Executors: @devops (server ops, git),
@database-engineer (data artifact + verification), @qa-engineer (gate).

## Stage map & parallelism

```
S0 (∥ from t0):
  A  @database-engineer — local data dump + restore script + verify queries  (no server dep)
  B  @devops — author vcbrain compose + env + bring stack up + schema + bucket (server infra)
S1 (after B db healthy; ∥):
  B2 @devops — build web (node preset, prod VITE) + 4 Caddy confs + n8n import + up
  A2 @devops runs restore (uses A's dump) + @database-engineer verifies counts/smoke
S2 (after S1):
  @devops — Caddy reload + TLS verify all 4 hosts + end-to-end smoke
S3 (gate):
  @qa-engineer — independent Playwright/HTTPS pass on both faces
S4 (close):
  orchestrator — creds to operator, tracker/README final, commit via @devops
```

## Tasks

### S0-A — Local data dump (@database-engineer) ∥
- Read-only `pg_dump` of the **running local** Supabase Postgres via `docker exec` (find the local
  supabase-db container; do NOT stop it — 06/09/11 are testing against it).
  `pg_dump -U postgres --data-only --disable-triggers --schema=public postgres`.
- Write dump to a fixed path: `<scratchpad>/vcbrain-local-dump.sql`.
- Also write `restore.md`: exact restore command + the verify queries (row counts for `founders`,
  `scores` per axis, `claims`, `thesis_evaluations`, `memos`; `smoke.sql` invocation).
- Report: dump path, size, and the baseline counts it captured. **Do not touch the server.**

### S0-B — vcbrain stack up on server (@devops)
- Create `~/vcbrain/` on the server. Derive a **slim** compose from `infra/supabase/docker-compose.yml`:
  keep only db/kong/rest/storage/meta/studio; **prefix every container `vcbrain-`**; **remove all
  host `ports:`**; put internal services on `vcbrain-net`; attach `vcbrain-kong` to `localai_default`.
  Sever `depends_on` to dropped services (auth/realtime/imgproxy/functions/supavisor/analytics/vector).
- Server `supabase.env` = copy of local `infra/supabase/.env` values (chmod 600, gitignored path).
  Adjust internal hostnames (`POSTGRES_HOST=vcbrain-db`, Kong upstreams → `vcbrain-*`, no pooler).
- `docker compose -p vcbrain up -d` the DB+gateway set. Confirm `vcbrain-db` healthy.
- Apply schema **directly to vcbrain-db** (`db/apply.sh` with
  `postgresql://postgres:<pw>@localhost:<mapped? no port>` → run from inside the network, e.g.
  `docker exec vcbrain-db` psql, or a one-shot psql container on `vcbrain-net`). Then create the
  private `decks` bucket via REST + SERVICE_ROLE_KEY.
- **Acceptance:** `vcbrain-db` healthy; `smoke.sql` green on the empty schema; `GET /rest/v1/` via
  kong (internal) returns OpenAPI; `decks` bucket exists.

### S1-B2 — web + caddy + n8n (@devops) ∥ with A2
- **web:** build `web/` with nitro **node-server** preset, baking prod `VITE_*` (design §5). Package
  as `vcbrain-web` (node:20-alpine, `:3000`), attach to `localai_default`. Confirm `curl` to the
  container returns the SPA shell.
- **caddy:** write the 4 `site-*.conf` files (design §4) into `~/n8n-install/caddy-addon/`.
- **n8n:** deploy `vcbrain-n8n` (vol `vcbrain-n8n-data`, `localai_default`), env from `n8n.env`
  pointed at the **remote** DB (`SUPABASE_URL=http://vcbrain-kong:8000`, remote SERVICE_ROLE_KEY),
  HTTPS/host/CORS per design §5. Create owner account (operator login). **Import** the workflow JSONs
  from `n8n/workflows/` (present, not necessarily active — data-backed scope; do not attempt to make
  every pipeline run live). Report the n8n login.

### S1-A2 — data restore + verify (@devops runs, @database-engineer verifies)
- @devops: scp `vcbrain-local-dump.sql` up, `psql` it into `vcbrain-db`.
- @database-engineer: run the verify queries + `smoke.sql` against the remote DB (through @devops if
  no direct access) and confirm counts match the baseline from S0-A. Flag any FK/sequence gaps.

### S2 — ingress smoke (@devops)
- Reload Caddy; verify TLS + 200 on all 4 hosts (`curl -I https://…`). Confirm certs issued.
- End-to-end: `dashboard.prodsignal.me` loads and its investor-api calls to `vc-api` succeed
  (data renders); `submit.prodsignal.me` intake UI loads; `vc-n8n` login page reachable; Studio
  login reachable at `vc-api`.

### S3 — QA gate (@qa-engineer)
- Independent adversarial pass (NOT reusing dev smoke): Playwright over **HTTPS** on both faces —
  dashboard renders real imported rows (a known founder appears with scores), no console/CORS
  errors, network calls to `vc-api`/`vc-n8n` return 2xx; submit form renders all states. Deliver
  `qa-report-12.md`. Finding → fix (@devops) → independent re-check until GATE PASSED.

### S4 — close (orchestrator + @devops)
- Hand operator: 4 URLs + Studio login + n8n login + psql string (chat + gitignored scratchpad file).
- Commit feature 12 artifacts + deploy compose/example-env via @devops (remote `Serg1kk/the-vc-brain`
  only; real `.env` never committed; per-path staging, pull --rebase first).
- Note the **end-of-hackathon re-sync** follow-up (final data dump after 06/09/11 land).

## Risks
- Studio without analytics/vector may nag/half-start → timebox; fallback = expose API + give psql
  creds, drop Studio.
- SSR node preset build mismatch (cloudflare default) → set nitro preset explicitly; verify `.output/server`.
- CORS preflight on `vc-api` → Caddy header fallback.
- Box under load (LA~6, 6.2Gi free) → slim set only; if OOM pressure, the operator has offered to
  name services we may stop (n8n/Supabase/LangFuse off-limits).
