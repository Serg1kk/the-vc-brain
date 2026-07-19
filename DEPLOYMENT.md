# Deployment Guide

This document explains how to run The VC Brain **on your own machine** (local development) or
**on your own server** (a VPS behind a reverse proxy), starting from nothing but this repository.
It assumes no access to the original build environment — every command, port and env var below is
either already public in this repo or a placeholder you fill in yourself.

**Docker is required.** The entire backend — database, REST API, storage, workflow engine — is
containerized. There is no non-Docker path for the backend; the only thing that can run outside
Docker is the `web/` frontend during local development (and even that ships a Dockerfile for
production).

---

## 0. Architecture overview

```
                                   ┌─────────────────────────┐
                                   │        Browser          │
                                   └────────────┬─────────────┘
                                                 │
                          ┌──────────────────────┴──────────────────────┐
                          │                                              │
                          ▼                                              ▼
              ┌────────────────────┐                         ┌────────────────────┐
              │   web (SSR app)     │                         │   n8n editor UI     │
              │  TanStack Start /   │                         │  (workflow builder, │
              │  nitro node server  │                         │   operator-only)    │
              └──────────┬──────────┘                         └──────────┬──────────┘
                          │                                               │
             reads (GET) │                              webhooks (POST)  │
                          ▼                                               ▼
              ┌────────────────────────────────────────────────────────────────┐
              │                     Kong API gateway (Supabase)                 │
              │   /rest/v1  → PostgREST     /storage/v1 → Storage API            │
              │   /         → Studio (admin UI, basic-auth gated)                │
              └───────────────────────────────┬────────────────────────────────┘
                                                │
                                                ▼
                                     ┌────────────────────┐
                                     │   Postgres (db)     │
                                     └────────────────────┘
                                                ▲
                                                │ reads/writes via $env.SUPABASE_* + REST
                                     ┌────────────────────┐
                                     │        n8n           │  ── calls ──▶  OpenAI, Tavily
                                     │  (workflow engine,   │
                                     │   all backend logic) │
                                     └────────────────────┘
```

**Why it's split this way:** the frontend (`web/`) never talks to OpenAI/Tavily or writes
directly to the database for anything non-trivial. All backend *logic* (scoring, memo
generation, thesis evaluation, contradiction checks, the founder intake pipeline) lives as
**n8n workflows** (`n8n/workflows/*.json`) — visual, inspectable, and editable without a
redeploy. The frontend does two things only: **reads** go straight to PostgREST
(`VITE_SUPABASE_REST_URL`), **writes and anything that calls a model** go through n8n webhooks
(`VITE_N8N_BASE_URL`).

### Services, default local ports, volumes

| Service | Image | Local port | Volume |
|---|---|---|---|
| Postgres (`db`) | `supabase/postgres` | `54322` (via Supavisor pooler; internal `5432`) | `infra/supabase/volumes/db/data` (bind mount) |
| Kong (API gateway) | `kong` | `8000` (HTTP), `8443` (HTTPS) | — |
| PostgREST (`rest`) | `postgrest/postgrest` | behind Kong only | — |
| Storage API | `supabase/storage-api` | behind Kong only | named volume |
| Studio (admin UI) | `supabase/studio` | behind Kong at `/` | — |
| postgres-meta | `supabase/postgres-meta` | behind Kong at `/pg/` | — |
| n8n | `n8nio/n8n` | `5678` | named volume (`.n8n` config, workflows, credentials) |
| web (dev) | — (Vite) | `5173` | — |

The full self-hosted Supabase stack also ships `auth` (GoTrue), `realtime`, `imgproxy`,
`functions` (edge functions), `supavisor` (the pooler) and `analytics`/`vector` (Logflare).
**This project uses none of them** — there's no end-user auth (the API is anon-key gated, not
per-user), no image transforms, no edge functions, and (in a single-tenant production deploy)
no need for a connection pooler. Section 2 below shows how to drop them from a production
compose file to save RAM; for local development, leave the vendored `infra/supabase/docker-
compose.yml` as-is — the unused services barely register a laptop's resources.

