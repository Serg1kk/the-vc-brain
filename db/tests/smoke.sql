-- db/tests/smoke.sql
--
-- Smoke suite for the VC Brain Memory-layer schema (feature 01).
-- Proves the sponsor invariants hold at the DB level: constraints, FKs, and the
-- append-only enforcement triggers actually reject what they claim to reject.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/smoke.sql
-- (see CLAUDE.md > Commands for the exact copy-paste invocation)
--
-- Harness rules (binding for every assertion appended by Tasks 3-9):
--
--   1. The WHOLE file runs inside one outer transaction that is ALWAYS rolled
--      back at the end (see BEGIN / ROLLBACK below) -- smoke never leaves data
--      behind and is safe to re-run against a live database.
--
--   2. POSITIVE assertions (a statement that must succeed / a state that must
--      hold): a plain DO block that RAISEs EXCEPTION when the condition fails.
--      Minimum one positive insert per table (round-trip: insert, then assert
--      the row reads back with the expected shape).
--
--   3. NEGATIVE assertions (a statement that must be REJECTED by a specific
--      constraint/trigger): an individual BEGIN ... EXCEPTION WHEN OTHERS THEN
--      sub-block per case (PL/pgSQL sub-blocks use implicit savepoint semantics --
--      a bare failing statement would abort the WHOLE outer transaction and stop
--      the rest of the suite; this pattern isolates it). Assert the EXACT
--      expected SQLSTATE, not just "it failed":
--        23505 = unique_violation      (dedup gates: identities, content_hash, ...)
--        23514 = check_violation       (status/value/XOR constraints)
--        23503 = foreign_key_violation (referencing a missing row)
--        P0001 = raise_exception       (custom trigger messages, e.g. forbid_mutation())
--      If the statement unexpectedly SUCCEEDS, the RAISE EXCEPTION written right
--      after it fires instead, is caught by the same WHEN OTHERS, and fails
--      loudly with a clear "succeeded but should not have" message -- a negative
--      case can never silently pass.
--
--   4. Every intended "no-op" dedup insert (idempotent retry / re-seed) carries
--      an explicit ON CONFLICT ... DO NOTHING and is asserted via a row COUNT
--      before/after, not via the negative-case pattern above (it is not an
--      error case -- there is no SQLSTATE to catch).
--
--   5. Append order mirrors schema.sql: registries (Task 3) -> identity core
--      (Task 4) -> funnel (Task 5) -> evidence ledger (Task 6) -> intelligence
--      (Task 7) -> interview/experience/ops (Task 8) -> enforcement layer
--      (Task 9, the append-only + purge_founder cases).
--
-- ============================================================================
-- WORKED EXAMPLE (negative case) -- copy/adapt this exact shape for every
-- SQLSTATE assertion in Tasks 3-9. This one documents the real Task 4 dedup
-- case, founder_identities UNIQUE(kind, value):
--
--   DO $$
--   BEGIN
--     BEGIN
--       INSERT INTO founder_identities (founder_id, kind, value)
--       VALUES ('<same founder_id from a prior insert in this file>', 'github', 'octocat');
--       -- if we get here, the duplicate was NOT rejected -> test must fail
--       RAISE EXCEPTION 'smoke FAIL: duplicate (kind,value) identity was accepted, expected 23505';
--     EXCEPTION WHEN OTHERS THEN
--       IF SQLSTATE <> '23505' THEN
--         RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (unique_violation), got % (%)', SQLSTATE, SQLERRM;
--       END IF;
--       -- expected failure confirmed, fall through and continue the suite
--     END;
--   END $$;
--
-- WORKED EXAMPLE (positive case) -- same table:
--
--   DO $$
--   DECLARE
--     v_count int;
--   BEGIN
--     SELECT count(*) INTO v_count FROM founder_identities WHERE kind = 'github' AND value = 'octocat';
--     IF v_count <> 1 THEN
--       RAISE EXCEPTION 'smoke FAIL: expected exactly 1 github/octocat identity, got %', v_count;
--     END IF;
--   END $$;
-- ============================================================================

