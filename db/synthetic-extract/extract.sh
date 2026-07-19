#!/usr/bin/env bash
#
# db/synthetic-extract/extract.sh -- pull the synthetic-only demo subset out of a
# running Postgres and write it to per-table CSVs, in FK-safe (parents-first) load
# order. Read-only against the source: every statement below is SELECT/\copy TO,
# nothing mutates the source database.
#
# Companion to load.sh, which loads these CSVs into a fresh (schema-applied) target.
# See docs/backlog/12-docker-deploy/synthetic-swap.md for the full procedure,
# the keep-set predicates, and why each predicate is shaped the way it is.
#
# Usage (reads from the local dockerized supabase-db by default):
#   ./db/synthetic-extract/extract.sh [output_dir]
#
#   SOURCE_CONTAINER=supabase-db ./db/synthetic-extract/extract.sh /path/to/out
#
# Flag-based, not hardcoded ids: the keep-sets below are `is_synthetic = true`
# (founders/companies) and `id LIKE '11f0%'` (applications, the feature-11 curated
# demo journey) -- re-running this script later, after feature 11 has generated more
# scores/memos on top of the SAME synthetic rows, picks up whatever exists at run
# time. It does NOT need updating when new synthetic rows are added under the same
# flags.

set -euo pipefail

SOURCE_CONTAINER="${SOURCE_CONTAINER:-supabase-db}"
OUT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/out}"

mkdir -p "$OUT_DIR"
echo "==> Writing CSVs to: $OUT_DIR"
echo "==> Reading from container: $SOURCE_CONTAINER (read-only: SELECT + \\copy TO only)"

# Single psql session: temp tables materializing the keep-sets live only for this
# session, so every \copy below reads the SAME snapshot (no TOCTOU drift between
# tables even though feature 11's pipelines may be writing concurrently).
docker exec -i "$SOURCE_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc <<SQL
-- ============================================================================
-- Keep-sets (see synthetic-swap.md SS2 for the rationale behind each predicate).
-- All downstream temp tables are AND-scoped: a row survives only if EVERY
-- non-null person-linking FK column on it resolves into a kept id. This is both
-- the leak-safe rule (a row can never smuggle in a reference to an excluded --
-- i.e. real -- founder/company) and the FK-safe rule (load.sh can never hit a
-- dangling reference, because anything outside the keep-set was never selected).
-- ============================================================================

CREATE TEMP TABLE keep_founders AS
  SELECT id FROM founders WHERE is_synthetic = true;

CREATE TEMP TABLE keep_companies AS
  SELECT id FROM companies WHERE is_synthetic = true;

-- Curated feature-11 demo journey only -- narrower than "any synthetic company's
-- applications". See synthetic-swap.md SS3 for the 6 non-curated fixture
-- applications (feature 05 / feature 07 test fixtures, id prefixes 05f0aaaa%/07f0%)
-- this deliberately excludes, and what excluding them does to their ai_runs /
-- thesis_evaluations / scores / cards (excluded too, by the AND-scoping above).
CREATE TEMP TABLE keep_applications AS
  SELECT id FROM applications WHERE id::text LIKE '11f0%';

CREATE TEMP TABLE keep_cards AS
  SELECT c.id FROM cards c
  WHERE (c.founder_id IS NULL OR c.founder_id IN (SELECT id FROM keep_founders))
    AND (c.company_id IS NULL OR c.company_id IN (SELECT id FROM keep_companies))
    AND (c.application_id IS NULL OR c.application_id IN (SELECT id FROM keep_applications))
    AND (c.founder_id IS NOT NULL OR c.company_id IS NOT NULL OR c.application_id IS NOT NULL);

CREATE TEMP TABLE keep_raw_signals AS
  SELECT rs.id FROM raw_signals rs
  WHERE (rs.founder_id IS NULL OR rs.founder_id IN (SELECT id FROM keep_founders))
    AND (rs.company_id IS NULL OR rs.company_id IN (SELECT id FROM keep_companies))
    AND (rs.founder_id IS NOT NULL OR rs.company_id IS NOT NULL);

