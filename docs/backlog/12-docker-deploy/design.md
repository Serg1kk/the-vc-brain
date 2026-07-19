# 12 · Docker & Deploy — Design (remote test-server deploy)

Status: spec (compressed cycle — hard demo clock, operator green-lit momentum)
Owner (build): @devops (center of this feature) + @database-engineer (data migration)
Decided: 2026-07-19 · Operator ruling: **data-backed live URL** (not full live pipeline)

## 1. Goal

Stand up a **public, TLS-terminated, data-backed** instance of The VC Brain on the operator's
test VPS so judges can open a real URL. Two faces:

- **`https://submit.prodsignal.me`** → founder intake (SPA `/apply*`).
- **`https://dashboard.prodsignal.me`** → investor dashboard (SPA `/app/*`), password-gated
  (app-level password added by feature 09; Caddy basic-auth optional belt-and-braces, OFF by default).

The dashboard renders the **rich live dataset imported from the local hackathon DB** (164 founders,
scores, claims, thesis evals, and memos once 06 lands). Heavy n8n scoring pipelines are **not run
live on the server** this pass — they are shown from the local stand in the Tech Video. n8n is still
deployed and login-exposed so the operator can inspect/trigger workflows.

## 2. Hard constraints (the server is shared and under load)

Measured 2026-07-19: RAM 23Gi total, **~6.2Gi available**, swap 8.9/15Gi used, load avg ~6,
disk 82G free. The box runs the operator's production-critical services.

**MUST NOT touch** (verified running): the server's own `n8n` + `n8n-worker-*` + `n8n-runner-*`
(7 containers), the server's own `supabase-*` + bare `postgres`, `langfuse-web`/`langfuse-worker`,
askaizer-critical (`prodfeatai-rag-rag-api-1`, `qdrant`, `weaviate`, `lightrag`, `clickhouse`,
`minio`, `redis`), `s-pro-crm-*`, and the whole monitoring set. Also **must not touch local dev
Docker** — features 06/09/11 are mid-build and running tests against it.

Consequences that shape the whole design:
- **Container-name collision:** the upstream Supabase compose names containers `supabase-db`,
  `supabase-kong`, `supabase-rest`, … — all already taken on this host. **Every container we deploy
  is prefixed `vcbrain-`.** (Our n8n is already `vcbrain-n8n`.)
- **Host-port collision:** `supabase-kong` already binds `0.0.0.0:8000`; Caddy owns `80/443`.
  **We publish ZERO host ports.** Ingress containers join Caddy's network `localai_default` and are
  reached by container name; internal containers stay on our private `vcbrain-net`.
- **Subdomain collision:** the operator already runs `supabase.prodsignal.me` and
  `n8n.prodsignal.me` (his stack). Ours use distinct names: **`vc-api`** and **`vc-n8n`**.

## 3. Target topology

```
                          Caddy (localai_default, :443, auto Let's Encrypt)
   submit.prodsignal.me ─────────────┐
   dashboard.prodsignal.me ──────────┼──▶ vcbrain-web:3000        (TanStack Start / nitro node server, SSR)
   vc-api.prodsignal.me ─────────────┼──▶ vcbrain-kong:8000       (Supabase gateway: /rest/v1, /storage/v1, Studio at /)
   vc-n8n.prodsignal.me ─────────────┘──▶ vcbrain-n8n:5678        (n8n UI + webhooks)

   private vcbrain-net (no host ports):
     vcbrain-db (supabase/postgres:17.6.1.136, vol vcbrain-db-data)
     vcbrain-rest (postgrest v14.12) · vcbrain-storage (storage-api v1.60.4, vol vcbrain-storage-data)
     vcbrain-meta (postgres-meta) · vcbrain-studio (studio)   ← for operator login to Supabase
     vcbrain-kong → routes to rest/storage/studio · vcbrain-n8n → SUPABASE_URL=http://vcbrain-kong:8000
```

### Services KEPT (slim set, ~8 containers)
`vcbrain-db`, `vcbrain-kong`, `vcbrain-rest`, `vcbrain-storage`, `vcbrain-meta`, `vcbrain-studio`,
`vcbrain-n8n`, `vcbrain-web`.

### Services DROPPED (not needed for data-backed demo, saves RAM)
`auth` (gotrue — app uses anon-key only; PostgREST & storage validate JWT via `JWT_SECRET`, no
runtime call to gotrue), `realtime`, `imgproxy` (storage image-transform disabled), `functions`
(edge), `supavisor`/pooler (we connect migrations **directly to `vcbrain-db:5432`** — no
tenant-qualified username needed), `analytics`/logflare, `vector`.
→ @devops must **sever `depends_on` chains** to these in the derived compose (esp. studio→analytics,
storage→imgproxy, kong→auth) so the kept services start without the dropped ones.

## 4. Networking & ingress

- Two networks per ingress container: `vcbrain-net` (internal) + external `localai_default`.
- Four Caddy site files in `~/n8n-install/caddy-addon/` (do **not** edit the main Caddyfile /
  compose — the n8n-install update overwrites them; addon files survive):
  - `site-vc-submit.conf`     → `submit.prodsignal.me { import service_tls; reverse_proxy vcbrain-web:3000 }`
  - `site-vc-dashboard.conf`  → `dashboard.prodsignal.me { import service_tls; reverse_proxy vcbrain-web:3000 }`
  - `site-vc-api.conf`        → `vc-api.prodsignal.me { import service_tls; reverse_proxy vcbrain-kong:8000 }`
  - `site-vc-n8n.conf`        → `vc-n8n.prodsignal.me { import service_tls; reverse_proxy vcbrain-n8n:5678 }`
