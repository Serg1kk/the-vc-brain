#!/usr/bin/env bash
#
# db/synthetic-extract/load.sh -- load a synthetic-only extract (produced by
# extract.sh) into a target Postgres that already has the schema + registry
# tables applied (db/apply.sh). Truncates person-data tables first, so this is
# DESTRUCTIVE on the target -- never point it at a database you want to keep.
#
# Preconditions (both REQUIRED, in order, before running this):
#   1. db/apply.sh has been run against the target (schema + registry seeds +
#      the decks storage bucket already exist).
#   2. extract.sh has produced CSVs + manifest.txt in the input dir.
#
# Usage:
#   DATABASE_URL="postgresql://postgres.<tenant>:<pw>@host:port/postgres" \
#     ./db/synthetic-extract/load.sh /path/to/extract/out
#
# Everything below runs inside ONE transaction (BEGIN .. COMMIT, ON_ERROR_STOP=1):
# if any \copy or verification step fails, psql exits before COMMIT and the
# transaction is discarded when the connection closes -- the target is left
# exactly as it was before this script ran (no partial truncate).

set -euo pipefail

IN_DIR="${1:?Usage: DATABASE_URL=... ./db/synthetic-extract/load.sh /path/to/extract/out}"
: "${DATABASE_URL:?Set DATABASE_URL to the target Postgres connection string}"

if [ ! -f "$IN_DIR/manifest.txt" ]; then
  echo "ERROR: $IN_DIR/manifest.txt not found -- run extract.sh first." >&2
  exit 1
fi

echo "==> Loading extract from: $IN_DIR"
echo "==> Target: (DATABASE_URL, not printed -- may contain a password)"
echo "==> Extract manifest:"
cat "$IN_DIR/manifest.txt"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc)

"${PSQL[@]}" <<SQL
BEGIN;

-- All person-data tables + theses (the one config-table exception -- see
-- synthetic-swap.md SS4). Listed together in one TRUNCATE so Postgres can see
-- every FK edge between them at once; CASCADE here is a safety net for that
-- same closed set, NOT scope creep -- nothing outside this list references
-- anything inside it, so CASCADE cannot reach score_axes/card_types/
-- metric_kinds/signal_sources/score_formulas (apply.sh's other registry
-- tables), which are deliberately left untouched.
TRUNCATE TABLE
  ai_runs, applications, cards, claims, companies, events, evidence,
  founder_company, founder_identities, founders, interviews, memos,
  metric_observations, raw_signals, score_components, scores,
  thesis_evaluations, theses, voice_artifacts, watchlist
  RESTART IDENTITY CASCADE;

-- Parents before children, same order extract.sh exported in. Explicit column
-- lists mirror extract.sh's SELECT lists exactly (positional match).

\copy theses (id, name, config, version, active, created_at, updated_at, is_default) FROM '$IN_DIR/01_theses.csv' WITH (FORMAT csv, HEADER true)

-- theses invariant (db/seed.sql's own comment: "the gate cannot run without a
-- thesis... without a row satisfying both [is_default AND active], the gate
-- has nothing to load and every call fails"). extract.sh deliberately carries
-- theses rows in WHATEVER active/inactive state they had locally -- that's
-- the row thesis_evaluations.thesis_config_snapshot etc. actually reference --
-- which can leave the loaded set with NO active+is_default row (verified in
-- testing: the referenced 'default' v1 row had already been superseded
-- locally by a v2 activation before extraction). Confirmed independently by
-- db/tests/smoke.sql's own uq_theses_single_default assertion, which is
-- exactly the check that caught this. Promote the best candidate so the
-- target is never left without a working default thesis; if the extract
-- carried zero theses rows at all (nothing referenced one yet), fall back to
-- db/seed.sql's own literal 'default' v1 config (kept in sync with that file
-- by hand -- same stance as the claim_trust view's documented duplicate).
DO \$\$
DECLARE
  v_promoted uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theses WHERE active AND is_default) THEN
    SELECT id INTO v_promoted FROM theses
    ORDER BY is_default DESC, version DESC, created_at DESC
    LIMIT 1;

    IF v_promoted IS NOT NULL THEN
      UPDATE theses SET active = true, is_default = true WHERE id = v_promoted;
    ELSE
      INSERT INTO theses (name, version, config, active, is_default) VALUES (
        'default', 1,
        '{"fit": {"base": 50, "min_coverage": 0.5, "mandate_weight": 20, "strong_threshold": 70, "soft_deal_breaker_penalty": 30}, "geos": ["DE", "FR", "NL", "US"], "rules": [{"id": "R1", "expr": {"op": "in", "field": "sector", "value": ["gambling", "adtech"]}, "kind": "deal_breaker", "label": "Excluded sector: gambling", "weight": 0, "enabled": true, "enforcement": "hard", "hard_justification": "mandate_fatal"}, {"id": "R2", "expr": {"op": "eq", "field": "business_model", "value": "b2b"}, "kind": "focus", "label": "B2B focus", "weight": 25, "enabled": true, "enforcement": "soft"}], "mandate": {"stages": ["pre_seed", "seed"], "sectors": ["b2b-software", "ai-infra", "devtools"], "geographies": ["EU", "US"], "risk_appetite": "high", "check_size_usd": {"max": 150000, "min": 50000}, "ownership_target_pct": null}, "schema_version": 1, "exceptional_lane": {"axis": "founder_score", "aggregate": "max", "min_value": 75}, "negative_keywords": ["casino", "betting"], "positive_keywords": ["developer tools", "infrastructure"]}'::jsonb,
        true, true
      );
    END IF;
  END IF;