### Prerequisites

- Docker + Docker Compose v2 (`docker compose version` should print `v2.x` or newer).
- `psql` (the Postgres client) on your host — used to apply the schema and run smoke tests.
  On macOS: `brew install postgresql`. On Debian/Ubuntu: `apt install postgresql-client`.
- Node.js 20+ and `npm` if you want to run `web/` outside Docker for local development.
- **API keys** (both required — the backend workflows call these directly):
  - **OpenAI** — used for founder scoring, market/idea-vs-market research synthesis, memo
    generation, the interview/gap-question agent, and NL search.
  - **Tavily** — used for web research (founder web presence, market sizing, competitor
    discovery). Free tier is enough to exercise the pipeline.
- A domain name and DNS access, **only** if you're doing the VPS deployment (section 2).

---

## 1. Local deployment (Docker Compose)

All commands below run from the repository root unless noted.

### 1.1 Bring up Supabase

```bash
cd infra/supabase
cp .env.example .env   # if .env.example isn't present, see infra/supabase/README.md
sh utils/generate-keys.sh --update-env   # generates JWT_SECRET/ANON_KEY/SERVICE_ROLE_KEY/etc into .env
```

Edit `infra/supabase/.env` and set at least:
- `POSTGRES_PASSWORD` — a strong password (the generator above does this for you).
- `POOLER_TENANT_ID` — any identifier you choose, e.g. `local-dev` (see the pooler gotcha below).
- `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` — Studio's basic-auth login.

```bash
docker compose up -d
```

⚠️ **The Supavisor pooler gotcha.** Compose publishes Postgres on host port **`54322`**, not
`5432` — `5432` is only the *internal* Docker network port for the `db` service itself. Port
`54322` is fronted by **Supavisor**, a connection pooler, which requires a **tenant-qualified
username**: `postgres.<POOLER_TENANT_ID>` (the value you set above), not plain `postgres`. A
bare `postgres` username fails with `FATAL: no tenant identifier provided`. Also watch out for a
native Postgres already listening on `127.0.0.1:5432` on your machine — it can silently shadow
the container for anything that *does* try port 5432 directly.

Verify:

```bash
psql "postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@localhost:54322/postgres" \
  -c "select version();"   # expect a PostgreSQL 17.x banner

curl -s http://localhost:8000/rest/v1/ -H "apikey: <ANON_KEY>"   # expect an OpenAPI JSON document
```

### 1.2 Apply the database schema

```bash
DATABASE_URL="postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@localhost:54322/postgres" \
  ./db/apply.sh
```

`db/apply.sh` runs `db/schema.sql` then `db/seed.sql` and reloads PostgREST's schema cache. Both
are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT DO NOTHING`) —
safe to re-run against a live database. This gets you the schema plus small config/registry rows
(scoring-axis definitions, card types, etc.) — no founders, companies or scores yet. See section
1.4 for how to populate the database with actual demo data.

### 1.3 Create the `decks` Storage bucket

This is a **cold-start step `apply.sh` deliberately does not do** — creating a bucket is an HTTP
call against the Storage API, not SQL, so it doesn't belong in a `.sql` migration. Without it,
any deck upload from the intake flow 404s.

```bash
curl -s -X POST http://localhost:8000/storage/v1/bucket \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"decks","id":"decks","public":false}'
```

### 1.4 Load demo data

The repo ships a ready-to-use, anonymized demo dataset — no real people, safe to load anywhere:

```bash
DATABASE_URL="postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@localhost:54322/postgres" \
  ./db/load-demo.sh