- Reload Caddy after adding (no restart of the whole stack).

## 5. Web build (it is SSR, not static)

`web/` is **TanStack Start (nitro, default cloudflare target)** — NOT a static SPA. Build with the
**node-server** nitro preset and run the node output in a `node:20-alpine` container
(`node .output/server/index.mjs`, listen `:3000`). `VITE_*` are injected at **build time**, so the
build must bake the **production** URLs:

- `VITE_SUPABASE_REST_URL=https://vc-api.prodsignal.me/rest/v1`  *(confirm exact shape vs `web/.env.example` / `investor-api.ts`)*
- `VITE_SUPABASE_ANON_KEY=<ANON_KEY from infra/supabase/.env — reused, tokens stay valid>`
- `VITE_N8N_BASE_URL=https://vc-n8n.prodsignal.me`

### CORS (browser is cross-origin to the API)
Browser on `submit`/`dashboard` origins calls `vc-api` (PostgREST) and `vc-n8n` (webhooks) →
cross-origin.
- **n8n:** `N8N_CORS_ALLOW_ORIGIN` must include `https://submit.prodsignal.me,https://dashboard.prodsignal.me`
  (+ keep localhost origins for parity). `N8N_PROTOCOL=https`, `WEBHOOK_URL=https://vc-n8n.prodsignal.me/`,
  `N8N_HOST=vc-n8n.prodsignal.me`, `N8N_SECURE_COOKIE=true`.
- **PostgREST via Kong:** PostgREST v14 handles CORS by echoing Origin + answering OPTIONS. If a
  preflight fails in QA, add CORS headers at the Caddy `vc-api` site as fallback.

## 6. Secrets & env files (all gitignored; operator gets login creds)

- Remote reuses **the same** `infra/supabase/.env` values (JWT_SECRET/ANON_KEY/SERVICE_ROLE_KEY/
  POSTGRES_PASSWORD/DASHBOARD_USERNAME/DASHBOARD_PASSWORD) so imported-data tokens & Studio login work.
- Env files that live on the server, **all chmod 600, all gitignored** (repo `.gitignore` already
  covers `.env` / `.env.*` / `*credentials*` — verify the deploy paths match):
  - `vcbrain/supabase.env`  (DB + Supabase stack)
  - `vcbrain/n8n.env`       (n8n + OpenAI/Tavily/Supabase-service, pointed at remote DB)
  - `vcbrain/web.env`       (VITE_* build args — build-time only)
- **Commit only `*.env.example` with blank values.** Never commit real keys or key prefixes.
- Deliverable to operator (NOT committed — chat + a local gitignored `deploy-credentials.md` in
  scratchpad): the four public URLs, Supabase-Studio login (`vc-api` root), n8n login
  (`vc-n8n`), and the DB connection string for direct psql.

## 7. Data migration (existing data, non-disruptive)

The local DB holds the rich hackathon dataset that must appear on the server. Local dev must not be
stopped, and the box's own Supabase must not be touched.

1. **Dump (read-only, no container stop):** `docker exec <local supabase-db> pg_dump -U postgres
   --data-only --disable-triggers --schema=public postgres > vcbrain-local-dump.sql`
   (dumps `public` data only; schema comes from `db/apply.sh`; `--disable-triggers` avoids FK-order
   failures). @database-engineer produces this at a fixed scratchpad path.
2. **Schema on remote:** `db/apply.sh` against `vcbrain-db` directly (`postgresql://postgres:<pw>@
   vcbrain-db:5432/postgres` — direct, no pooler/tenant), idempotent, ends with a schema reload.
3. **Bucket:** create the private `decks` Storage bucket via REST + SERVICE_ROLE_KEY (cold-start
   step — `db/apply.sh` does NOT create it).
4. **Restore:** psql the dump into `vcbrain-db`.
5. **Verify:** row counts match local ballpark (founders ≈164, scores populated across axes,
   `memos` = whatever local has at import time) + `db/tests/smoke.sql` green on remote.

**Re-sync at the end:** 06/09/11 are still producing data (memos, badges). Plan a **final re-dump +
restore** once they land so the demo shows the final dataset. Tracked as a follow-up, not a blocker.

## 8. Security posture (hackathon-honest, documented not hidden)

- No RLS in this project → the anon key has full write. Exposing PostgREST publicly means the API is
  writable by anyone who reads the anon key from the bundle. **Accepted for a hackathon demo**; the
  dashboard password gates the UI, not the API. Documented, not silently shipped. (Belt-and-braces
  option if the operator wants it: Caddy basic-auth on `vc-api`, but that would require the SPA to
  send those creds — out of scope this pass.)
- Studio is public behind Kong basic-auth (DASHBOARD_USERNAME/PASSWORD). Strong password required.

## 9. Boundaries / non-goals (unchanged from feature README)

No CI/CD, no backups, no monitoring. One env knob (`DEMO_MODE`) is out of scope this pass. Downstream
VC stages remain out of scope. Full live pipeline is a **separate, optional follow-up** layered on
this foundation.

## 10. Compressed-process note

Given the hard demo clock and the operator's explicit "start on remote now", this cycle **skips the
separate spec-reviewer and plan-reviewer subagent loops**. The design was built from full server +
local recon (facts, not guesses) and frozen here. Build proceeds via subagents (@devops center,
@database-engineer for data), QA gate after. This deviation is deliberate and recorded.