BEGIN;

-- Self-check of the harness mechanics above, independent of the real schema
-- (passes green even before Task 3 lands any DDL) -- proves the negative-case
-- pattern itself is sound. Safe regardless of the real schema state: lives
-- entirely inside a TEMP TABLE and this transaction, gone at ROLLBACK.
DO $$
BEGIN
  CREATE TEMP TABLE _smoke_harness_check (
    id int PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO _smoke_harness_check (id) VALUES (1);

  -- positive assertion
  IF (SELECT count(*) FROM _smoke_harness_check) <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: harness self-check positive assertion did not hold';
  END IF;

  -- negative assertion: duplicate PK must be rejected with 23505
  BEGIN
    INSERT INTO _smoke_harness_check (id) VALUES (1);
    RAISE EXCEPTION 'smoke FAIL: harness self-check duplicate PK was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: harness self-check expected SQLSTATE 23505, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- ============================================================================
-- Task 3: Registries + seeds -- assertions
-- ============================================================================

-- Positive: all 4 registries queryable with seed rows.
DO $$
DECLARE
  v_score_axes      int;
  v_signal_sources  int;
  v_card_types      int;
  v_metric_kinds    int;
BEGIN
  SELECT count(*) INTO v_score_axes     FROM score_axes;
  SELECT count(*) INTO v_signal_sources FROM signal_sources;
  SELECT count(*) INTO v_card_types     FROM card_types;
  SELECT count(*) INTO v_metric_kinds   FROM metric_kinds;

  IF v_score_axes <> 5 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 5 score_axes seed rows, got %', v_score_axes;
  END IF;
  IF v_signal_sources <> 6 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 6 signal_sources seed rows, got %', v_signal_sources;
  END IF;
  IF v_card_types <> 3 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 3 card_types seed rows, got %', v_card_types;
  END IF;
  IF v_metric_kinds < 5 THEN
    RAISE EXCEPTION 'smoke FAIL: expected at least 5 metric_kinds seed rows, got %', v_metric_kinds;
  END IF;
END $$;

-- Non-collapse guard (M4) -- reconciled honestly again, independently, in the
-- Task 12 QA report: this only proves the SEED contains no aggregate axis, it
-- cannot stop someone INSERTing one later (axis registry is INSERT-extensible
-- by design). Collapse can only happen at render time, not here.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM score_axes WHERE slug IN ('overall', 'total', 'combined');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: an aggregate score axis is seeded (REQ-002 collapse risk): %', v_count;
  END IF;
END $$;

-- ============================================================================
-- Task 4: Identity core -- assertions
-- ============================================================================

-- Fixtures: one founder + one company, linked, with a GitHub identity.
DO $$
BEGIN
  INSERT INTO founders (id, full_name, headline, location_city, location_country)
  VALUES ('00000000-0000-0000-0000-000000000401', 'Ada Lovelace', 'Systems programmer', 'Berlin', 'Germany');

  INSERT INTO companies (id, name, one_liner, category, stage)
  VALUES ('00000000-0000-0000-0000-000000000402', 'Analytical Engines Inc', 'AI infra for VCs', 'ai_infra', 'pre_seed');

  INSERT INTO founder_identities (founder_id, kind, value, url)
  VALUES ('00000000-0000-0000-0000-000000000401', 'github', 'ada-lovelace-01', 'https://github.com/ada-lovelace-01');

  INSERT INTO founder_company (founder_id, company_id, role, is_current)
  VALUES ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402', 'founder', true);
END $$;

-- Positive: round-trip readback + search_tsv populated for a named founder AND
-- a named company (M1 FTS scope).
DO $$
DECLARE
  v_founder_count int;
  v_company_count int;
  v_link_count    int;
BEGIN
  SELECT count(*) INTO v_founder_count FROM founders
    WHERE id = '00000000-0000-0000-0000-000000000401' AND search_tsv IS NOT NULL;
  SELECT count(*) INTO v_company_count FROM companies
    WHERE id = '00000000-0000-0000-0000-000000000402' AND search_tsv IS NOT NULL;
  SELECT count(*) INTO v_link_count FROM founder_company
    WHERE founder_id = '00000000-0000-0000-0000-000000000401'
      AND company_id = '00000000-0000-0000-0000-000000000402';

  IF v_founder_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: founder round-trip / search_tsv failed, got %', v_founder_count;
  END IF;
  IF v_company_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: company round-trip / search_tsv failed, got %', v_company_count;
  END IF;
  IF v_link_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: founder_company round-trip failed, got %', v_link_count;
  END IF;
END $$;

-- Negative: duplicate (kind, value) identity -> 23505 (the DB-level dedup gate
-- -- re-ingesting the same GitHub login cannot create a second person).
DO $$
BEGIN
  BEGIN
    INSERT INTO founder_identities (founder_id, kind, value)
    VALUES ('00000000-0000-0000-0000-000000000401', 'github', 'ada-lovelace-01');
    RAISE EXCEPTION 'smoke FAIL: duplicate (kind,value) identity was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (unique_violation) on duplicate identity, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: companies.stage outside the early-stage vocabulary -> 23514.
DO $$
BEGIN
  BEGIN
    INSERT INTO companies (name, stage) VALUES ('Late Stage Co', 'series_a');
    RAISE EXCEPTION 'smoke FAIL: companies.stage=series_a was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on companies.stage, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: duplicate founder_company pair -> 23505.
DO $$
BEGIN
  BEGIN
    INSERT INTO founder_company (founder_id, company_id, role, is_current)
    VALUES ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402', 'cofounder', true);
    RAISE EXCEPTION 'smoke FAIL: duplicate founder_company pair was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (unique_violation) on founder_company dup pair, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- ============================================================================
-- Task 5: Funnel -- assertions
-- ============================================================================

-- Minimal intake (REQ-008): only company_id + kind + deck_storage_path supplied,
-- thesis_id left NULL. kind stays NOT NULL (always system-known at ingest time,
-- not part of the human-facing minimal-input surface) -- the nullable field
-- this proves is thesis_id.
DO $$
BEGIN
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
  VALUES (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000402',
    'inbound',
    's3://decks/ada-lovelace-app-1.pdf'
  );
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM applications
    WHERE id = '00000000-0000-0000-0000-000000000501'
      AND thesis_id IS NULL
      AND status = 'sourced';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: minimal-intake application (thesis_id NULL, default status) did not round-trip, got %', v_count;
  END IF;
END $$;

-- Re-application: a second row for the SAME company must succeed -- the
-- rejection -> growth -> return trajectory is preserved for free (SIG-025).
DO $$
BEGIN
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
  VALUES (
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000402',
    'inbound',
    's3://decks/ada-lovelace-app-2.pdf'
  );
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM applications WHERE company_id = '00000000-0000-0000-0000-000000000402';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 2 applications (re-application trajectory) for the fixture company, got %', v_count;
  END IF;
END $$;

-- Negative: invalid status -> 23514.
DO $$
BEGIN
  BEGIN
    INSERT INTO applications (company_id, kind, deck_storage_path, status)
    VALUES ('00000000-0000-0000-0000-000000000402', 'inbound', 's3://decks/bad-status.pdf', 'not_a_real_status');
    RAISE EXCEPTION 'smoke FAIL: applications.status=not_a_real_status was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on applications.status, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- ============================================================================
-- Task 6: Evidence ledger -- assertions appended below
-- ============================================================================

-- ============================================================================
-- Task 7: Intelligence -- assertions appended below
-- ============================================================================

-- ============================================================================
-- Task 8: Interview, experience & ops -- assertions appended below
-- ============================================================================

-- ============================================================================
-- Task 9: Enforcement layer -- assertions appended below
-- ============================================================================

ROLLBACK;