```

`db/load-demo.sh` loads `db/fixtures/demo-seed.sql` — a full anonymized snapshot (~167 founders
with scores, claims and evidence across all three screening axes) — onto whatever database
`DATABASE_URL` points at. Run it **after** `db/apply.sh` (schema must exist first) and **after**
the `decks` bucket is created (section 1.3). It's the fastest way to get a dashboard that
actually has something to show, without running the scoring pipelines yourself or needing real
API calls out to GitHub/HN/Tavily.

Smaller, narrower alternatives in `db/fixtures/` (each documents its own purpose, not applied by
`apply.sh` or `load-demo.sh` — run explicitly if you want a specific narrow scenario instead of
the full demo dataset):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/03-founder-score.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/05-truth-gap.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/07-thesis-engine.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/11-demo-data.sql
```

A third option — migrating your own real dataset instead of using the shipped demo data — is
covered in section 2.6 (written for a VPS target, but the dump/restore procedure there works
identically against a local database).

### 1.5 Run smoke tests

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/smoke.sql
```

The whole suite runs inside one rolled-back transaction — nothing is left behind in the
database. A couple of checks are data-dependent (they expect real rows to already exist) and
only go fully green once you've loaded data — run this after section 1.4, not before.

### 1.6 Bring up n8n

```bash
cd infra/n8n
```

Create `.env` next to `docker-compose.yml` with:

```bash
SUPABASE_URL=http://host.docker.internal:8000/rest/v1
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from infra/supabase/.env>
TAVILY_API_KEY=<your Tavily key>
OPENAI_API_KEY=<your OpenAI key>
```

`host.docker.internal` lets the n8n container (on its own Docker network) reach the Supabase
stack (on a different Docker network) via the host — this is Docker Desktop's built-in hostname;
on a Linux Docker host it needs an `extra_hosts: ["host.docker.internal:host-gateway"]` entry,
already present in `infra/n8n/docker-compose.yml`.

```bash
docker compose up -d
```

Notable env knobs already baked into `infra/n8n/docker-compose.yml` — keep these if you write
your own compose file, they're not optional:

- `N8N_CORS_ALLOW_ORIGIN` — must list the web app's dev-server origin(s) (default
  `http://localhost:5173`), or every browser call from the frontend fails silently in the
  browser console only (curl-based testing won't catch it).
- `N8N_PAYLOAD_SIZE_MAX=192` — the intake contract sends a PDF deck plus up to three extra files
  as base64 in one JSON body; n8n's default 16 MB ceiling is too small.
- `NODE_FUNCTION_ALLOW_BUILTIN=crypto,url` — several Code nodes `require('crypto')` /
  `require('url')`; both are blocked by default in n8n's Code-node sandbox.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` — the workflows read Supabase/OpenAI/Tavily secrets via
  `$env.*` expressions directly in HTTP Request node URLs/bodies, not through n8n's native
  Credential objects. This env var defaults to blocking that; it must be `false` here.

On first visit to `http://localhost:5678`, n8n will prompt you to create an **owner account**
(email + password) — this is a one-time local setup step, not part of the app's own auth.

### 1.7 Import the n8n workflows

Every workflow lives as a plain JSON export in `n8n/workflows/`. Simplest path — the n8n UI:

1. Open `http://localhost:5678`.
2. **Workflows → Import from File**, one at a time, for every `n8n/workflows/*.json`.
3. Leave them **inactive** unless you specifically want a given webhook to run live — see the
   activation-order gotcha in section 2.3, which applies locally too.

Faster path for scripting an import of all of them at once — generate an API key (**Settings →
n8n API → Create an API key**) and:

```bash
for f in n8n/workflows/*.json; do
  curl -s -X POST http://localhost:5678/api/v1/workflows \
    -H "X-N8N-API-KEY: <your n8n API key>" -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json,sys
wf = json.load(open('$f'))
print(json.dumps({k: wf[k] for k in ('name','nodes','connections','settings') if k in wf} | {'settings': wf.get('settings', {})}))
")"
done
```

Each workflow's `n8n/workflows/README-*.md` (where present) documents its exact trigger path,
request/response contract and any manual setup it needs.

### 1.8 Run the web app

```bash
cd web
cp .env.example .env
```

Fill in `web/.env`:

```bash
VITE_N8N_BASE_URL=http://localhost:5678
VITE_SUPABASE_REST_URL=http://localhost:8000/rest/v1
VITE_SUPABASE_ANON_KEY=<ANON_KEY from infra/supabase/.env>
# Optional — demo-grade client-side gate on /app/*, NOT real auth. Unset falls back to a
# built-in default; see src/lib/dashboard-auth.ts.
VITE_DASHBOARD_USER=
VITE_DASHBOARD_PASSWORD=
```

```bash
npm install
npm run dev       # http://localhost:5173
```

`web/` is a **TanStack Start** app (React, server-rendered via nitro) — `npm run dev` is enough
for local development; `npm run build` produces a production build (see section 2.5 for the
production preset you need for a VPS deploy, since the default target is Cloudflare Workers, not
a plain Node server).

### 1.9 Full cold-start reset (wipe everything and start over)

⚠️ **`docker compose down -v` alone does NOT reset the database.** `infra/supabase/docker-
compose.yml`'s `db` service mounts Postgres data via a **bind mount**
(`./volumes/db/data:/var/lib/postgresql/data`), not a named volume — `docker compose down -v`
only removes the compose-managed named volumes (config/cache), not a bind-mounted host
directory. Without an explicit `rm -rf`, "resetting" leaves your old data (and old seed rows)
exactly as they were.

```bash
cd infra/supabase
docker compose down -v
rm -rf volumes/db/data
docker compose up -d --wait
cd ../..

set -a; source infra/supabase/.env; set +a
curl -s -X POST http://localhost:8000/storage/v1/bucket \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"decks","id":"decks","public":false}'

DATABASE_URL="postgresql://postgres.$POOLER_TENANT_ID:$POSTGRES_PASSWORD@localhost:54322/postgres" \
  ./db/apply.sh
DATABASE_URL="postgresql://postgres.$POOLER_TENANT_ID:$POSTGRES_PASSWORD@localhost:54322/postgres" \
  ./db/load-demo.sh
psql "postgresql://postgres.$POOLER_TENANT_ID:$POSTGRES_PASSWORD@localhost:54322/postgres" \
  -v ON_ERROR_STOP=1 -f db/tests/smoke.sql
```

---

## 2. VPS / production deployment (Docker Compose behind a reverse proxy)

This section generalizes a real deployment of this exact repo onto a shared Linux VPS, running
alongside other unrelated services behind one reverse proxy. If your server is dedicated to this
project alone, you can simplify by publishing ports `80`/`443` directly instead of attaching to
an existing proxy network — the container/service topology below is identical either way.

### 2.1 Isolated-stack pattern

If you're sharing a box with other Docker workloads, protect them by convention:

- **Prefix every container name** with something unique to this deployment (e.g. `myapp-db`,
  `myapp-kong`, `myapp-n8n`, ...) — avoids name collisions with anything else on the host.
- **Publish zero host ports.** Only the reverse proxy needs `80`/`443`; every one of this
  project's containers should be reachable **only** by container name over a Docker network, not
  by a published host port.
- Give the stack **two networks**: a private internal network (e.g. `myapp-net`) for
  service-to-service traffic, and the reverse proxy's existing network (e.g. `proxy_default`)
  attached **only** to the containers that need to be reverse-proxied (the web app, Kong, n8n).
- Use **distinct subdomains** per public-facing service — don't try to path-route everything
  through one host.

### 2.2 Slim Supabase compose (drop what you don't use)

Keep only: `db`, `kong`, `rest`, `storage`, `meta`, `studio`. Drop: `auth` (GoTrue — this app
uses the anon/service-role key model, not per-user auth; PostgREST/Storage validate JWTs via
`JWT_SECRET` directly, no runtime call to GoTrue needed), `realtime` (no live subscriptions used),
`imgproxy` (no image transforms — set `ENABLE_IMAGE_TRANSFORMATION: "false"` on `storage`
instead), `functions` (no edge functions), `supavisor`/the pooler (connect **directly** to
`db:5432` in a single-tenant deploy — no tenant-qualified username needed), `analytics`/`vector`
(Logflare — not used). Dropping these five-to-eight containers is the single biggest RAM saving
available; a slim stack (all six kept services) runs comfortably under ~1.5 GB RSS total.

When you trim the compose file, **sever the `depends_on` chains** into the dropped services
(especially `storage` → `imgproxy`, `kong` → `auth`, and any implicit dependency on `auth` in
Studio's env) so the kept services start cleanly without them.

Skeleton (fill in image tags/versions from `infra/supabase/docker-compose.yml`, which is the
full vendored reference to trim from):

```yaml
name: myapp

services:
  myapp-db:
    image: supabase/postgres:<version>
    container_name: myapp-db
    networks: [myapp-net]
    volumes:
      - db-data:/var/lib/postgresql/data:Z
      # ...init scripts from infra/supabase/volumes/db/*.sql, unchanged
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      # ...

  myapp-kong:
    image: kong:<version>
    container_name: myapp-kong
    networks: [myapp-net, proxy_default]   # only ingress container needs the proxy network
    depends_on:
      myapp-studio: { condition: service_healthy }
    volumes:
      - ./kong.yml:/home/kong/temp.yml:ro
      # ...
    # kong.yml: trim the auth-v1-*/realtime-v1-*/functions-v1 route blocks, keep
    # rest-v1(-openapi)/graphql-v1/storage-v1/meta/dashboard — and point every internal
    # upstream URL (http://rest:3000 etc.) at your own service names, e.g. http://myapp-rest:3000

  myapp-rest:
    image: postgrest/postgrest:<version>
    container_name: myapp-rest
    networks: [myapp-net]
    environment:
      # direct connection, no pooler:
      PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@myapp-db:5432/postgres
      # ...

  myapp-storage:
    image: supabase/storage-api:<version>
    container_name: myapp-storage
    networks: [myapp-net]
    environment:
      ENABLE_IMAGE_TRANSFORMATION: "false"
      DATABASE_URL: postgres://supabase_storage_admin:${POSTGRES_PASSWORD}@myapp-db:5432/postgres
      # ...

  myapp-meta:
    image: supabase/postgres-meta:<version>
    container_name: myapp-meta
    networks: [myapp-net]

  myapp-studio:
    image: supabase/studio:<version>
    container_name: myapp-studio
    networks: [myapp-net]
    environment:
      SUPABASE_URL: http://myapp-kong:8000
      # ...

networks:
  myapp-net: {}
  proxy_default: { external: true }

volumes:
  db-data: {}
```

Publish **zero `ports:`** anywhere in this file.

### 2.3 n8n on the VPS

Same image, same env knobs from section 1.6 (`N8N_CORS_ALLOW_ORIGIN`, `N8N_PAYLOAD_SIZE_MAX`,
`NODE_FUNCTION_ALLOW_BUILTIN`, `N8N_BLOCK_ENV_ACCESS_IN_NODE`), plus HTTPS-specific settings:

```bash
N8N_HOST=n8n.yourdomain.com
N8N_PROTOCOL=https
WEBHOOK_URL=https://n8n.yourdomain.com/
N8N_SECURE_COOKIE=true
N8N_CORS_ALLOW_ORIGIN=https://app.yourdomain.com,https://submit.yourdomain.com
SUPABASE_URL=http://myapp-kong:8000/rest/v1
SUPABASE_SERVICE_ROLE_KEY=<same value as your Supabase stack's SERVICE_ROLE_KEY>
TAVILY_API_KEY=<your key>
OPENAI_API_KEY=<your key>
```

Publish zero ports; attach the `n8n` container to the reverse proxy's network so it's reachable
by container name.

**Two gotchas you will hit on a fresh import — both are silent failures, not errors on import
itself:**

1. **Stale `executeWorkflow` sub-workflow IDs.** Several workflows call other workflows (e.g.
   the intake-submit flow calls the thesis-gate flow, which calls a DB-write flow). Each such
   call is stored as a hardcoded `workflowId` inside an `executeWorkflow` node — the **source**
   instance's internal ID. On a fresh instance, every imported workflow gets a **new** ID, so
   these calls silently fail with "workflow not found" at runtime, even though the workflow
   imported and even activates without error. Fix: for every workflow with an `executeWorkflow`
   node, identify which workflow it's calling (the node name usually says, e.g. "Call
   f07-thesis-gate"), look up that workflow's **new** ID on your instance
   (`GET /api/v1/workflows`), and update the node's `parameters.workflowId.value` to match —
   either by editing the JSON before import, or via `PUT /api/v1/workflows/{id}` after.

2. **Activation order.** This version of n8n refuses to activate a workflow if any workflow it
   calls via `executeWorkflow` isn't **already** active — you'll get an explicit error naming
   the unpublished sub-workflow. Activate leaf/called workflows **first**, then the ones that
   call them, working up the dependency chain.

Some workflows use n8n's native **Credential** objects (e.g. a proper "OpenAI" credential type)
instead of `$env.*` expressions — those are **not portable** across instances on import; you'll
need to create matching credentials in the new instance's UI (**Credentials → New**) and rewire
any node still pointing at the old (now-invalid) credential ID.

**CORS:** browser calls from your web app's origin to n8n's webhook endpoints are
cross-origin. Verify a preflight succeeds before assuming it's broken elsewhere:

```bash
curl -si -X OPTIONS https://n8n.yourdomain.com/webhook/<some-active-webhook-path> \
  -H "Origin: https://app.yourdomain.com" \
  -H "Access-Control-Request-Method: POST" | grep -i access-control
```

You should see `access-control-allow-origin: https://app.yourdomain.com` in the response. If a
webhook route returns a bare 404 with **no** CORS headers at all (not even a rejection), it
almost always means the workflow isn't active yet — activate it and retry.

### 2.4 Reverse proxy: Caddy example (nginx works too)

Caddy's automatic HTTPS makes this the shortest path. One file per public-facing service (no
host ports needed — Caddy proxies straight to the containers by name over the shared network):

```caddyfile
app.yourdomain.com {
    reverse_proxy myapp-web:3000
}

submit.yourdomain.com {
    reverse_proxy myapp-web:3000
}

api.yourdomain.com {
    reverse_proxy myapp-kong:8000
}

n8n.yourdomain.com {
    reverse_proxy myapp-n8n:5678
}
```

The same `web/` build serves both public faces by client-side route: `/` redirects to `/apply`
(founder intake), and `/app/*` is the investor dashboard. If you want a dedicated "dashboard"
subdomain to open the dashboard directly instead of intake, redirect **only the exact root
path** at the proxy — anything broader breaks deep links:

```caddyfile
app.yourdomain.com {
    @root path /
    redir @root /app 302
    reverse_proxy myapp-web:3000
}
```

An nginx equivalent for one service (repeat per subdomain, plus your own TLS/certbot setup):

```nginx
server {
    listen 443 ssl;
    server_name app.yourdomain.com;
    location / {
        proxy_pass http://myapp-web:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 2.5 Building `web/` for production

The default nitro target in this repo's `web/vite.config.ts` (via
`@lovable.dev/vite-tanstack-config`) is **Cloudflare Workers**, not a plain Node server — for a
Docker/VPS deployment you must override the preset at build time:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SUPABASE_REST_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_N8N_BASE_URL
ENV VITE_SUPABASE_REST_URL=$VITE_SUPABASE_REST_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_N8N_BASE_URL=$VITE_N8N_BASE_URL \
    NITRO_PRESET=node_server
RUN npm run build   # verify .output/server/index.mjs exists after this

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

`VITE_*` variables are **build-time**, not runtime — they get baked into the compiled JS. You
must rebuild the image (not just restart the container) whenever you change
`VITE_SUPABASE_REST_URL`, `VITE_SUPABASE_ANON_KEY` or `VITE_N8N_BASE_URL`, and every time the
`web/` source changes.

```bash
docker compose build web   # rebuild
docker compose up -d web   # recreate the container from the new image
```

### 2.6 Data: load the demo dataset, seed fresh, or migrate an existing dataset

**Recommended — the shipped demo dataset:** run `db/apply.sh` against the VPS database (direct
connection, no pooler needed — `postgresql://postgres:<PASSWORD>@myapp-db:5432/postgres` from
inside the Docker network, e.g. via `docker exec myapp-db psql ...`), create the `decks` bucket
(section 1.3) through the VPS's Kong, then run `db/load-demo.sh` against the same
`DATABASE_URL` — it loads `db/fixtures/demo-seed.sql`, an anonymized ~167-founder dataset with
scores, claims and evidence already populated (no real people, safe to expose publicly, no need
to run the scoring pipelines or make live GitHub/HN/Tavily calls yourself). If your VPS database
has no host-published port (the isolated-stack pattern in section 2.1 recommends exactly that),
either run `load-demo.sh` from inside a container attached to the same Docker network, or skip
the wrapper script and pipe the fixture straight into the `db` container the same way the schema
step does: `docker exec -i myapp-db psql -U postgres -d postgres < db/fixtures/demo-seed.sql`.

