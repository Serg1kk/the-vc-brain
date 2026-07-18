#!/usr/bin/env bash
#
# db/apply.sh -- apply the VC Brain Memory-layer schema to a Supabase/Postgres instance.
#
# Usage:
#   ./db/apply.sh
#   DATABASE_URL="postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres" ./db/apply.sh
#
# Applies db/schema.sql then db/seed.sql (both idempotent: CREATE TABLE IF NOT EXISTS,
# CREATE OR REPLACE, ON CONFLICT DO NOTHING seeds -- safe to re-run against a live DB),
# then asks PostgREST to reload its schema cache so new tables/columns/triggers become
# visible over the REST API without a container restart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sensible localhost default (matches a fresh local Supabase self-hosted compose before
# any password override). Real local runs MUST export DATABASE_URL with the actual
# generated POSTGRES_PASSWORD from infra/supabase/.env -- see CLAUDE.md > Commands.
: "${DATABASE_URL:=postgresql://postgres:postgres@localhost:5432/postgres}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc)

echo "==> Applying schema: $SCRIPT_DIR/schema.sql"
"${PSQL[@]}" -f "$SCRIPT_DIR/schema.sql"

echo "==> Applying seed data: $SCRIPT_DIR/seed.sql"
"${PSQL[@]}" -f "$SCRIPT_DIR/seed.sql"

echo "==> Reloading PostgREST schema cache"
"${PSQL[@]}" -c "NOTIFY pgrst, 'reload schema';"

echo "==> Done."