CREATE TEMP TABLE keep_claims AS
  SELECT cl.id FROM claims cl WHERE cl.card_id IN (SELECT id FROM keep_cards);

CREATE TEMP TABLE keep_evidence AS
  SELECT e.id FROM evidence e
  WHERE e.claim_id IN (SELECT id FROM keep_claims)
    AND (e.raw_signal_id IS NULL OR e.raw_signal_id IN (SELECT id FROM keep_raw_signals));

CREATE TEMP TABLE keep_scores AS
  SELECT s.id FROM scores s
  WHERE (s.founder_id IS NULL OR s.founder_id IN (SELECT id FROM keep_founders))
    AND (s.application_id IS NULL OR s.application_id IN (SELECT id FROM keep_applications))
    AND (s.founder_id IS NOT NULL OR s.application_id IS NOT NULL);

CREATE TEMP TABLE keep_score_components AS
  SELECT sc.id FROM score_components sc
  WHERE sc.founder_id IN (SELECT id FROM keep_founders)
    AND (sc.score_id IS NULL OR sc.score_id IN (SELECT id FROM keep_scores));

CREATE TEMP TABLE keep_ai_runs AS
  SELECT r.id FROM ai_runs r
  WHERE (r.founder_id IS NULL OR r.founder_id IN (SELECT id FROM keep_founders))
    AND (r.company_id IS NULL OR r.company_id IN (SELECT id FROM keep_companies))
    AND (r.application_id IS NULL OR r.application_id IN (SELECT id FROM keep_applications))
    AND (r.founder_id IS NOT NULL OR r.company_id IS NOT NULL OR r.application_id IS NOT NULL);

CREATE TEMP TABLE keep_thesis_evaluations AS
  SELECT te.id FROM thesis_evaluations te
  WHERE te.application_id IN (SELECT id FROM keep_applications)
    AND te.extraction_ai_run_id IN (SELECT id FROM keep_ai_runs)
    AND (te.score_id IS NULL OR te.score_id IN (SELECT id FROM keep_scores));

CREATE TEMP TABLE keep_memos AS
  SELECT m.id FROM memos m WHERE m.application_id IN (SELECT id FROM keep_applications);

CREATE TEMP TABLE keep_interviews AS
  SELECT iv.id FROM interviews iv
  WHERE iv.application_id IN (SELECT id FROM keep_applications)
    AND iv.card_id IN (SELECT id FROM keep_cards);

CREATE TEMP TABLE keep_voice_artifacts AS
  SELECT va.id FROM voice_artifacts va WHERE va.interview_id IN (SELECT id FROM keep_interviews);

CREATE TEMP TABLE keep_metric_observations AS
  SELECT mo.id FROM metric_observations mo
  WHERE (mo.founder_id IS NULL OR mo.founder_id IN (SELECT id FROM keep_founders))
    AND (mo.company_id IS NULL OR mo.company_id IN (SELECT id FROM keep_companies))
    AND (mo.founder_id IS NOT NULL OR mo.company_id IS NOT NULL);

CREATE TEMP TABLE keep_watchlist AS
  SELECT w.id FROM watchlist w
  WHERE (w.founder_id IS NULL OR w.founder_id IN (SELECT id FROM keep_founders))
    AND (w.company_id IS NULL OR w.company_id IN (SELECT id FROM keep_companies))
    AND (w.added_from_application_id IS NULL OR w.added_from_application_id IN (SELECT id FROM keep_applications));

-- events has no FK (schema-documented, deliberate -- see purge_founder()'s own
-- comment on this table); two entity_type branches only, matching the same two
-- branches purge_founder() sweeps. url-typed / NULL-entity_type rows (global,
-- not scoped to any founder/application) are out of scope for a person-data
-- extract and excluded here.
CREATE TEMP TABLE keep_events AS
  SELECT ev.id FROM events ev
  WHERE (ev.entity_type = 'founder' AND ev.entity_id IN (SELECT id FROM keep_founders))
     OR (ev.entity_type = 'application' AND ev.entity_id IN (SELECT id FROM keep_applications));