**Fresh, empty database:** the same three steps, but skip `load-demo.sh` and optionally run the
narrower fixtures from section 1.4 instead if you want a specific scenario rather than the full
demo dataset.

**Migrating your own existing dataset** (e.g. from your local dev database to the VPS):

1. Dump data only, from the source, without touching the running container:
   ```bash
   docker exec <source-db-container> pg_dump -U postgres \
     --data-only --disable-triggers --schema=public postgres > dump.sql
   ```
   `--disable-triggers` wraps every table's `COPY` in `ALTER TABLE ... DISABLE/ENABLE TRIGGER
   ALL`, which sidesteps FK-ordering problems (including any self-referential FKs) regardless of
   table order.
2. Apply the schema on the target **first** (`db/apply.sh`), ideally into a completely empty
   database.
3. Restore, **as a superuser role**:
   ```bash
   docker exec -i myapp-db psql -U <superuser-role> -v ON_ERROR_STOP=1 -d postgres < dump.sql
   ```
   ⚠️ On current `supabase/postgres` images, the `postgres` role is **not** superuser by
   default (a separate admin role is) — `DISABLE TRIGGER ALL` requires actual superuser
   privilege, and restoring as the non-superuser `postgres` role fails immediately with a
   permission error on the very first table. Check which role is superuser before you start:
   ```bash
   docker exec myapp-db psql -U postgres -d postgres \
     -c "select rolname, rolsuper from pg_roles where rolsuper;"
   ```
4. **Expect a conflict if you restore into a non-empty database.** A data-only dump includes
   small lookup/reference tables (e.g. scoring-axis or card-type registries) that `db/apply.sh`'s
   own seed step may have already populated with matching rows — you'll hit a unique-constraint
   violation on exactly those tables. The clean fix is restoring into a target that's freshly
   schema-applied and otherwise empty (do this **before** any other writes touch it). If you
   must retry into a partially-populated target, truncate every `public` table first:
   ```bash
   docker exec myapp-db psql -U <superuser-role> -d postgres -c "
   DO \$\$ DECLARE r RECORD; BEGIN
     FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
       EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
     END LOOP;
   END \$\$;"
   ```
5. Reload PostgREST's schema cache and verify row counts against your source:
   ```bash
   docker exec myapp-db psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';"
   docker exec myapp-db psql -U postgres -d postgres -c "
     select 'founders' t, count(*) from founders
     union all select 'companies', count(*) from companies
     union all select 'applications', count(*) from applications;"
   ```

---

## 3. Quickstart — copy/paste command blocks

### 3.1 Local, from a fresh clone

```bash
git clone <this-repo-url> && cd the-vc-brain

