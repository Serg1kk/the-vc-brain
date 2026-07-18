#!/usr/bin/env bash
#
# db/apply.sh -- apply the VC Brain Memory-layer schema to a Supabase/Postgres instance.
#
# Usage:
#   ./db/apply.sh
#   DATABASE_URL="postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@localhost:54322/postgres" ./db/apply.sh
#
# Applies db/schema.sql then db/seed.sql (both idempotent: CREATE TABLE IF NOT EXISTS,
# CREATE OR REPLACE, ON CONFLICT DO NOTHING seeds -- safe to re-run against a live DB),
# then asks PostgREST to reload its schema cache so new tables/columns/triggers become
# visible over the REST API without a container restart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Port 54322: the infra/supabase compose publishes Postgres via the Supavisor pooler
# on 54322, not 5432 -- 5432 is only the internal Docker network port for the db
# service itself (docker-compose.yml has no host port mapping on `db`), and on many
# dev machines a native host Postgres also listens on 127.0.0.1:5432, silently
# shadowing the container for loopback connections (m-port-collision, 2026-07-19
# incident -- see CLAUDE.md > Commands).
#
# The pooler REQUIRES a tenant-qualified username -- postgres.<POOLER_TENANT_ID from
# infra/supabase/.env> -- plain "postgres" fails with "no tenant identifier provided
# (external_id or sni_hostname required)".
#
# Real local runs MUST export DATABASE_URL with the actual generated
# POSTGRES_PASSWORD (and POOLER_TENANT_ID, if changed from its default) from
# infra/supabase/.env -- see CLAUDE.md > Commands.
: "${DATABASE_URL:=postgresql://postgres.your-tenant-id:postgres@localhost:54322/postgres}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc)

echo "==> Applying schema: $SCRIPT_DIR/schema.sql"
"${PSQL[@]}" -f "$SCRIPT_DIR/schema.sql"

echo "==> Applying seed data: $SCRIPT_DIR/seed.sql"
"${PSQL[@]}" -f "$SCRIPT_DIR/seed.sql"

echo "==> Reloading PostgREST schema cache"
"${PSQL[@]}" -c "NOTIFY pgrst, 'reload schema';"

echo "==> Done."