-- theses is registry/config (seeded by db/apply.sh) with ONE exception: its id
-- is a random gen_random_uuid(), not a stable natural key like the other
-- registry tables (score_axes/card_types/metric_kinds/signal_sources key off
-- slug/text). applications.thesis_id / scores.thesis_id / thesis_evaluations
-- .thesis_id carry that random LOCAL id -- a fresh apply.sh run on the target
-- generates its OWN new random id for the same (name, version), which would
-- dangle. So: extract exactly the theses row(s) actually referenced by the
-- kept rows above (by FK, not by name/version guess -- flag-based), and
-- load.sh re-inserts them with their ORIGINAL id after truncating whatever
-- apply.sh seeded. See synthetic-swap.md SS4 "theses id" for the full story
-- (this is the same failure the original full-DB restore hit, tracker.md S0-A).
CREATE TEMP TABLE keep_theses AS
  SELECT DISTINCT t.id FROM theses t
  WHERE t.id IN (SELECT thesis_id FROM applications WHERE id IN (SELECT id FROM keep_applications) AND thesis_id IS NOT NULL)
     OR t.id IN (SELECT thesis_id FROM scores WHERE id IN (SELECT id FROM keep_scores) AND thesis_id IS NOT NULL)
     OR t.id IN (SELECT thesis_id FROM thesis_evaluations WHERE id IN (SELECT id FROM keep_thesis_evaluations));

-- ============================================================================
-- Export, parents before children (load.sh loads in this same order).
-- Explicit column lists on both sides (never SELECT *): generated columns
-- (founders/companies.normalized_name+search_tsv, claims.search_tsv) cannot be
-- copied in, and an explicit list keeps export/import positionally locked even
-- if the schema grows a column later.
-- ============================================================================

\copy (SELECT id, name, config, version, active, created_at, updated_at, is_default FROM theses WHERE id IN (SELECT id FROM keep_theses)) TO '$OUT_DIR/01_theses.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, full_name, headline, location_city, location_country, profile, is_synthetic, merged_into_founder_id, opt_out_at, created_at, updated_at FROM founders WHERE id IN (SELECT id FROM keep_founders)) TO '$OUT_DIR/02_founders.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, name, domain, one_liner, category, stage, hq_city, hq_country, aliases, profile, is_synthetic, created_at, updated_at FROM companies WHERE id IN (SELECT id FROM keep_companies)) TO '$OUT_DIR/03_companies.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, company_id, kind, status, thesis_id, thesis_gate, deck_storage_path, artifact_links, submitted_by, created_at, updated_at FROM applications WHERE id IN (SELECT id FROM keep_applications)) TO '$OUT_DIR/04_applications.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, founder_id, company_id, role, is_current, confidence, source, created_at FROM founder_company WHERE founder_id IN (SELECT id FROM keep_founders) AND company_id IN (SELECT id FROM keep_companies)) TO '$OUT_DIR/05_founder_company.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, founder_id, kind, value, url, confidence, discovered_via, verified_at, created_at FROM founder_identities WHERE founder_id IN (SELECT id FROM keep_founders)) TO '$OUT_DIR/06_founder_identities.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, card_type, founder_id, company_id, application_id, status, completeness, created_at, updated_at FROM cards WHERE id IN (SELECT id FROM keep_cards)) TO '$OUT_DIR/07_cards.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, source, source_url, payload, content_hash, founder_id, company_id, observed_at, created_at FROM raw_signals WHERE id IN (SELECT id FROM keep_raw_signals)) TO '$OUT_DIR/08_raw_signals.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, verification_status, content_hash, supersedes_claim_id, created_at, updated_at FROM claims WHERE id IN (SELECT id FROM keep_claims)) TO '$OUT_DIR/09_claims.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, captured_at, content_hash, created_at FROM evidence WHERE id IN (SELECT id FROM keep_evidence)) TO '$OUT_DIR/10_evidence.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, founder_id, application_id, axis, value, trend, confidence, missing_flags, input_claim_ids, formula_version, prompt_version, model, thesis_id, computed_at, created_at FROM scores WHERE id IN (SELECT id FROM keep_scores)) TO '$OUT_DIR/11_scores.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, credit, contribution, evidence_tier, claim_ids, quote_verbatim, rationale, what_would_close_it, demoted_by, created_at FROM score_components WHERE id IN (SELECT id FROM keep_score_components)) TO '$OUT_DIR/12_score_components.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, task_type, founder_id, company_id, application_id, model, prompt_version, input_hash, output_json, confidence, disagreement, n8n_execution_id, created_at FROM ai_runs WHERE id IN (SELECT id FROM keep_ai_runs)) TO '$OUT_DIR/13_ai_runs.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict, score_id, fired_rules, extracted_snapshot, thesis_config_snapshot, missing_fields, coverage, extraction_ai_run_id, formula_version, created_at FROM thesis_evaluations WHERE id IN (SELECT id FROM keep_thesis_evaluations)) TO '$OUT_DIR/14_thesis_evaluations.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, application_id, version, sections, gaps, cited_claim_ids, recommendation, conditions, deep_dive_questions, created_at FROM memos WHERE id IN (SELECT id FROM keep_memos)) TO '$OUT_DIR/15_memos.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, application_id, card_id, kind, share_token, status, disclosed_at, transcript, started_at, completed_at, created_at, updated_at FROM interviews WHERE id IN (SELECT id FROM keep_interviews)) TO '$OUT_DIR/16_interviews.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, interview_id, question_ref, storage_path, duration_sec, transcript_text, created_at FROM voice_artifacts WHERE id IN (SELECT id FROM keep_voice_artifacts)) TO '$OUT_DIR/17_voice_artifacts.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, founder_id, company_id, metric, value, observed_at, created_at FROM metric_observations WHERE id IN (SELECT id FROM keep_metric_observations)) TO '$OUT_DIR/18_metric_observations.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, founder_id, company_id, reason, condition, added_from_application_id, last_scored_at, next_check_at, active, created_at, updated_at FROM watchlist WHERE id IN (SELECT id FROM keep_watchlist)) TO '$OUT_DIR/19_watchlist.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT id, event_type, entity_type, entity_id, payload, actor, created_at FROM events WHERE id IN (SELECT id FROM keep_events)) TO '$OUT_DIR/20_events.csv' WITH (FORMAT csv, HEADER true)