cd infra/supabase
cp .env.example .env && sh utils/generate-keys.sh --update-env
docker compose up -d
cd ../..

set -a; source infra/supabase/.env; set +a
DATABASE_URL="postgresql://postgres.$POOLER_TENANT_ID:$POSTGRES_PASSWORD@localhost:54322/postgres" \
  ./db/apply.sh

curl -s -X POST http://localhost:8000/storage/v1/bucket \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{"name":"decks","id":"decks","public":false}'

# populate with the shipped, anonymized demo dataset (section 1.4) — skip this if
# you'd rather start from an empty schema, or migrate your own data (section 2.6)
DATABASE_URL="postgresql://postgres.$POOLER_TENANT_ID:$POSTGRES_PASSWORD@localhost:54322/postgres" \
  ./db/load-demo.sh

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/smoke.sql

cd infra/n8n
cat > .env << EOF
SUPABASE_URL=http://host.docker.internal:8000/rest/v1
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
TAVILY_API_KEY=<your Tavily key>
OPENAI_API_KEY=<your OpenAI key>
EOF
docker compose up -d
cd ..
# → open http://localhost:5678, finish owner setup, import n8n/workflows/*.json (section 1.7)

cd web
cp .env.example .env
# → fill in VITE_SUPABASE_ANON_KEY=$ANON_KEY in web/.env
npm install && npm run dev
# → open http://localhost:5173
```

### 3.2 VPS, from a fresh clone

```bash
git clone <this-repo-url> && cd the-vc-brain