END \$\$;

\copy founders (id, full_name, headline, location_city, location_country, profile, is_synthetic, merged_into_founder_id, opt_out_at, created_at, updated_at) FROM '$IN_DIR/02_founders.csv' WITH (FORMAT csv, HEADER true)

\copy companies (id, name, domain, one_liner, category, stage, hq_city, hq_country, aliases, profile, is_synthetic, created_at, updated_at) FROM '$IN_DIR/03_companies.csv' WITH (FORMAT csv, HEADER true)

\copy applications (id, company_id, kind, status, thesis_id, thesis_gate, deck_storage_path, artifact_links, submitted_by, created_at, updated_at) FROM '$IN_DIR/04_applications.csv' WITH (FORMAT csv, HEADER true)

\copy founder_company (id, founder_id, company_id, role, is_current, confidence, source, created_at) FROM '$IN_DIR/05_founder_company.csv' WITH (FORMAT csv, HEADER true)

\copy founder_identities (id, founder_id, kind, value, url, confidence, discovered_via, verified_at, created_at) FROM '$IN_DIR/06_founder_identities.csv' WITH (FORMAT csv, HEADER true)

\copy cards (id, card_type, founder_id, company_id, application_id, status, completeness, created_at, updated_at) FROM '$IN_DIR/07_cards.csv' WITH (FORMAT csv, HEADER true)

\copy raw_signals (id, source, source_url, payload, content_hash, founder_id, company_id, observed_at, created_at) FROM '$IN_DIR/08_raw_signals.csv' WITH (FORMAT csv, HEADER true)

\copy claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, verification_status, content_hash, supersedes_claim_id, created_at, updated_at) FROM '$IN_DIR/09_claims.csv' WITH (FORMAT csv, HEADER true)

\copy evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, captured_at, content_hash, created_at) FROM '$IN_DIR/10_evidence.csv' WITH (FORMAT csv, HEADER true)

\copy scores (id, founder_id, application_id, axis, value, trend, confidence, missing_flags, input_claim_ids, formula_version, prompt_version, model, thesis_id, computed_at, created_at) FROM '$IN_DIR/11_scores.csv' WITH (FORMAT csv, HEADER true)

\copy score_components (id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, credit, contribution, evidence_tier, claim_ids, quote_verbatim, rationale, what_would_close_it, demoted_by, created_at) FROM '$IN_DIR/12_score_components.csv' WITH (FORMAT csv, HEADER true)

\copy ai_runs (id, task_type, founder_id, company_id, application_id, model, prompt_version, input_hash, output_json, confidence, disagreement, n8n_execution_id, created_at) FROM '$IN_DIR/13_ai_runs.csv' WITH (FORMAT csv, HEADER true)

\copy thesis_evaluations (id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict, score_id, fired_rules, extracted_snapshot, thesis_config_snapshot, missing_fields, coverage, extraction_ai_run_id, formula_version, created_at) FROM '$IN_DIR/14_thesis_evaluations.csv' WITH (FORMAT csv, HEADER true)

\copy memos (id, application_id, version, sections, gaps, cited_claim_ids, recommendation, conditions, deep_dive_questions, created_at) FROM '$IN_DIR/15_memos.csv' WITH (FORMAT csv, HEADER true)

\copy interviews (id, application_id, card_id, kind, share_token, status, disclosed_at, transcript, started_at, completed_at, created_at, updated_at) FROM '$IN_DIR/16_interviews.csv' WITH (FORMAT csv, HEADER true)

\copy voice_artifacts (id, interview_id, question_ref, storage_path, duration_sec, transcript_text, created_at) FROM '$IN_DIR/17_voice_artifacts.csv' WITH (FORMAT csv, HEADER true)

\copy metric_observations (id, founder_id, company_id, metric, value, observed_at, created_at) FROM '$IN_DIR/18_metric_observations.csv' WITH (FORMAT csv, HEADER true)

\copy watchlist (id, founder_id, company_id, reason, condition, added_from_application_id, last_scored_at, next_check_at, active, created_at, updated_at) FROM '$IN_DIR/19_watchlist.csv' WITH (FORMAT csv, HEADER true)

\copy events (id, event_type, entity_type, entity_id, payload, actor, created_at) FROM '$IN_DIR/20_events.csv' WITH (FORMAT csv, HEADER true)

-- Verification, still inside the transaction: zero real (is_synthetic = false)
-- founders/companies, and zero applications outside the curated 11f0% set.
-- Any non-zero count here raises and rolls back the whole load.
DO \$\$
DECLARE
  v_real_founders int;
  v_real_companies int;
  v_non_curated_apps int;
BEGIN
  SELECT count(*) INTO v_real_founders FROM founders WHERE is_synthetic = false;
  SELECT count(*) INTO v_real_companies FROM companies WHERE is_synthetic = false;
  SELECT count(*) INTO v_non_curated_apps FROM applications WHERE id::text NOT LIKE '11f0%';

  IF v_real_founders > 0 OR v_real_companies > 0 OR v_non_curated_apps > 0 THEN
    RAISE EXCEPTION 'synthetic-swap post-load check FAILED: % real founders, % real companies, % non-curated applications -- rolling back',
      v_real_founders, v_real_companies, v_non_curated_apps;
  END IF;
END;
\$\$;

COMMIT;
SQL

echo "==> Load committed. Reloading PostgREST schema cache..."
"${PSQL[@]}" -c "NOTIFY pgrst, 'reload schema';"

echo "==> Done. Run db/tests/smoke.sql against the target next."