-- Manifest: row counts per file, so load.sh (and a human) can sanity-check the
-- CSVs landed without opening each one.
\o '$OUT_DIR/manifest.txt'
SELECT 'theses' t, count(*) FROM keep_theses
UNION ALL SELECT 'founders', count(*) FROM keep_founders
UNION ALL SELECT 'companies', count(*) FROM keep_companies
UNION ALL SELECT 'applications', count(*) FROM keep_applications
UNION ALL SELECT 'founder_company', count(*) FROM founder_company WHERE founder_id IN (SELECT id FROM keep_founders) AND company_id IN (SELECT id FROM keep_companies)
UNION ALL SELECT 'founder_identities', count(*) FROM founder_identities WHERE founder_id IN (SELECT id FROM keep_founders)
UNION ALL SELECT 'cards', count(*) FROM keep_cards
UNION ALL SELECT 'raw_signals', count(*) FROM keep_raw_signals
UNION ALL SELECT 'claims', count(*) FROM keep_claims
UNION ALL SELECT 'evidence', count(*) FROM keep_evidence
UNION ALL SELECT 'scores', count(*) FROM keep_scores
UNION ALL SELECT 'score_components', count(*) FROM keep_score_components
UNION ALL SELECT 'ai_runs', count(*) FROM keep_ai_runs
UNION ALL SELECT 'thesis_evaluations', count(*) FROM keep_thesis_evaluations
UNION ALL SELECT 'memos', count(*) FROM keep_memos
UNION ALL SELECT 'interviews', count(*) FROM keep_interviews
UNION ALL SELECT 'voice_artifacts', count(*) FROM keep_voice_artifacts
UNION ALL SELECT 'metric_observations', count(*) FROM keep_metric_observations
UNION ALL SELECT 'watchlist', count(*) FROM keep_watchlist
UNION ALL SELECT 'events', count(*) FROM keep_events
ORDER BY 1;
\o
SQL

echo "==> Done. Manifest:"
cat "$OUT_DIR/manifest.txt"