# 1. Slim Supabase stack (section 2.2) — write myapp-compose.yml, then:
docker compose -p myapp -f myapp-compose.yml --env-file myapp.env up -d

# 2. Schema + decks bucket — direct connection, no pooler:
docker exec -i myapp-db psql -U postgres -d postgres < db/schema.sql
docker exec -i myapp-db psql -U postgres -d postgres < db/seed.sql
docker exec myapp-db psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';"
docker run --rm --network myapp-net curlimages/curl -s -X POST \
  http://myapp-kong:8000/storage/v1/bucket \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{"name":"decks","id":"decks","public":false}'

# 3. Data — load the shipped anonymized demo dataset (recommended), or migrate your
#    own existing dataset instead (section 2.6):
docker exec -i myapp-db psql -U postgres -d postgres < db/fixtures/demo-seed.sql
docker exec -i myapp-db psql -U postgres -d postgres < db/tests/smoke.sql

# 4. web — build with the node_server preset and prod VITE_* (section 2.5), then:
docker compose -p myapp-web -f web-compose.yml --env-file web.env build
docker compose -p myapp-web -f web-compose.yml --env-file web.env up -d

# 5. n8n — bring up (section 2.3), then in the UI: finish owner setup, import
#    n8n/workflows/*.json, remap executeWorkflow sub-workflow ids, activate
#    leaf-first (section 2.3)
docker compose -p myapp-n8n -f n8n-compose.yml --env-file n8n.env up -d

# 6. Reverse proxy — drop your site configs (section 2.4), reload/restart the proxy

# 7. Verify
curl -sI https://app.yourdomain.com/
curl -sI https://api.yourdomain.com/rest/v1/ -H "apikey: $ANON_KEY"
curl -sI https://n8n.yourdomain.com/
```
