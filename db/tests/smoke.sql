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
--
-- Registries are extensible by INSERT, never by migration (feature 01
-- design.md SS4.1) -- score_axes, signal_sources and card_types are all
-- expected to grow across later features (e.g. 05/06 adding axes, 02/08/11
-- adding signal sources) without any schema change. An exact-count assertion
-- would re-break on every such INSERT (it already did: feature 04 adding
-- tavily_search/tavily_news tripped `signal_sources <> 6`), so these three
-- check presence of the canonical seed vocabulary PLUS a floor (>=) -- same
-- style already used below for metric_kinds. Do not tighten back to `<>`.
DO $$
DECLARE
  v_score_axes      int;
  v_signal_sources  int;
  v_card_types      int;
  v_metric_kinds    int;
  v_missing         text[];
BEGIN
  SELECT count(*) INTO v_score_axes     FROM score_axes;
  SELECT count(*) INTO v_signal_sources FROM signal_sources;
  SELECT count(*) INTO v_card_types     FROM card_types;
  SELECT count(*) INTO v_metric_kinds   FROM metric_kinds;

  SELECT array_agg(expected.slug) INTO v_missing
  FROM unnest(ARRAY['founder', 'market', 'idea_vs_market', 'trust', 'founder_score']) AS expected(slug)
  WHERE expected.slug NOT IN (SELECT slug FROM score_axes);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: score_axes missing canonical slug(s): %', v_missing;
  END IF;
  IF v_score_axes < 5 THEN
    RAISE EXCEPTION 'smoke FAIL: expected at least 5 score_axes seed rows, got %', v_score_axes;
  END IF;

  SELECT array_agg(expected.slug) INTO v_missing
  FROM unnest(ARRAY['github_api', 'hn_algolia', 'tavily_extract', 'deck_parse', 'interview_answer', 'manual']) AS expected(slug)
  WHERE expected.slug NOT IN (SELECT slug FROM signal_sources);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: signal_sources missing canonical slug(s): %', v_missing;
  END IF;
  IF v_signal_sources < 6 THEN
    RAISE EXCEPTION 'smoke FAIL: expected at least 6 signal_sources seed rows, got %', v_signal_sources;
  END IF;

  SELECT array_agg(expected.slug) INTO v_missing
  FROM unnest(ARRAY['company', 'founder', 'team']) AS expected(slug)
  WHERE expected.slug NOT IN (SELECT slug FROM card_types);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: card_types missing canonical slug(s): %', v_missing;
  END IF;
  IF v_card_types < 3 THEN
    RAISE EXCEPTION 'smoke FAIL: expected at least 3 card_types seed rows, got %', v_card_types;
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

-- Deck requirement is inbound-only (SS4.3 addendum): radar_activated rows are
-- deckless by definition.
DO $$
BEGIN
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
  VALUES (
    '00000000-0000-0000-0000-000000000503',
    '00000000-0000-0000-0000-000000000402',
    'radar_activated',
    NULL
  );
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM applications
    WHERE id = '00000000-0000-0000-0000-000000000503' AND deck_storage_path IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_activated application with NULL deck did not insert, got %', v_count;
  END IF;
END $$;

-- Negative: inbound with NULL deck -> 23514 (the REQ-008 floor still holds for inbound).
DO $$
BEGIN
  BEGIN
    INSERT INTO applications (company_id, kind, deck_storage_path)
    VALUES ('00000000-0000-0000-0000-000000000402', 'inbound', NULL);
    RAISE EXCEPTION 'smoke FAIL: inbound application with NULL deck was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on inbound NULL deck, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- ============================================================================
-- Task 6: Evidence ledger -- assertions
-- ============================================================================

-- Fixtures: full provenance chain (raw_signal -> card -> claims -> evidence),
-- incl. a 'missing' claim (REQ-004) and a supersedes_claim_id chain of 2 rows.
DO $$
BEGIN
  INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at)
  VALUES (
    '00000000-0000-0000-0000-000000000601', 'github_api', 'https://api.github.com/users/ada-lovelace-01',
    '{"login": "ada-lovelace-01", "public_repos": 12}'::jsonb, 'rs-0601-hash',
    '00000000-0000-0000-0000-000000000401', now()
  );

  INSERT INTO cards (id, card_type, founder_id, status)
  VALUES ('00000000-0000-0000-0000-000000000602', 'founder', '00000000-0000-0000-0000-000000000401', 'prefilled');

  -- Verified claim, sourced from the raw_signal above.
  INSERT INTO claims (id, card_id, topic, text_verbatim, axis, source_kind, verification_status, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000602',
    'founder.domain_expertise', 'Merged 40 PRs into kubernetes/kubernetes over 3 years.',
    'founder', 'public', 'verified', 'claim-0603-hash'
  );

  -- A gap is a first-class row, not a fabricated negative (REQ-004).
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind, verification_status)
  VALUES (
    '00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000602',
    'round.cap_table', 'Cap table: not disclosed.', 'derived', 'missing'
  );

  -- supersedes_claim_id chain of 2 rows: 0606 is the original, 0607 corrects it.
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind, verification_status)
  VALUES (
    '00000000-0000-0000-0000-000000000606', '00000000-0000-0000-0000-000000000602',
    'traction.users', '500 users as of last month.', 'self_reported', 'unverified'
  );
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind, verification_status, supersedes_claim_id)
  VALUES (
    '00000000-0000-0000-0000-000000000607', '00000000-0000-0000-0000-000000000602',
    'traction.users', '5,000 users as of last month (corrected).', 'self_reported', 'unverified',
    '00000000-0000-0000-0000-000000000606'
  );

  -- Evidence: a supports row tracing to the raw_signal, and a contradicts row.
  INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000608', '00000000-0000-0000-0000-000000000603',
    'supports', 'documented', 'merged 40 PRs', '00000000-0000-0000-0000-000000000601', 'ev-0608-hash'
  );
  INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000609', '00000000-0000-0000-0000-000000000603',
    'contradicts', 'discovered', 'profile says 15 PRs, not 40', 'ev-0609-hash'
  );
END $$;

-- Positive: full chain readback -- raw_signal -> claim -> evidence referencing it.
DO $$
DECLARE
  v_chain_count int;
BEGIN
  SELECT count(*) INTO v_chain_count
  FROM evidence e
  JOIN claims c ON c.id = e.claim_id
  JOIN raw_signals rs ON rs.id = e.raw_signal_id
  WHERE e.id = '00000000-0000-0000-0000-000000000608'
    AND c.id = '00000000-0000-0000-0000-000000000603'
    AND rs.id = '00000000-0000-0000-0000-000000000601';
  IF v_chain_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: raw_signal -> claim -> evidence provenance chain did not round-trip, got %', v_chain_count;
  END IF;
END $$;

-- Positive: a 'missing' claim is a first-class row (REQ-004), not absent data.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM claims
    WHERE id = '00000000-0000-0000-0000-000000000604' AND verification_status = 'missing';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: missing-status claim did not round-trip, got %', v_count;
  END IF;
END $$;

-- Positive: supersedes_claim_id chain of 2 rows.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM claims
    WHERE id = '00000000-0000-0000-0000-000000000607'
      AND supersedes_claim_id = '00000000-0000-0000-0000-000000000606';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: supersedes_claim_id chain did not round-trip, got %', v_count;
  END IF;
END $$;

-- Positive: a contradicts row lands (a contradiction is data, not a flag).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM evidence
    WHERE id = '00000000-0000-0000-0000-000000000609' AND relation = 'contradicts';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: contradicts evidence row did not round-trip, got %', v_count;
  END IF;
END $$;

-- No-op: duplicate raw_signals.content_hash with explicit ON CONFLICT DO NOTHING
-- (idempotent retries) -> row count unchanged.
DO $$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  SELECT count(*) INTO v_before FROM raw_signals WHERE content_hash = 'rs-0601-hash';

  INSERT INTO raw_signals (source, source_url, payload, content_hash, founder_id, observed_at)
  VALUES (
    'github_api', 'https://api.github.com/users/ada-lovelace-01',
    '{"login": "ada-lovelace-01", "public_repos": 12}'::jsonb, 'rs-0601-hash',
    '00000000-0000-0000-0000-000000000401', now()
  )
  ON CONFLICT (content_hash) DO NOTHING;

  SELECT count(*) INTO v_after FROM raw_signals WHERE content_hash = 'rs-0601-hash';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'smoke FAIL: duplicate raw_signals.content_hash retry was not a no-op (% -> %)', v_before, v_after;
  END IF;
END $$;

-- No-op: duplicate evidence.content_hash with explicit ON CONFLICT DO NOTHING
-- (retried truth-gap workflow cannot double-insert and skew per-claim trust).
DO $$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  SELECT count(*) INTO v_before FROM evidence WHERE content_hash = 'ev-0609-hash';

  INSERT INTO evidence (claim_id, relation, tier, quote_verbatim, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000603', 'contradicts', 'discovered',
    'profile says 15 PRs, not 40', 'ev-0609-hash'
  )
  ON CONFLICT (content_hash) DO NOTHING;

  SELECT count(*) INTO v_after FROM evidence WHERE content_hash = 'ev-0609-hash';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'smoke FAIL: duplicate evidence.content_hash retry was not a no-op (% -> %)', v_before, v_after;
  END IF;
END $$;

-- ============================================================================
-- Task 7: Intelligence -- assertions
-- ============================================================================

-- Negative: BOTH founder_id and application_id set -> 23514 (XOR CHECK).
DO $$
BEGIN
  BEGIN
    INSERT INTO scores (founder_id, application_id, axis, value)
    VALUES (
      '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000501',
      'founder', 50
    );
    RAISE EXCEPTION 'smoke FAIL: scores with BOTH founder_id and application_id set was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on scores XOR (both set), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: NEITHER founder_id nor application_id set -> 23514 (XOR is two-sided, m1).
DO $$
BEGIN
  BEGIN
    INSERT INTO scores (axis, value) VALUES ('founder', 50);
    RAISE EXCEPTION 'smoke FAIL: scores with NEITHER subject set was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on scores XOR (neither set), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: value out of the 0-100 range -> 23514.
DO $$
BEGIN
  BEGIN
    INSERT INTO scores (founder_id, axis, value) VALUES ('00000000-0000-0000-0000-000000000401', 'founder', 150);
    RAISE EXCEPTION 'smoke FAIL: scores.value=150 was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on scores.value out of range, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Positive: two sequential founder_score rows for one founder insert fine
-- (append-only versioning) and max(computed_at) is the current one.
DO $$
BEGIN
  INSERT INTO scores (id, founder_id, axis, value, confidence, computed_at)
  VALUES ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000401', 'founder_score', 40, 0.50, now() - interval '1 day');

  INSERT INTO scores (id, founder_id, axis, value, confidence, computed_at)
  VALUES ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000401', 'founder_score', 55, 0.70, now());
END $$;

DO $$
DECLARE
  v_row_count    int;
  v_current_id   uuid;
BEGIN
  SELECT count(*) INTO v_row_count FROM scores
    WHERE founder_id = '00000000-0000-0000-0000-000000000401' AND axis = 'founder_score';
  IF v_row_count <> 2 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 2 append-only founder_score rows, got %', v_row_count;
  END IF;

  SELECT id INTO v_current_id FROM scores
    WHERE founder_id = '00000000-0000-0000-0000-000000000401' AND axis = 'founder_score'
    ORDER BY computed_at DESC LIMIT 1;
  IF v_current_id <> '00000000-0000-0000-0000-000000000702' THEN
    RAISE EXCEPTION 'smoke FAIL: max(computed_at) founder_score row is not the latest insert, got %', v_current_id;
  END IF;
END $$;

-- Positive: ai_runs insert with a disagreement payload (multi-model divergence
-- preserved, never erased).
DO $$
BEGIN
  INSERT INTO ai_runs (id, task_type, founder_id, model, output_json, disagreement)
  VALUES (
    '00000000-0000-0000-0000-000000000703', 'scoring', '00000000-0000-0000-0000-000000000401',
    'gpt-5.6-sol', '{"axis": "founder_score", "value": 55}'::jsonb,
    '{"panel": [{"model": "gpt-5.6-sol", "value": 55}, {"model": "gpt-5.6-terra", "value": 40}]}'::jsonb
  );
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM ai_runs
    WHERE id = '00000000-0000-0000-0000-000000000703' AND disagreement IS NOT NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: ai_runs disagreement payload did not round-trip, got %', v_count;
  END IF;
END $$;

-- ============================================================================
-- Task 8: Interview, experience & ops -- assertions
-- ============================================================================

-- Fixtures: one row in each of interviews, voice_artifacts, memos (valid),
-- watchlist, metric_observations, events.
DO $$
BEGIN
  INSERT INTO interviews (id, application_id, kind, status)
  VALUES ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000501', 'first', 'pending');

  INSERT INTO voice_artifacts (id, interview_id, question_ref, storage_path, duration_sec)
  VALUES ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000801', 'q1', 's3://voice/ada-q1.wav', 42);

  INSERT INTO memos (id, application_id, version, sections, recommendation)
  VALUES (
    '00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-000000000501', 1,
    '{"snapshot": "Analytical Engines Inc, pre-seed.", "hypotheses": ["strong technical founder"], "swot": {"strengths": ["deep OSS track record"]}, "problem_product": "AI infra for VCs.", "traction": "early users, unverified"}'::jsonb,
    -- Investment-committee vocabulary (db/schema.sql memos_recommendation_check,
    -- operator decision 2026-07-19): 'watch' was retired to 'watchlist'.
    'watchlist'
  );

  INSERT INTO watchlist (id, founder_id, reason, active)
  VALUES ('00000000-0000-0000-0000-000000000804', '00000000-0000-0000-0000-000000000401', 'declined this round, revisit next milestone', true);

  INSERT INTO metric_observations (id, metric, founder_id, value, observed_at)
  VALUES ('00000000-0000-0000-0000-000000000805', 'gh_stars', '00000000-0000-0000-0000-000000000401', 120, '2026-07-01T00:00:00Z');

  INSERT INTO events (id, event_type, entity_type, entity_id, actor)
  VALUES ('00000000-0000-0000-0000-000000000806', 'application_created', 'application', '00000000-0000-0000-0000-000000000501', 'n8n:intake-workflow');
END $$;

-- Positive: round-trip readback for all 6 fixtures above.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM interviews WHERE id = '00000000-0000-0000-0000-000000000801';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: interviews fixture did not round-trip, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM voice_artifacts WHERE id = '00000000-0000-0000-0000-000000000802';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: voice_artifacts fixture did not round-trip, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM memos WHERE id = '00000000-0000-0000-0000-000000000803';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: memos fixture did not round-trip, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM watchlist WHERE id = '00000000-0000-0000-0000-000000000804';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: watchlist fixture did not round-trip, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM metric_observations WHERE id = '00000000-0000-0000-0000-000000000805';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: metric_observations fixture did not round-trip, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM events WHERE id = '00000000-0000-0000-0000-000000000806';
  IF v_count <> 1 THEN RAISE EXCEPTION 'smoke FAIL: events fixture did not round-trip, got %', v_count; END IF;
END $$;

-- Negative: memo missing the 'swot' key in sections -> 23514 (?& CHECK).
DO $$
BEGIN
  BEGIN
    INSERT INTO memos (application_id, version, sections)
    VALUES (
      '00000000-0000-0000-0000-000000000501', 2,
      '{"snapshot": "...", "hypotheses": "...", "problem_product": "...", "traction": "..."}'::jsonb
    );
    RAISE EXCEPTION 'smoke FAIL: memo missing the swot key was accepted, expected 23514';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23514 (check_violation) on memos.sections missing swot, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: duplicate (application_id, version) -> 23505.
DO $$
BEGIN
  BEGIN
    INSERT INTO memos (application_id, version, sections)
    VALUES (
      '00000000-0000-0000-0000-000000000501', 1,
      '{"snapshot": "...", "hypotheses": "...", "swot": "...", "problem_product": "...", "traction": "..."}'::jsonb
    );
    RAISE EXCEPTION 'smoke FAIL: duplicate (application_id, version) memo was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (unique_violation) on duplicate memo version, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Positive: interview status transition pending -> abandoned via UPDATE
-- succeeds (interviews is a mutable table, not in the append-only set).
DO $$
DECLARE
  v_status text;
BEGIN
  UPDATE interviews SET status = 'abandoned' WHERE id = '00000000-0000-0000-0000-000000000801';

  SELECT status INTO v_status FROM interviews WHERE id = '00000000-0000-0000-0000-000000000801';
  IF v_status <> 'abandoned' THEN
    RAISE EXCEPTION 'smoke FAIL: interviews pending->abandoned UPDATE did not stick, got %', v_status;
  END IF;
END $$;

-- No-op: duplicate metric_observation (same metric/subject/observed_at, NULLS
-- NOT DISTINCT) with explicit ON CONFLICT DO NOTHING -> row count unchanged.
DO $$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  SELECT count(*) INTO v_before FROM metric_observations
    WHERE metric = 'gh_stars' AND founder_id = '00000000-0000-0000-0000-000000000401'
      AND observed_at = '2026-07-01T00:00:00Z';

  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
  VALUES ('gh_stars', '00000000-0000-0000-0000-000000000401', 120, '2026-07-01T00:00:00Z')
  ON CONFLICT (metric, founder_id, company_id, observed_at) DO NOTHING;

  SELECT count(*) INTO v_after FROM metric_observations
    WHERE metric = 'gh_stars' AND founder_id = '00000000-0000-0000-0000-000000000401'
      AND observed_at = '2026-07-01T00:00:00Z';

  IF v_after <> v_before THEN
    RAISE EXCEPTION 'smoke FAIL: duplicate metric_observation retry was not a no-op (% -> %)', v_before, v_after;
  END IF;
END $$;

-- ============================================================================
-- Task 9: Enforcement layer -- assertions
-- ============================================================================

-- Fixtures for the append-only UPDATE/DELETE attacks below.
DO $$
BEGIN
  INSERT INTO scores (id, founder_id, axis, value)
  VALUES ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000401', 'founder', 50);

  INSERT INTO raw_signals (id, source, content_hash, founder_id, observed_at)
  VALUES ('00000000-0000-0000-0000-000000000902', 'manual', 'rs-0902-hash', '00000000-0000-0000-0000-000000000401', now());
END $$;

-- Negative: plain UPDATE on scores (append-only) -> P0001.
DO $$
BEGIN
  BEGIN
    UPDATE scores SET value = 99 WHERE id = '00000000-0000-0000-0000-000000000901';
    RAISE EXCEPTION 'smoke FAIL: UPDATE on scores (append-only) succeeded, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (append-only guard) on scores UPDATE, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: DELETE on raw_signals (append-only) -> P0001.
DO $$
BEGIN
  BEGIN
    DELETE FROM raw_signals WHERE id = '00000000-0000-0000-0000-000000000902';
    RAISE EXCEPTION 'smoke FAIL: DELETE on raw_signals (append-only) succeeded, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (append-only guard) on raw_signals DELETE, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- The real R1 attack: a non-owner session (service_role, the key PostgREST
-- would present at the API surface) forges the purge GUC and tries to sneak
-- an UPDATE through. Must STILL be blocked -- the GUC is USERSET (any
-- session can SET it), but forbid_mutation() also requires current_user to
-- be the purge_founder owner, which a non-superuser session can never
-- become. SET ROLE / SET here are session-level but transactional -- undone
-- by this file's final ROLLBACK regardless of the explicit RESETs below.
SET ROLE service_role;
SET vcbrain.purging = 'on';
DO $$
BEGIN
  BEGIN
    UPDATE scores SET value = 99 WHERE id = '00000000-0000-0000-0000-000000000901';
    RAISE EXCEPTION 'smoke FAIL: R1 attack succeeded -- forged GUC bypassed the append-only guard under service_role';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 on the R1 GUC-forge attack, got % (%)', SQLSTATE, SQLERRM;
    END IF;
    IF current_user <> 'service_role' THEN
      RAISE EXCEPTION 'smoke FAIL: R1 attack block did not actually run as service_role (current_user=%)', current_user;
    END IF;
  END;
END $$;
RESET ROLE;
RESET vcbrain.purging;

-- TRUNCATE bypass fix (QA gate Task 12 finding): BEFORE UPDATE OR DELETE
-- triggers never fire on TRUNCATE, and Supabase's schema-wide default
-- privileges grant TRUNCATE to anon/authenticated/service_role on every
-- table at creation time. Assert the grant is actually gone, then assert an
-- attempted TRUNCATE as service_role is rejected at the privilege level
-- (42501) -- before forbid_mutation() would even get a chance to run.
--
-- Table list extended by features 03 and 07 (score_components,
-- score_formulas, thesis_evaluations) as each added its own REVOKE TRUNCATE
-- statement in schema.sql -- score_formulas is included even though it is
-- NOT forbid_mutation-guarded (db/README.md > "Append-only tables": the
-- TRUNCATE grant is schema-wide at CREATE TABLE time regardless of whether a
-- given table is append-only, so it still needs the revoke).
DO $$
DECLARE
  v_grant_count int;
BEGIN
  SELECT count(*) INTO v_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('scores', 'raw_signals', 'evidence', 'ai_runs', 'events', 'memos',
                        'score_components', 'score_formulas', 'thesis_evaluations')
    AND grantee IN ('anon', 'authenticated', 'service_role')
    AND privilege_type = 'TRUNCATE';

  IF v_grant_count <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 0 TRUNCATE grants to anon/authenticated/service_role on the 9 append-only(-adjacent) tables, found %', v_grant_count;
  END IF;
END $$;

SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    TRUNCATE scores;
    RAISE EXCEPTION 'smoke FAIL: TRUNCATE scores succeeded as service_role, expected 42501 permission denied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 42501 (insufficient_privilege) on TRUNCATE scores as service_role, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;

-- Feature 03/07 direct proof, same mechanism, on the two NEW append-only
-- tables (not just the registry-grant check above).
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    TRUNCATE score_components;
    RAISE EXCEPTION 'smoke FAIL: TRUNCATE score_components succeeded as service_role, expected 42501 permission denied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 42501 (insufficient_privilege) on TRUNCATE score_components as service_role, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    TRUNCATE thesis_evaluations;
    RAISE EXCEPTION 'smoke FAIL: TRUNCATE thesis_evaluations succeeded as service_role, expected 42501 permission denied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 42501 (insufficient_privilege) on TRUNCATE thesis_evaluations as service_role, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;

-- purge_founder(): the exhaustive fixture -- a sole-founder company with a
-- full application/interview/voice_artifact/memo chain, a merged-duplicate
-- tombstone founder with its own founder_identities row and score, a
-- founder-subject AND a company-linked card+claim, and the cross-subtree
-- link the plan calls out explicitly: founder-subject evidence referencing a
-- company-scoped raw_signal (the delete-order hazard).
DO $$
BEGIN
  -- Primary founder + tombstone duplicate (merged into primary).
  INSERT INTO founders (id, full_name)
    VALUES ('00000000-0000-0000-0000-000000000910', 'Purge Fixture Founder');
  INSERT INTO founders (id, full_name, merged_into_founder_id)
    VALUES ('00000000-0000-0000-0000-000000000911', 'Purge Fixture Founder (dup)', '00000000-0000-0000-0000-000000000910');
  INSERT INTO founder_identities (founder_id, kind, value)
    VALUES ('00000000-0000-0000-0000-000000000911', 'github', 'purge-fixture-dup');

  -- Sole-founder company + full application/interview/voice/memo chain.
  INSERT INTO companies (id, name, stage)
    VALUES ('00000000-0000-0000-0000-000000000912', 'Purge Fixture Co', 'pre_seed');
  INSERT INTO founder_company (founder_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-000000000910', '00000000-0000-0000-0000-000000000912', 'founder');
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
    VALUES ('00000000-0000-0000-0000-000000000913', '00000000-0000-0000-0000-000000000912', 'inbound', 's3://decks/purge-fixture.pdf');
  INSERT INTO interviews (id, application_id, kind)
    VALUES ('00000000-0000-0000-0000-000000000914', '00000000-0000-0000-0000-000000000913', 'first');
  INSERT INTO voice_artifacts (id, interview_id, storage_path)
    VALUES ('00000000-0000-0000-0000-000000000915', '00000000-0000-0000-0000-000000000914', 's3://voice/purge-fixture.wav');
  INSERT INTO memos (id, application_id, version, sections)
    VALUES ('00000000-0000-0000-0000-000000000916', '00000000-0000-0000-0000-000000000913', 1,
      '{"snapshot":"x","hypotheses":"x","swot":"x","problem_product":"x","traction":"x"}'::jsonb);

  -- Founder-subject card + company-linked card.
  INSERT INTO cards (id, card_type, founder_id)
    VALUES ('00000000-0000-0000-0000-000000000917', 'founder', '00000000-0000-0000-0000-000000000910');
  INSERT INTO cards (id, card_type, company_id)
    VALUES ('00000000-0000-0000-0000-000000000918', 'company', '00000000-0000-0000-0000-000000000912');
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
    VALUES ('00000000-0000-0000-0000-000000000919', '00000000-0000-0000-0000-000000000917', 'founder.x', 'x', 'public');
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
    VALUES ('00000000-0000-0000-0000-000000000920', '00000000-0000-0000-0000-000000000918', 'company.x', 'x', 'public');

  -- Company-scoped raw_signal.
  INSERT INTO raw_signals (id, source, content_hash, company_id, observed_at)
    VALUES ('00000000-0000-0000-0000-000000000921', 'manual', 'purge-fixture-rs-hash', '00000000-0000-0000-0000-000000000912', now());

  -- Cross-subtree link: founder-subject claim's evidence -> company-scoped raw_signal.
  INSERT INTO evidence (id, claim_id, relation, tier, raw_signal_id, content_hash)
    VALUES ('00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000919', 'supports', 'documented',
      '00000000-0000-0000-0000-000000000921', 'purge-fixture-ev-hash');

  -- Founder-direct + application-scoped scores, tombstone's own score.
  INSERT INTO scores (id, founder_id, axis, value)
    VALUES ('00000000-0000-0000-0000-000000000923', '00000000-0000-0000-0000-000000000910', 'founder_score', 70);
  INSERT INTO scores (id, application_id, axis, value)
    VALUES ('00000000-0000-0000-0000-000000000924', '00000000-0000-0000-0000-000000000913', 'trust', 80);
  INSERT INTO scores (id, founder_id, axis, value)
    VALUES ('00000000-0000-0000-0000-000000000925', '00000000-0000-0000-0000-000000000911', 'founder_score', 40);

  -- ai_runs, metric_observations (founder + company), watchlist, prior event.
  INSERT INTO ai_runs (id, task_type, founder_id, model)
    VALUES ('00000000-0000-0000-0000-000000000926', 'scoring', '00000000-0000-0000-0000-000000000910', 'test-model');
  INSERT INTO metric_observations (id, metric, founder_id, value, observed_at)
    VALUES ('00000000-0000-0000-0000-000000000927', 'gh_stars', '00000000-0000-0000-0000-000000000910', 10, now());
  INSERT INTO metric_observations (id, metric, company_id, value, observed_at)
    VALUES ('00000000-0000-0000-0000-000000000928', 'gh_stars', '00000000-0000-0000-0000-000000000912', 20, now());
  INSERT INTO watchlist (id, founder_id, reason)
    VALUES ('00000000-0000-0000-0000-000000000929', '00000000-0000-0000-0000-000000000910', 'purge fixture');
  INSERT INTO events (id, event_type, entity_type, entity_id)
    VALUES ('00000000-0000-0000-0000-000000000930', 'application_created', 'founder', '00000000-0000-0000-0000-000000000910');
END $$;

DO $$
BEGIN
  PERFORM purge_founder('00000000-0000-0000-0000-000000000910');
END $$;

-- Assert: zero founder-linked rows remain anywhere, except exactly one
-- anonymized audit event.
DO $$
DECLARE
  v_remaining    int;
  v_prior_event  int;
  v_anon_events  int;
BEGIN
  SELECT
    (SELECT count(*) FROM founders WHERE id IN ('00000000-0000-0000-0000-000000000910', '00000000-0000-0000-0000-000000000911')) +
    (SELECT count(*) FROM founder_identities WHERE founder_id = '00000000-0000-0000-0000-000000000911') +
    (SELECT count(*) FROM companies WHERE id = '00000000-0000-0000-0000-000000000912') +
    (SELECT count(*) FROM founder_company WHERE founder_id = '00000000-0000-0000-0000-000000000910') +
    (SELECT count(*) FROM applications WHERE id = '00000000-0000-0000-0000-000000000913') +
    (SELECT count(*) FROM interviews WHERE id = '00000000-0000-0000-0000-000000000914') +
    (SELECT count(*) FROM voice_artifacts WHERE id = '00000000-0000-0000-0000-000000000915') +
    (SELECT count(*) FROM memos WHERE id = '00000000-0000-0000-0000-000000000916') +
    (SELECT count(*) FROM cards WHERE id IN ('00000000-0000-0000-0000-000000000917', '00000000-0000-0000-0000-000000000918')) +
    (SELECT count(*) FROM claims WHERE id IN ('00000000-0000-0000-0000-000000000919', '00000000-0000-0000-0000-000000000920')) +
    (SELECT count(*) FROM raw_signals WHERE id = '00000000-0000-0000-0000-000000000921') +
    (SELECT count(*) FROM evidence WHERE id = '00000000-0000-0000-0000-000000000922') +
    (SELECT count(*) FROM scores WHERE id IN ('00000000-0000-0000-0000-000000000923', '00000000-0000-0000-0000-000000000924', '00000000-0000-0000-0000-000000000925')) +
    (SELECT count(*) FROM ai_runs WHERE id = '00000000-0000-0000-0000-000000000926') +
    (SELECT count(*) FROM metric_observations WHERE id IN ('00000000-0000-0000-0000-000000000927', '00000000-0000-0000-0000-000000000928')) +
    (SELECT count(*) FROM watchlist WHERE id = '00000000-0000-0000-0000-000000000929')
  INTO v_remaining;

  SELECT count(*) INTO v_prior_event FROM events WHERE id = '00000000-0000-0000-0000-000000000930';
  SELECT count(*) INTO v_anon_events FROM events
    WHERE event_type = 'founder_purged' AND entity_id = '00000000-0000-0000-0000-000000000910';

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: purge_founder left % founder-linked rows behind, expected 0', v_remaining;
  END IF;
  IF v_prior_event <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: purge_founder did not remove the prior audit event';
  END IF;
  IF v_anon_events <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: expected exactly 1 anonymized founder_purged event, got %', v_anon_events;
  END IF;
END $$;

-- Regression (found during feature 04, 2026-07-19): ai_runs.application_id
-- and .company_id are ON DELETE RESTRICT, but purge_founder() used to delete
-- applications/companies BEFORE touching ai_runs, and its ai_runs sweep only
-- matched founder_id = ANY(...) -- a row written with founder_id NULL (the
-- shape feature 04 onwards writes for application/company-scoped AI runs)
-- was never reached, so the applications delete above hit 23503. The
-- exhaustive fixture above never caught this because its own ai_runs row
-- has founder_id set. Minimal fixture: a second sole-founder
-- founder+company+application with one ai_runs row keyed by application_id,
-- founder_id NULL.
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('00000000-0000-0000-0000-000000000931', 'Purge Fixture Founder (ai_runs regression)');
  INSERT INTO companies (id, name, stage)
    VALUES ('00000000-0000-0000-0000-000000000932', 'Purge Fixture Co (ai_runs regression)', 'pre_seed');
  INSERT INTO founder_company (founder_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-000000000931', '00000000-0000-0000-0000-000000000932', 'founder');
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
    VALUES ('00000000-0000-0000-0000-000000000933', '00000000-0000-0000-0000-000000000932', 'inbound', 's3://decks/purge-fixture-ai-runs.pdf');
  INSERT INTO ai_runs (id, task_type, application_id, model)
    VALUES ('00000000-0000-0000-0000-000000000934', 'market_intel', '00000000-0000-0000-0000-000000000933', 'test-model');
END $$;

-- Uncaught on purpose: pre-fix, this call itself raises 23503 (the bug this
-- case exists to catch) and aborts the suite loudly -- that IS the
-- regression signal, not something to wrap in a sub-block.
DO $$
BEGIN
  PERFORM purge_founder('00000000-0000-0000-0000-000000000931');
END $$;

DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT
    (SELECT count(*) FROM founders WHERE id = '00000000-0000-0000-0000-000000000931') +
    (SELECT count(*) FROM companies WHERE id = '00000000-0000-0000-0000-000000000932') +
    (SELECT count(*) FROM applications WHERE id = '00000000-0000-0000-0000-000000000933') +
    (SELECT count(*) FROM ai_runs WHERE id = '00000000-0000-0000-0000-000000000934')
  INTO v_remaining;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: purge_founder left % row(s) behind for the application-scoped ai_runs regression fixture, expected 0', v_remaining;
  END IF;
END $$;

-- ============================================================================
-- Feature 03 (founder score) -- score_formulas + score_components assertions.
-- docs/backlog/03-founder-score/design.md SS4.2. Id range 0935-0946.
-- ============================================================================

-- Fixture: two score_components rows off the existing Ada Lovelace
-- founder_score score (id ...0701, Task 7 above) -- one normal met row tied
-- to that score, one score_id IS NULL row from a DIFFERENT run (the
-- insufficient_evidence branch, design.md SS2.4: coverage fell under
-- min_coverage on that run and no scores row was ever written for it, but
-- the criterion breakdown that got that far is kept).
DO $$
BEGIN
  INSERT INTO score_components (id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, credit, contribution, evidence_tier, claim_ids, quote_verbatim, rationale)
  VALUES (
    '00000000-0000-0000-0000-000000000935', '00000000-0000-0000-0000-000000000701',
    '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000936',
    'execution-signals', 'E1', 'met', 0.10000, 1.00, 10.00000, 'documented',
    ARRAY['00000000-0000-0000-0000-000000000603']::uuid[],
    'Merged 40 PRs into kubernetes/kubernetes over 3 years.', 'Clear external merged-PR evidence.'
  );

  INSERT INTO score_components (id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, what_would_close_it)
  VALUES (
    '00000000-0000-0000-0000-000000000937', NULL,
    '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000938',
    'execution-signals', 'E1', 'cannot_assess', 0.10000,
    'A merged pull request into a repository the founder does not own.'
  );
END $$;

-- Positive: both rows round-trip, including the score_id IS NULL row.
DO $$
DECLARE
  v_linked_count int;
  v_null_count   int;
BEGIN
  SELECT count(*) INTO v_linked_count FROM score_components
    WHERE id = '00000000-0000-0000-0000-000000000935' AND score_id = '00000000-0000-0000-0000-000000000701';
  SELECT count(*) INTO v_null_count FROM score_components
    WHERE id = '00000000-0000-0000-0000-000000000937' AND score_id IS NULL AND verdict = 'cannot_assess';

  IF v_linked_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: score_components row linked to a scores row did not round-trip, got %', v_linked_count;
  END IF;
  IF v_null_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: score_components insufficient_evidence row (score_id NULL) did not round-trip, got %', v_null_count;
  END IF;
END $$;

-- Negative: duplicate (run_id, criterion_id) -> 23505.
DO $$
BEGIN
  BEGIN
    INSERT INTO score_components (score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight)
    VALUES (
      '00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000401',
      '00000000-0000-0000-0000-000000000936', 'execution-signals', 'E1', 'met', 0.10000
    );
    RAISE EXCEPTION 'smoke FAIL: duplicate (run_id, criterion_id) score_components row was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (unique_violation) on score_components dup (run_id,criterion_id), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: plain UPDATE on score_components (append-only) -> P0001.
DO $$
BEGIN
  BEGIN
    UPDATE score_components SET verdict = 'not_met' WHERE id = '00000000-0000-0000-0000-000000000935';
    RAISE EXCEPTION 'smoke FAIL: UPDATE on score_components (append-only) succeeded, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (append-only guard) on score_components UPDATE, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: a second active score_formulas row for an axis that already has
-- one (uq_score_formulas_active_axis) -> 23505. founder_score's active row
-- ships in db/seed.sql (version='formula_v1').
DO $$
BEGIN
  BEGIN
    INSERT INTO score_formulas (version, axis, config, active)
    VALUES ('formula_v2_smoke', 'founder_score', '{}'::jsonb, true);
    RAISE EXCEPTION 'smoke FAIL: a second active score_formulas row for axis=founder_score was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (uq_score_formulas_active_axis), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Positive: exactly one active score_formulas row for founder_score survives
-- the rejected insert above -- proves the constraint actually blocked it.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM score_formulas WHERE axis = 'founder_score' AND active;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: expected exactly 1 active score_formulas row for founder_score, got %', v_count;
  END IF;
END $$;

-- purge_founder() extension (design.md SS4.2): a dedicated founder with a
-- founder_score row, a score_components row linked to it via score_id, AND
-- a score_id-IS-NULL score_components row from a separate run -- the
-- founder_id-first sweep in purge_founder() must catch both.
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('00000000-0000-0000-0000-000000000940', 'Purge Fixture Founder (score_components)');
  INSERT INTO scores (id, founder_id, axis, value)
    VALUES ('00000000-0000-0000-0000-000000000942', '00000000-0000-0000-0000-000000000940', 'founder_score', 65);
  INSERT INTO score_components (id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, credit, contribution)
    VALUES ('00000000-0000-0000-0000-000000000943', '00000000-0000-0000-0000-000000000942',
            '00000000-0000-0000-0000-000000000940', '00000000-0000-0000-0000-000000000945',
            'execution-signals', 'E1', 'met', 0.10000, 1.00, 10.00000);
  INSERT INTO score_components (id, score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, what_would_close_it)
    VALUES ('00000000-0000-0000-0000-000000000944', NULL,
            '00000000-0000-0000-0000-000000000940', '00000000-0000-0000-0000-000000000946',
            'execution-signals', 'E1', 'cannot_assess', 0.10000, 'no evidence attempted');
END $$;

DO $$
BEGIN
  PERFORM purge_founder('00000000-0000-0000-0000-000000000940');
END $$;

DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT
    (SELECT count(*) FROM founders WHERE id = '00000000-0000-0000-0000-000000000940') +
    (SELECT count(*) FROM scores WHERE id = '00000000-0000-0000-0000-000000000942') +
    (SELECT count(*) FROM score_components WHERE id IN ('00000000-0000-0000-0000-000000000943', '00000000-0000-0000-0000-000000000944'))
  INTO v_remaining;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: purge_founder left % row(s) behind for the score_components purge-extension fixture (both score_id-linked and score_id-NULL rows), expected 0', v_remaining;
  END IF;
END $$;

-- ============================================================================
-- Feature 07 (thesis engine) -- theses additions + thesis_evaluations.
-- docs/backlog/07-thesis-engine/design.md SS5. Id range 0970-0979.
-- ============================================================================

-- Fixture: a fresh thesis lineage, v1 active.
DO $$
BEGIN
  INSERT INTO theses (id, name, version, config, active, is_default)
  VALUES ('00000000-0000-0000-0000-000000000970', 'smoke-test-thesis', 1, '{}'::jsonb, true, false);
END $$;

-- Positive: empty config '{}' is accepted by validate_thesis_config() (the
-- column's own default -- rejecting it would break any feature creating a
-- bare thesis row).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM theses
    WHERE id = '00000000-0000-0000-0000-000000000970' AND config = '{}'::jsonb AND active;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: empty-config thesis fixture did not round-trip, got %', v_count;
  END IF;
END $$;

-- Negative: a second ACTIVE version of the same thesis name (uq_theses_active_name) -> 23505.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config, active)
    VALUES ('smoke-test-thesis', 2, '{}'::jsonb, true);
    RAISE EXCEPTION 'smoke FAIL: a second active thesis version for the same name was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (uq_theses_active_name), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Positive: the documented activation pattern -- INSERT v2 with active=false
-- explicitly, then call activate_thesis_version(). Proves the RPC flips both
-- rows atomically.
DO $$
BEGIN
  INSERT INTO theses (id, name, version, config, active)
  VALUES ('00000000-0000-0000-0000-000000000971', 'smoke-test-thesis', 2, '{}'::jsonb, false);

  PERFORM activate_thesis_version('00000000-0000-0000-0000-000000000971');
END $$;

DO $$
DECLARE
  v_v1_active boolean;
  v_v2_active boolean;
BEGIN
  SELECT active INTO v_v1_active FROM theses WHERE id = '00000000-0000-0000-0000-000000000970';
  SELECT active INTO v_v2_active FROM theses WHERE id = '00000000-0000-0000-0000-000000000971';
  IF v_v1_active OR NOT v_v2_active THEN
    RAISE EXCEPTION 'smoke FAIL: activate_thesis_version did not atomically flip active (v1=%, v2=%)', v_v1_active, v_v2_active;
  END IF;
END $$;

-- Negative: a second is_default+active row anywhere in the table
-- (uq_theses_single_default) -> 23505. Depends on db/seed.sql's 'default'
-- thesis (active=true, is_default=true) already being present, same
-- assumption Task 3's registry assertions above already make.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config, active, is_default)
    VALUES ('smoke-test-thesis-2', 1, '{}'::jsonb, true, true);
    RAISE EXCEPTION 'smoke FAIL: a second is_default+active thesis was accepted, expected 23505';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23505' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE 23505 (uq_theses_single_default), got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: validate_thesis_config() -- hard rule with hard_justification
-- ABSENT ENTIRELY (the NULL-trap case D-01 exists to catch: a naive
-- `NOT IN (...)` against a missing key is NULL, not TRUE, and silently
-- passes without the COALESCE guard) -> P0001.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config)
    VALUES ('smoke-bad-thesis-1', 1,
      '{"rules":[{"id":"H1","kind":"must_have","enforcement":"hard","weight":10,"expr":{"op":"eq","field":"x","value":"y"}}]}'::jsonb);
    RAISE EXCEPTION 'smoke FAIL: a hard rule with hard_justification entirely absent was accepted, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (validate_thesis_config) on missing hard_justification, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: validate_thesis_config() -- focus + hard is illegal (D-04) -> P0001.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config)
    VALUES ('smoke-bad-thesis-2', 1,
      '{"rules":[{"id":"H2","kind":"focus","enforcement":"hard","hard_justification":"fraud","weight":10,"expr":{"op":"eq","field":"x","value":"y"}}]}'::jsonb);
    RAISE EXCEPTION 'smoke FAIL: a focus+hard rule was accepted, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (validate_thesis_config) on focus+hard, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: validate_thesis_config() -- deal_breaker with non-zero weight (D-04) -> P0001.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config)
    VALUES ('smoke-bad-thesis-3', 1,
      '{"rules":[{"id":"H3","kind":"deal_breaker","enforcement":"soft","weight":5,"expr":{"op":"eq","field":"x","value":"y"}}]}'::jsonb);
    RAISE EXCEPTION 'smoke FAIL: a deal_breaker rule with non-zero weight was accepted, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (validate_thesis_config) on deal_breaker weight != 0, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Negative: validate_thesis_config() -- duplicate rule id -> P0001.
DO $$
BEGIN
  BEGIN
    INSERT INTO theses (name, version, config)
    VALUES ('smoke-bad-thesis-4', 1,
      '{"rules":[{"id":"D1","kind":"focus","enforcement":"soft","weight":5,"expr":{"op":"eq","field":"x","value":"y"}},'
      '{"id":"D1","kind":"focus","enforcement":"soft","weight":3,"expr":{"op":"eq","field":"x","value":"y"}}]}'::jsonb);
    RAISE EXCEPTION 'smoke FAIL: a config with a duplicate rule id was accepted, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (validate_thesis_config) on duplicate rule id, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- Fixture: a thesis_evaluations row against the existing minimal-intake
-- application (...0501, Task 5 above) and the seeded default thesis.
DO $$
DECLARE
  v_default_thesis_id uuid;
BEGIN
  SELECT id INTO v_default_thesis_id FROM theses WHERE name = 'default' AND active LIMIT 1;
  IF v_default_thesis_id IS NULL THEN
    RAISE EXCEPTION 'smoke FAIL: no active default thesis found (db/seed.sql should have inserted one)';
  END IF;

  INSERT INTO thesis_evaluations (id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict, fired_rules, coverage)
  VALUES (
    '00000000-0000-0000-0000-000000000972', '00000000-0000-0000-0000-000000000501',
    v_default_thesis_id, 1, 'smoke-fingerprint-0972', 'full', 'passed', '[]'::jsonb, 0.80
  );
END $$;

-- Positive: round-trip readback.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM thesis_evaluations
    WHERE id = '00000000-0000-0000-0000-000000000972'
      AND application_id = '00000000-0000-0000-0000-000000000501'
      AND verdict = 'passed';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: thesis_evaluations fixture did not round-trip, got %', v_count;
  END IF;
END $$;

-- Negative: plain UPDATE on thesis_evaluations (append-only) -> P0001.
DO $$
BEGIN
  BEGIN
    UPDATE thesis_evaluations SET verdict = 'failed' WHERE id = '00000000-0000-0000-0000-000000000972';
    RAISE EXCEPTION 'smoke FAIL: UPDATE on thesis_evaluations (append-only) succeeded, expected P0001';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION 'smoke FAIL: expected SQLSTATE P0001 (append-only guard) on thesis_evaluations UPDATE, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- purge_founder() extension regression (design.md SS5.2): thesis_evaluations
-- RESTRICTs against applications, scores AND ai_runs; scores is the
-- earliest of the three deleted inside purge_founder(), so the sweep must
-- land before all three or this reproduces a live 23503 (the DB reviewer's
-- finding, same defect class as the ai_runs regression fixture above).
-- Uncaught on purpose: pre-fix, this call itself raises 23503 and aborts
-- the suite loudly -- that IS the regression signal.
DO $$
DECLARE
  v_default_thesis_id uuid;
BEGIN
  SELECT id INTO v_default_thesis_id FROM theses WHERE name = 'default' AND active LIMIT 1;

  INSERT INTO founders (id, full_name)
    VALUES ('00000000-0000-0000-0000-000000000973', 'Purge Fixture Founder (thesis_evaluations regression)');
  INSERT INTO companies (id, name, stage)
    VALUES ('00000000-0000-0000-0000-000000000974', 'Purge Fixture Co (thesis_evaluations regression)', 'pre_seed');
  INSERT INTO founder_company (founder_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-000000000973', '00000000-0000-0000-0000-000000000974', 'founder');
  INSERT INTO applications (id, company_id, kind, deck_storage_path)
    VALUES ('00000000-0000-0000-0000-000000000975', '00000000-0000-0000-0000-000000000974', 'inbound', 's3://decks/purge-fixture-thesis-eval.pdf');
  INSERT INTO thesis_evaluations (id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict)
    VALUES ('00000000-0000-0000-0000-000000000976', '00000000-0000-0000-0000-000000000975',
            v_default_thesis_id, 1, 'smoke-fingerprint-0976', 'full', 'borderline');
END $$;

DO $$
BEGIN
  PERFORM purge_founder('00000000-0000-0000-0000-000000000973');
END $$;

DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT
    (SELECT count(*) FROM founders WHERE id = '00000000-0000-0000-0000-000000000973') +
    (SELECT count(*) FROM companies WHERE id = '00000000-0000-0000-0000-000000000974') +
    (SELECT count(*) FROM applications WHERE id = '00000000-0000-0000-0000-000000000975') +
    (SELECT count(*) FROM thesis_evaluations WHERE id = '00000000-0000-0000-0000-000000000976')
  INTO v_remaining;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: purge_founder left % row(s) behind for the thesis_evaluations regression fixture, expected 0', v_remaining;
  END IF;
END $$;

-- ============================================================================
-- Feature 02 (sourcing radar) -- radar_candidates view + idempotency.
-- docs/backlog/02-sourcing-radar/design.md SS6. Id prefix 02f00001-...
-- (non-overlapping with the 00000000-... range used above).
-- ============================================================================

-- Fixture + positive: a single-term obscurity case (gh_followers only).
-- Exact expected value cross-checked against the live view during feature
-- 02's own build (docs/backlog/02-sourcing-radar/tracker.md, "followers-only
-- (9) -> 0.6667"): 1 - clamp(log10(1+9)/3, 0, 1) = 0.6667 (rounded, 4 dp).
DO $$
BEGIN
  INSERT INTO founders (id, full_name) VALUES ('02f00001-0000-0000-0000-000000000001', 'Radar Smoke Founder A');
  INSERT INTO cards (id, card_type, founder_id) VALUES ('02f00001-0000-0000-0000-000000000011', 'founder', '02f00001-0000-0000-0000-000000000001');
  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
    VALUES ('gh_followers', '02f00001-0000-0000-0000-000000000001', 9, now());
END $$;

DO $$
DECLARE
  v_obscurity numeric;
  v_basis     text[];
BEGIN
  SELECT obscurity, obscurity_basis INTO v_obscurity, v_basis
  FROM radar_candidates WHERE founder_id = '02f00001-0000-0000-0000-000000000001';

  IF v_obscurity IS DISTINCT FROM 0.6667 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates single-term obscurity expected 0.6667, got %', v_obscurity;
  END IF;
  IF v_basis IS DISTINCT FROM ARRAY['gh_followers'] THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates single-term obscurity_basis expected {gh_followers}, got %', v_basis;
  END IF;
END $$;

-- Fixture + positive: a two-term obscurity case (gh_followers + hn_karma).
-- Cross-checked the same way: (0.6667 + 0.75) / 2 = 0.7083.
DO $$
BEGIN
  INSERT INTO founders (id, full_name) VALUES ('02f00001-0000-0000-0000-000000000002', 'Radar Smoke Founder B');
  INSERT INTO cards (id, card_type, founder_id) VALUES ('02f00001-0000-0000-0000-000000000012', 'founder', '02f00001-0000-0000-0000-000000000002');
  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
    VALUES ('gh_followers', '02f00001-0000-0000-0000-000000000002', 9, now());
  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
    VALUES ('hn_karma', '02f00001-0000-0000-0000-000000000002', 9, now());
END $$;

DO $$
DECLARE
  v_obscurity numeric;
  v_basis     text[];
BEGIN
  SELECT obscurity, obscurity_basis INTO v_obscurity, v_basis
  FROM radar_candidates WHERE founder_id = '02f00001-0000-0000-0000-000000000002';

  IF v_obscurity IS DISTINCT FROM 0.7083 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates two-term obscurity expected 0.7083, got %', v_obscurity;
  END IF;
  IF v_basis IS DISTINCT FROM ARRAY['gh_followers', 'hn_karma'] THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates two-term obscurity_basis expected {gh_followers,hn_karma}, got %', v_basis;
  END IF;
END $$;

-- Fixture + positive: REQ-003 tripwire -- a founder card with NO metric
-- observations at all must show obscurity IS NULL and obscurity_basis IS
-- NULL, never 0-substituted (0-substitution would compute obscurity ~= 1.0,
-- "maximally undiscovered", and float the most data-less founder to the top
-- of the feed -- REQ-003 running backwards). The row itself must still
-- appear (LEFT JOIN), not vanish.
DO $$
BEGIN
  INSERT INTO founders (id, full_name) VALUES ('02f00001-0000-0000-0000-000000000003', 'Radar Smoke Founder C (no metrics)');
  INSERT INTO cards (id, card_type, founder_id) VALUES ('02f00001-0000-0000-0000-000000000013', 'founder', '02f00001-0000-0000-0000-000000000003');
END $$;

DO $$
DECLARE
  v_row_count int;
  v_obscurity numeric;
  v_basis     text[];
BEGIN
  SELECT count(*) INTO v_row_count FROM radar_candidates WHERE founder_id = '02f00001-0000-0000-0000-000000000003';
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates should still surface a metric-less founder card (LEFT JOIN), got % rows', v_row_count;
  END IF;

  SELECT obscurity, obscurity_basis INTO v_obscurity, v_basis
  FROM radar_candidates WHERE founder_id = '02f00001-0000-0000-0000-000000000003';

  IF v_obscurity IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: REQ-003 violated -- metric-less founder obscurity was 0-substituted to %, expected NULL', v_obscurity;
  END IF;
  IF v_basis IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: metric-less founder obscurity_basis expected NULL, got %', v_basis;
  END IF;
END $$;

-- No-op: duplicate raw_signals.content_hash retry (composite-id hash shape,
-- design SS6.1) with explicit ON CONFLICT DO NOTHING -> row count unchanged.
DO $$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  INSERT INTO raw_signals (source, content_hash, founder_id, observed_at)
  VALUES ('hn_algolia', 'hn_algolia::02f00001-radar-smoke', '02f00001-0000-0000-0000-000000000001', now())
  ON CONFLICT (content_hash) DO NOTHING;

  SELECT count(*) INTO v_before FROM raw_signals WHERE content_hash = 'hn_algolia::02f00001-radar-smoke';

  INSERT INTO raw_signals (source, content_hash, founder_id, observed_at)
  VALUES ('hn_algolia', 'hn_algolia::02f00001-radar-smoke', '02f00001-0000-0000-0000-000000000001', now())
  ON CONFLICT (content_hash) DO NOTHING;

  SELECT count(*) INTO v_after FROM raw_signals WHERE content_hash = 'hn_algolia::02f00001-radar-smoke';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'smoke FAIL: radar raw_signals content_hash retry was not a no-op (% -> %)', v_before, v_after;
  END IF;
END $$;

-- No-op: metric_observations retry within the same hour-truncated
-- observed_at (design SS6.1 -- observed_at truncated to the hour so a retry
-- inside the scan window collapses) does not double-insert.
DO $$
DECLARE
  v_before int;
  v_after  int;
  v_hour   timestamptz := date_trunc('hour', now());
BEGIN
  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
  VALUES ('gh_stars', '02f00001-0000-0000-0000-000000000001', 42, v_hour)
  ON CONFLICT (metric, founder_id, company_id, observed_at) DO NOTHING;

  SELECT count(*) INTO v_before FROM metric_observations
    WHERE metric = 'gh_stars' AND founder_id = '02f00001-0000-0000-0000-000000000001' AND observed_at = v_hour;

  INSERT INTO metric_observations (metric, founder_id, value, observed_at)
  VALUES ('gh_stars', '02f00001-0000-0000-0000-000000000001', 42, v_hour)
  ON CONFLICT (metric, founder_id, company_id, observed_at) DO NOTHING;

  SELECT count(*) INTO v_after FROM metric_observations
    WHERE metric = 'gh_stars' AND founder_id = '02f00001-0000-0000-0000-000000000001' AND observed_at = v_hour;

  IF v_after <> v_before THEN
    RAISE EXCEPTION 'smoke FAIL: radar metric_observations hour-truncated retry was not a no-op (% -> %)', v_before, v_after;
  END IF;
END $$;

-- ============================================================================
-- Feature 10 (api/cli/skill) -- api_founders / api_applications / api_claims
-- view assertions, plus a regression guard for the radar_candidates
-- log-domain bug (task A1a, a Feature 10 fix to a Feature 02 object -- see
-- TRACKER.md). docs/backlog/10-api-cli-skill/design.md SS4, SS9.
-- Id prefix 10f00001-... (non-overlapping with the 00000000-... and
-- 02f00001-... ranges used above).
--
-- Order matters and is the load-bearing lesson of this section (design SS9,
-- rev.2/rev.3 changelog B1): the rev.2 design shipped an INVERTED opt-out
-- filter (`opt_out_at IS NOT NULL` instead of `IS NULL`) that would have made
-- all three views return zero rows for everyone -- and it survived review
-- because the only planned test asserted opted-out founders were *absent*,
-- which passes trivially against a view returning nothing. Positive
-- "something is actually in here" assertions run FIRST, before any
-- absence/negative case.
-- ============================================================================

-- Positive 1/3: api_founders returns > 0 rows, and exactly one row per
-- founder -- the count(*) = count(distinct founder_id) invariant design SS4.1
-- proves structurally (plain DISTINCT over radar_candidates, founder_company
-- resolved via DISTINCT ON), asserted here at the view boundary regardless
-- of how many fixture founders any earlier section in this file has added.
DO $$
DECLARE
  v_total    int;
  v_distinct int;
BEGIN
  SELECT count(*), count(DISTINCT founder_id) INTO v_total, v_distinct FROM api_founders;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'smoke FAIL: api_founders returned 0 rows -- the exact B1 regression shape (an inverted opt-out filter serves nobody)';
  END IF;
  IF v_total <> v_distinct THEN
    RAISE EXCEPTION 'smoke FAIL: api_founders returned % rows but only % distinct founder_id -- one-row-per-founder violated', v_total, v_distinct;
  END IF;
END $$;

-- Positive 2/3: api_claims returns > 0 rows WITH founder_id IS NULL --
-- company-scoped evidence (04's market.*/competition.*, 07's company.*) must
-- survive the anti-join, not be dropped by an inner join in disguise
-- (design SS4, review round-3 F1).
DO $$
DECLARE
  v_company_scoped int;
BEGIN
  SELECT count(*) INTO v_company_scoped FROM api_claims WHERE founder_id IS NULL;
  IF v_company_scoped = 0 THEN
    RAISE EXCEPTION 'smoke FAIL: api_claims returned 0 company-scoped (founder_id IS NULL) rows -- an inner join to founders would produce exactly this';
  END IF;
END $$;

-- Positive 3/3: api_applications returns > 0 rows.
DO $$
DECLARE
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM api_applications;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'smoke FAIL: api_applications returned 0 rows -- the exact B1 regression shape';
  END IF;
END $$;

-- Fixture: an opted-out founder, linked to its application THROUGH A
-- FOUNDER CARD (card.application_id = the application) -- the path task
-- A1d fixed api_applications to actually use, and deliberately NOT through
-- founder_company. A prior version of this fixture built the link via
-- founder_company, which made the assertion below pass while testing a path
-- no real founder takes -- founder_company holds 5 rows total (03/05 test
-- fixtures) and feature 02, which wrote the entire real corpus, never
-- writes it. A green test on that dead path is exactly how the underlying
-- api_applications bug (opting out every founder removed 0 of 308
-- applications) survived to a QA pass.
--
-- Also fixtures a SECOND, untouched founder+application at a SEPARATE,
-- UNRELATED company (10f00001-...-0010) to prove precision: opting out
-- founder 0001 must not touch founder 0007's application 0008, which shares
-- no company with 0001 at all. (Task A1f note: this sibling deliberately
-- does NOT share company 0002 with founder 0001 -- exclusion is now
-- company-scoped by design SS4, so a genuine CO-founder of the same company
-- who is not opted out correctly KEEPS that company's applications visible;
-- that is not a leak, it is the "retained when at least one founder of the
-- company is not opted out" rule working as intended. The TWO-FOUNDER
-- co-founder case itself -- distinct from this untouched-sibling case, and
-- NOT the same as the two-applications-one-card fixture below, which has
-- only one founder total -- is its own dedicated fixture further down
-- (task A1f gap 2, TRACKER.md): a company with two co-founders, asserting
-- 1->1 on opting out one and 1->0 on opting out both.)
DO $$
BEGIN
  INSERT INTO founders (id, full_name, opt_out_at)
    VALUES ('10f00001-0000-0000-0000-000000000001', 'Smoke Opt-Out Founder', now());
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000007', 'Smoke Untouched Founder (unrelated company)');
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000002', 'Smoke Opt-Out Co', 'pre_seed');
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000010', 'Smoke Untouched Co (unrelated)', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000004', '10f00001-0000-0000-0000-000000000002', 'radar_activated');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000008', '10f00001-0000-0000-0000-000000000010', 'radar_activated');
  -- Founder-card linkage, NOT founder_company -- this is the real path.
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000005', 'founder',
            '10f00001-0000-0000-0000-000000000001', '10f00001-0000-0000-0000-000000000002', '10f00001-0000-0000-0000-000000000004');
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000009', 'founder',
            '10f00001-0000-0000-0000-000000000007', '10f00001-0000-0000-0000-000000000010', '10f00001-0000-0000-0000-000000000008');
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
    VALUES ('10f00001-0000-0000-0000-000000000006', '10f00001-0000-0000-0000-000000000005',
            'founder.expertise.vertical_tenure', 'Smoke fixture claim for an opted-out founder.', 'public');
END $$;

-- Negative 1/3: opt_out_at excludes the founder, its card-linked
-- application, AND its founder-scoped claim from all three views --
-- WITHOUT touching the unrelated founder/application/company next door.
DO $$
DECLARE
  v_founder_present         int;
  v_application_present     int;
  v_claim_present           int;
  v_sibling_founder_present int;
  v_sibling_app_present     int;
BEGIN
  SELECT count(*) INTO v_founder_present FROM api_founders
    WHERE founder_id = '10f00001-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_application_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_claim_present FROM api_claims
    WHERE claim_id = '10f00001-0000-0000-0000-000000000006';
  SELECT count(*) INTO v_sibling_founder_present FROM api_founders
    WHERE founder_id = '10f00001-0000-0000-0000-000000000007';
  SELECT count(*) INTO v_sibling_app_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000008';

  IF v_founder_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: opted-out founder is present in api_founders, expected excluded';
  END IF;
  IF v_application_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: application card-linked to an opted-out founder is present in api_applications, expected excluded (task A1d)';
  END IF;
  IF v_claim_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: founder-scoped claim of an opted-out founder is present in api_claims, expected excluded';
  END IF;
  IF v_sibling_founder_present <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: untouched founder at an unrelated company expected present in api_founders, got % rows', v_sibling_founder_present;
  END IF;
  IF v_sibling_app_present <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: application at an UNRELATED company, linked to a DIFFERENT (non-opted-out) founder who shares no company with the opted-out one, was excluded -- exclusion leaked across companies, expected company-scoped precision (task A1f)';
  END IF;
END $$;

-- Fixture: a canonical founder plus a merge-tombstone duplicate
-- (merged_into_founder_id -> canonical), the duplicate linked to its
-- application through a founder card (same task A1d real-path reasoning
-- as the opt-out fixture above -- not founder_company).
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000011', 'Smoke Merge Canonical Founder');
  INSERT INTO founders (id, full_name, merged_into_founder_id)
    VALUES ('10f00001-0000-0000-0000-000000000012', 'Smoke Merge Duplicate Founder', '10f00001-0000-0000-0000-000000000011');
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000013', 'Smoke Merge Tombstone Co', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000014', '10f00001-0000-0000-0000-000000000013', 'radar_activated');
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000015', 'founder',
            '10f00001-0000-0000-0000-000000000012', '10f00001-0000-0000-0000-000000000013', '10f00001-0000-0000-0000-000000000014');
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
    VALUES ('10f00001-0000-0000-0000-000000000016', '10f00001-0000-0000-0000-000000000015',
            'founder.expertise.vertical_tenure', 'Smoke fixture claim for a merge-tombstone founder.', 'public');
END $$;

-- Negative 2/3: merged_into_founder_id excludes the duplicate (and
-- everything reached only through it) the same way opt_out_at does, while
-- the canonical founder -- untouched by either flag -- stays visible, proving
-- the filter is precise rather than a blanket exclusion of anything nearby.
DO $$
DECLARE
  v_duplicate_present     int;
  v_canonical_present     int;
  v_application_present   int;
  v_claim_present         int;
BEGIN
  SELECT count(*) INTO v_duplicate_present FROM api_founders
    WHERE founder_id = '10f00001-0000-0000-0000-000000000012';
  SELECT count(*) INTO v_canonical_present FROM api_founders
    WHERE founder_id = '10f00001-0000-0000-0000-000000000011';
  SELECT count(*) INTO v_application_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000014';
  SELECT count(*) INTO v_claim_present FROM api_claims
    WHERE claim_id = '10f00001-0000-0000-0000-000000000016';

  IF v_duplicate_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: merge-tombstone founder is present in api_founders, expected excluded';
  END IF;
  IF v_canonical_present <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: canonical founder (untouched by either flag) expected present in api_founders, got % rows', v_canonical_present;
  END IF;
  IF v_application_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: application card-linked to a merge-tombstone founder is present in api_applications, expected excluded (task A1d)';
  END IF;
  IF v_claim_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: founder-scoped claim of a merge-tombstone founder is present in api_claims, expected excluded';
  END IF;
END $$;

-- Fixture + Negative 3/3: the founder_company-preferred path, kept as its
-- own case per the task A1d instruction ("keep a founder_company-based case
-- as well") -- no card at all here, proving api_applications' CTE still
-- resolves and excludes correctly when founder_company.is_current DOES
-- carry a row for the company (03/05's own founders populate it
-- deliberately; this is the branch that made the original, wrong fixture
-- shape pass without exercising the real one).
DO $$
BEGIN
  INSERT INTO founders (id, full_name, opt_out_at)
    VALUES ('10f00001-0000-0000-0000-000000000041', 'Smoke Opt-Out Founder (founder_company path)', now());
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000042', 'Smoke Opt-Out Co (founder_company path)', 'pre_seed');
  INSERT INTO founder_company (founder_id, company_id, role, is_current)
    VALUES ('10f00001-0000-0000-0000-000000000041', '10f00001-0000-0000-0000-000000000042', 'founder', true);
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000043', '10f00001-0000-0000-0000-000000000042', 'radar_activated');
END $$;

DO $$
DECLARE
  v_application_present int;
BEGIN
  SELECT count(*) INTO v_application_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000043';
  IF v_application_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: application whose only founder_company.is_current founder opted out is present in api_applications, expected excluded (founder_company-preferred path)';
  END IF;
END $$;

-- Fixture + Negative 4/4: task A1f -- a company with TWO applications where
-- only ONE carries the founder card. QA-reproduced live 2026-07-19 at scale
-- ("safehttp": 12 applications, 1 founder card; opting out that founder left
-- 11 of 12 visible -- 104 of 308 real applications share this shape). The
-- A1d fixtures above all gave the fixture founder their OWN dedicated
-- application, which cannot exercise this: this one is the case that would
-- have caught A1d's scope bug (application-scoped instead of company-scoped)
-- before QA did. Both applications must vanish -- the card-linked one AND
-- the cardless sibling, because the company's founder set is company-wide,
-- not per-application.
DO $$
BEGIN
  INSERT INTO founders (id, full_name, opt_out_at)
    VALUES ('10f00001-0000-0000-0000-000000000051', 'Smoke Opt-Out Founder (company-scope, one card of two apps)', now());
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000052', 'Smoke Opt-Out Co (two apps, one card)', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000053', '10f00001-0000-0000-0000-000000000052', 'radar_activated');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000054', '10f00001-0000-0000-0000-000000000052', 'radar_activated');
  -- Founder card exists ONLY for application 0053, not 0054 -- the exact
  -- "safehttp" shape (1 card, N applications at the same company).
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000055', 'founder',
            '10f00001-0000-0000-0000-000000000051', '10f00001-0000-0000-0000-000000000052', '10f00001-0000-0000-0000-000000000053');
END $$;

DO $$
DECLARE
  v_carded_app_present   int;
  v_cardless_app_present int;
BEGIN
  SELECT count(*) INTO v_carded_app_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000053';
  SELECT count(*) INTO v_cardless_app_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000054';

  IF v_carded_app_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: the card-linked application of an opted-out founder is present in api_applications, expected excluded';
  END IF;
  IF v_cardless_app_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: task A1f regression -- the CARDLESS sibling application at the same company survived the founder opt-out (application-scoped instead of company-scoped exclusion), got 1 row present, expected excluded';
  END IF;
END $$;

-- Fixture + Negative 5/5: task A1f gap 2 (TRACKER.md, qa-report-10.md SS A4)
-- -- a GENUINE two-founder co-founder case, which existed nowhere in this
-- suite before now (the comment on the Negative 1/3 fixture above used to
-- claim it was "exercised separately below by the two-applications-one-card
-- fixture" -- false, that fixture has only one founder total; QA had to
-- construct this case itself). Two founders on ONE card each, both cards
-- reaching the SAME company (one via card.company_id + card.application_id
-- together, the other via card.company_id alone, with no application_id --
-- covering both of company_founders' card-reachability paths), one shared
-- application. Two-step assertion: opting out ONE co-founder retains the
-- application (1 -> 1, the other co-founder is still active); opting out
-- the SECOND co-founder too then excludes it (1 -> 0, no active founder of
-- the company remains). This is exactly the shape where a company-scoped
-- exclusion could go wrong in either direction -- too narrow (excludes on
-- the first opt-out, as if founders were unioned as a hard requirement
-- instead of "all must fail") or too broad (never excludes because at
-- least one row always satisfies some unrelated condition).
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000071', 'Smoke Co-Founder A');
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000072', 'Smoke Co-Founder B');
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000073', 'Smoke Co-Founder Co', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000074', '10f00001-0000-0000-0000-000000000073', 'radar_activated');
  -- Co-founder A's card carries both company_id and application_id.
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000075', 'founder',
            '10f00001-0000-0000-0000-000000000071', '10f00001-0000-0000-0000-000000000073', '10f00001-0000-0000-0000-000000000074');
  -- Co-founder B's card carries only company_id, no application_id --
  -- the card.company_id-direct reachability path, not the via-application one.
  INSERT INTO cards (id, card_type, founder_id, company_id)
    VALUES ('10f00001-0000-0000-0000-000000000076', 'founder',
            '10f00001-0000-0000-0000-000000000072', '10f00001-0000-0000-0000-000000000073');
END $$;

-- Step 1 (1 -> 1): opt out co-founder A only. Co-founder B is still active,
-- so the shared application must remain visible.
DO $$
DECLARE
  v_present int;
BEGIN
  UPDATE founders SET opt_out_at = now() WHERE id = '10f00001-0000-0000-0000-000000000071';

  SELECT count(*) INTO v_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000074';
  IF v_present <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: co-founder case step 1 (1->1) -- application with one opted-out and one active co-founder expected present, got % rows', v_present;
  END IF;
END $$;

-- Step 2 (1 -> 0): opt out co-founder B too. Now every founder of the
-- company is opted out, so the application must be excluded.
DO $$
DECLARE
  v_present int;
BEGIN
  UPDATE founders SET opt_out_at = now() WHERE id = '10f00001-0000-0000-0000-000000000072';

  SELECT count(*) INTO v_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000074';
  IF v_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: co-founder case step 2 (1->0) -- application with BOTH co-founders opted out expected excluded, got % rows', v_present;
  END IF;
END $$;

-- Invariant #1 / REQ-002: the three screening axes never collapse into one
-- number -- api_applications carries no overall_score column, and none is
-- to be added (design SS4.2, SS8.1).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_applications' AND column_name = 'overall_score';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: api_applications has an overall_score column -- REQ-002 / invariant #1 violated';
  END IF;
END $$;

-- Fixture: a founder with NO scores(axis='founder_score') row at all -- the
-- common case (119 of 122 live founders today), fixtured here so the
-- assertion does not depend on that live proportion holding.
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000021', 'Smoke Unscored Founder');
END $$;

-- Positive: no score row is normal, not an error -- founder_score IS NULL
-- AND score_assessed = false, NEVER 0 (03 gotcha 1; REQ-003; design SS4.1).
DO $$
DECLARE
  v_founder_score  numeric;
  v_score_assessed boolean;
BEGIN
  SELECT founder_score, score_assessed INTO v_founder_score, v_score_assessed
  FROM api_founders WHERE founder_id = '10f00001-0000-0000-0000-000000000021';

  IF v_founder_score IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: unscored founder founder_score expected NULL, got % (0-substitution would invert REQ-003)', v_founder_score;
  END IF;
  IF v_score_assessed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'smoke FAIL: unscored founder score_assessed expected false, got %', v_score_assessed;
  END IF;
END $$;

-- Positive: founder_score_missing is a plain text[] of strings on every LIVE
-- row where it is non-empty -- no raw JSON object leaking through (the
-- regression this guards: founder_score's actual missing_flags shape is an
-- array of {criterion_id, what_would_close_it} objects, not the array-of-
-- strings design SS4.2 originally claimed -- task A1 finding 2, corrected in
-- design), and no element is an internal "_"-prefixed key. Column type alone
-- (text[]) cannot catch a regression where the extractor casts a whole jsonb
-- object to text instead of pulling criterion_id -- this checks the actual
-- string shape of every element.
DO $$
DECLARE
  v_row      record;
  v_elem     text;
  v_checked  int := 0;
BEGIN
  FOR v_row IN
    SELECT founder_id, founder_score_missing FROM api_founders
    WHERE founder_score_missing IS NOT NULL AND array_length(founder_score_missing, 1) > 0
  LOOP
    v_checked := v_checked + 1;
    FOREACH v_elem IN ARRAY v_row.founder_score_missing LOOP
      IF v_elem LIKE '{%' OR v_elem LIKE '[%' THEN
        RAISE EXCEPTION 'smoke FAIL: founder_score_missing leaked a raw JSON-shaped element % for founder %', v_elem, v_row.founder_id;
      END IF;
      IF v_elem LIKE '\_%' ESCAPE '\' THEN
        RAISE EXCEPTION 'smoke FAIL: founder_score_missing leaked an internal "_"-prefixed key % for founder %', v_elem, v_row.founder_id;
      END IF;
    END LOOP;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE EXCEPTION 'smoke FAIL: no api_founders row had a non-empty founder_score_missing to check -- assertion is vacuous';
  END IF;
END $$;

-- Fixture: the exact stale-thesis-fit regression shape (task A1 finding,
-- reproduced live 2026-07-19 against application 07f00002-...-04), rebuilt
-- self-contained here rather than depended on by live id -- that application
-- is live operational data written during the hackathon, not seeded by
-- db/apply.sh, and will not exist after the documented cold-start reset
-- (CLAUDE.md > "Полный сброс с нуля"). Two thesis_evaluations rows for the
-- SAME (application_id, thesis_id): an OLDER one carrying a score_id (a
-- deliberately high/stale scores.value, 99.99), a NEWER one with score_id
-- NULL (this run did not reach a score). A naive "latest scores(axis=
-- thesis_fit) for this application" read would return the stale 99.99;
-- api_applications must instead resolve through thesis_evaluations and
-- report NULL.
DO $$
DECLARE
  v_default_thesis_id uuid;
BEGIN
  SELECT id INTO v_default_thesis_id FROM theses WHERE name = 'default' AND active LIMIT 1;
  IF v_default_thesis_id IS NULL THEN
    RAISE EXCEPTION 'smoke FAIL: no active default thesis found (db/seed.sql should have inserted one)';
  END IF;

  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000031', 'Smoke Stale Thesis Fit Co', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000032', '10f00001-0000-0000-0000-000000000031', 'radar_activated');
  INSERT INTO scores (id, application_id, axis, value, computed_at)
    VALUES ('10f00001-0000-0000-0000-000000000033', '10f00001-0000-0000-0000-000000000032', 'thesis_fit', 99.99, now() - interval '1 hour');
  INSERT INTO thesis_evaluations (id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict, score_id, created_at)
    VALUES ('10f00001-0000-0000-0000-000000000034', '10f00001-0000-0000-0000-000000000032',
            v_default_thesis_id, 1, 'smoke-f10-thesis-eval-old', 'full', 'borderline',
            '10f00001-0000-0000-0000-000000000033', now() - interval '1 hour');
  INSERT INTO thesis_evaluations (id, application_id, thesis_id, thesis_version, input_fingerprint, evaluation_mode, verdict, score_id, created_at)
    VALUES ('10f00001-0000-0000-0000-000000000035', '10f00001-0000-0000-0000-000000000032',
            v_default_thesis_id, 1, 'smoke-f10-thesis-eval-new', 'full', 'insufficient_evidence',
            NULL, now());
END $$;

-- Positive: thesis_verdict/thesis_fit resolve through the LATEST
-- thesis_evaluations row for (application_id, thesis_id), never a direct
-- `scores` read -- verdict is still reported, thesis_fit is NULL because
-- the latest row's score_id is NULL (design SS4.2; 07's QA reproduced this
-- exact "stale 100.00" class of bug via a direct scores read).
DO $$
DECLARE
  v_thesis_verdict text;
  v_thesis_fit     numeric;
BEGIN
  SELECT thesis_verdict, thesis_fit INTO v_thesis_verdict, v_thesis_fit
  FROM api_applications WHERE application_id = '10f00001-0000-0000-0000-000000000032';

  IF v_thesis_verdict IS DISTINCT FROM 'insufficient_evidence' THEN
    RAISE EXCEPTION 'smoke FAIL: expected thesis_verdict=insufficient_evidence (the latest thesis_evaluations row), got %', v_thesis_verdict;
  END IF;
  IF v_thesis_fit IS NOT NULL THEN
    RAISE EXCEPTION 'smoke FAIL: thesis_fit expected NULL (latest row has score_id NULL), got % -- stale-scores-read regression', v_thesis_fit;
  END IF;
END $$;

-- Regression guard (task A1a, TRACKER.md): radar_candidates must survive
-- materialising `obscurity` for every row. Founder d2e2c8fb-3abc-4f31-9c65-
-- 66ecc16066e4 (real data) has hn_karma=-2 -- HN karma
-- legitimately goes negative for a downvoted user -- and log() of a
-- non-positive argument used to raise "cannot take logarithm of a negative
-- number", aborting any statement that reads `obscurity` across all rows.
-- `count(*)` alone does NOT exercise this (the planner prunes the unused
-- column), which is exactly why 02's own smoke tests never caught it and why
-- this assertion explicitly selects count(obscurity) too. Left uncaught on
-- purpose, same convention as the thesis_evaluations purge regression above:
-- if the log-domain bug is ever reintroduced, this statement itself raises
-- and aborts the suite loudly -- that IS the regression signal.
DO $$
DECLARE
  v_total     int;
  v_with_obscurity int;
BEGIN
  SELECT count(*), count(obscurity) INTO v_total, v_with_obscurity FROM radar_candidates;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates returned 0 rows';
  END IF;
END $$;

-- Regression guard (task A1e, TRACKER.md, negative-karma half): the A1a fix
-- above stopped the abort but also folded negative hn_karma into
-- karma_term=1 ("maximally obscure"), diverging from lib/f02/obscurity.js
-- (which treats a negative reading as unobserved, term dropped). Founder
-- d2e2c8fb-3abc-4f31-9c65-66ecc16066e4 (real data, hn_karma=-2,
-- gh_followers=4) is the exact measured case: before A1e this view returned
-- 0.8835/{gh_followers,hn_karma}, the library returned 0.767/{gh_followers}.
-- A1e made this view match the library term-for-term; pinned here so the
-- two can never silently drift apart again.
DO $$
DECLARE
  v_obscurity numeric;
  v_basis     text[];
BEGIN
  SELECT obscurity, obscurity_basis INTO v_obscurity, v_basis
  FROM radar_candidates WHERE founder_id = 'd2e2c8fb-3abc-4f31-9c65-66ecc16066e4';

  IF v_obscurity IS DISTINCT FROM 0.767 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates obscurity for the negative-karma founder expected 0.767 (matching lib/f02/obscurity.js), got % -- the A1e regression', v_obscurity;
  END IF;
  IF v_basis IS DISTINCT FROM ARRAY['gh_followers'] THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates obscurity_basis for the negative-karma founder expected {gh_followers} (hn_karma dropped as unobserved), got %', v_basis;
  END IF;
END $$;

-- Regression guard (task A1e, TRACKER.md, "second item" -- duplicate founder
-- cards): `cards` has no unique constraint on (founder_id, card_type), so
-- radar_candidates' previous plain `FROM cards c ... WHERE
-- c.card_type='founder'` emitted one row per founder-card, not one row per
-- founder, the moment a founder ever picked up a second founder card --
-- proven live by injecting exactly this shape (2 rows returned before the
-- fix). radar_candidates now sources from a DISTINCT ON (founder_id) CTE
-- (`founder_card`) with the same `created_at DESC, id DESC` tiebreak
-- api_founders' own `founder_cards` CTE (task A1c) already uses, so the two
-- views cannot disagree about which card wins a tie. api_founders itself was
-- already provably safe (its founder_cards CTE had the DISTINCT ON fix from
-- A1c); the risk was live in radar_candidates alone, which feature 09 may
-- read directly (this view is also where `freshness` lives -- not exposed
-- via api_founders at all, so a duplication there would have been invisible
-- to 10's own guard).
DO $$
DECLARE
  v_company_id     uuid;
  v_application_id uuid;
  v_row_count      int;
  v_company_seen   uuid;
BEGIN
  SELECT id INTO v_company_id FROM companies LIMIT 1;
  SELECT id INTO v_application_id FROM applications LIMIT 1;

  IF v_company_id IS NULL OR v_application_id IS NULL THEN
    RAISE EXCEPTION 'smoke FAIL: A1e duplicate-card guard needs at least one company and one application row to exist -- fixture data is missing';
  END IF;

  -- Founder 02f00001-...-0001 already carries one founder card (inserted
  -- above, company_id/application_id both NULL). Give it a SECOND one with
  -- a real company/application attached and a later created_at, so a
  -- surviving duplication bug would either double the row count or blend in
  -- the wrong company/application.
  INSERT INTO cards (card_type, founder_id, company_id, application_id, created_at, updated_at)
  VALUES ('founder', '02f00001-0000-0000-0000-000000000001', v_company_id, v_application_id, now() + interval '1 hour', now() + interval '1 hour');

  SELECT count(*) INTO v_row_count FROM radar_candidates
  WHERE founder_id = '02f00001-0000-0000-0000-000000000001';
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates returned % row(s) for a founder with 2 founder cards, expected exactly 1 -- the A1e duplicate-card regression', v_row_count;
  END IF;

  SELECT company_id INTO v_company_seen FROM radar_candidates
  WHERE founder_id = '02f00001-0000-0000-0000-000000000001';
  IF v_company_seen IS DISTINCT FROM v_company_id THEN
    RAISE EXCEPTION 'smoke FAIL: radar_candidates picked company_id % for the duplicated founder, expected the latest card''s % (created_at DESC tiebreak)', v_company_seen, v_company_id;
  END IF;
END $$;

-- Regression guard (task A1d, widened task A1f gap 1, TRACKER.md,
-- qa-report-10.md SS A4, "CRITICAL, blocking the QA gate"): the total-wipe
-- case. QA reproduced live that opting out EVERY founder in the database
-- removed 0 of 308 api_applications rows originally (founder_company-only
-- gate, empty for the real corpus) -- a GDPR guarantee silently disabled.
--
-- gap 1: the FIRST version of this guard checked `c.application_id =
-- aa.application_id` -- i.e. "does THIS SPECIFIC application have its own
-- founder card" -- which is application-scoped, the exact same shape as the
-- task A1d bug it was meant to catch. QA confirmed it reported v_leaked = 0
-- even against the reverted, application-scoped view: a decorative guard
-- that passed whether or not the fix was present. Two independent fixes
-- below, not one: (1) a CONCRETE fixture -- a company with two
-- applications where only ONE carries the founder card, the exact shape
-- QA and the coordinator verified by hand -- built BEFORE the blanket wipe
-- so it is asserted on known ids, not on how much of the live/fixture
-- corpus happens to look like this shape at this point in the file; and
-- (2) the generic invariant, corrected to genuine company-scoped
-- reachability (card.company_id OR card.application_id -> applications.
-- company_id OR founder_company.is_current, all keyed by the APPLICATION'S
-- COMPANY, never the application itself) as a broad sweep across
-- everything else in the transaction at this point (live corpus +
-- every earlier fixture in this file).
--
-- Run as the very last thing in this section (touches every founder row in
-- the whole transaction; nothing after this point in this section depends
-- on any founder's opt-out state). Asserted as an INVARIANT for check (2),
-- not a literal "must return 0" -- the correct, design-mandated behaviour
-- retains founderless applications (190 live at task A1d's measurement), so
-- a bare zero-count assertion on the view's total would itself be wrong.

-- Fixture: company with two applications, one founder card -- built before
-- the wipe so this check does not depend on the live corpus containing this
-- shape (it does today, e.g. "safehttp", but this suite must not assume that).
DO $$
BEGIN
  INSERT INTO founders (id, full_name)
    VALUES ('10f00001-0000-0000-0000-000000000081', 'Smoke Total-Wipe Founder (two apps, one card)');
  INSERT INTO companies (id, name, stage)
    VALUES ('10f00001-0000-0000-0000-000000000082', 'Smoke Total-Wipe Co (two apps, one card)', 'pre_seed');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000083', '10f00001-0000-0000-0000-000000000082', 'radar_activated');
  INSERT INTO applications (id, company_id, kind)
    VALUES ('10f00001-0000-0000-0000-000000000084', '10f00001-0000-0000-0000-000000000082', 'radar_activated');
  INSERT INTO cards (id, card_type, founder_id, company_id, application_id)
    VALUES ('10f00001-0000-0000-0000-000000000085', 'founder',
            '10f00001-0000-0000-0000-000000000081', '10f00001-0000-0000-0000-000000000082', '10f00001-0000-0000-0000-000000000083');
END $$;

DO $$
DECLARE
  v_leaked         int;
  v_carded_present int;
  v_cardless_present int;
BEGIN
  UPDATE founders SET opt_out_at = now();

  -- Check (1): the concrete, guaranteed-to-discriminate shape.
  SELECT count(*) INTO v_carded_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000083';
  SELECT count(*) INTO v_cardless_present FROM api_applications
    WHERE application_id = '10f00001-0000-0000-0000-000000000084';
  IF v_carded_present <> 0 OR v_cardless_present <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: total-wipe guard -- company-scoped two-apps-one-card fixture survived a full founder opt-out wipe (carded present=%, cardless present=%), expected both excluded', v_carded_present, v_cardless_present;
  END IF;

  -- Check (2): the broad sweep, now genuinely company-scoped.
  SELECT count(*) INTO v_leaked
  FROM api_applications aa
  WHERE EXISTS (
    SELECT 1 FROM cards c
    LEFT JOIN applications ca ON ca.id = c.application_id
    WHERE c.card_type = 'founder' AND c.founder_id IS NOT NULL
      AND (c.company_id = aa.company_id OR ca.company_id = aa.company_id)
  ) OR EXISTS (
    SELECT 1 FROM founder_company fc
    WHERE fc.company_id = aa.company_id AND fc.is_current
  );

  IF v_leaked <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: % application(s) with a company-reachable founder survived a total founder opt-out wipe -- the task A1d/A1f regression (GDPR guarantee disabled)', v_leaked;
  END IF;
END $$;

-- ============================================================================
-- Feature 05 (truth-gap / trust) -- claim_trust view + f05_host() + the
-- trust_v1 score_formulas row. docs/backlog/05-truth-gap-trust/design.md
-- SS4, SS7, SS10. Id range 0950-0959 (reserved; 01 uses 0901-0930, 07 uses
-- 0970-0979). Fixture claims attach to the existing founder card ...602
-- (Task 6 above) -- no new founder/company/card needed. Evidence rows use
-- gen_random_uuid() ids (never looked up by id below, only via claim_id), so
-- only the claim ids themselves are drawn from the reserved range.
-- ============================================================================

-- Positive: the trust_v1 config row landed with its router + trust blocks
-- intact (structural check, same style as Task 3's registry assertions).
DO $$
DECLARE
  v_prefix_count int;
  v_default_class text;
BEGIN
  SELECT jsonb_array_length(config -> 'router' -> 'prefix_map'), config -> 'router' ->> 'default_class'
    INTO v_prefix_count, v_default_class
  FROM score_formulas WHERE version = 'trust_v1' AND axis = 'trust' AND active;

  IF v_prefix_count IS NULL THEN
    RAISE EXCEPTION 'smoke FAIL: no active trust_v1 score_formulas row found (db/seed.sql should have inserted one)';
  END IF;
  IF v_prefix_count < 20 THEN
    RAISE EXCEPTION 'smoke FAIL: trust_v1 router.prefix_map expected >= 20 entries (design.md SS4.1 has 22), got %', v_prefix_count;
  END IF;
  IF v_default_class <> 'unverifiable' THEN
    RAISE EXCEPTION 'smoke FAIL: trust_v1 router.default_class expected unverifiable (fail-safe), got %', v_default_class;
  END IF;
END $$;

-- Positive: claim_trust carries exactly one row per claim -- a LEFT-JOIN-only
-- construction (claim_router, claim_evidence both built off `FROM claims`
-- with LEFT JOINs) so no claim is ever dropped, regardless of router match or
-- evidence presence. Re-checked below, after this section's own fixtures
-- land, to prove the invariant holds with fresh claims added too, not just at
-- this snapshot.
DO $$
DECLARE
  v_claims int;
  v_view   int;
BEGIN
  SELECT count(*) INTO v_claims FROM claims;
  SELECT count(*) INTO v_view FROM claim_trust;
  IF v_view <> v_claims THEN
    RAISE EXCEPTION 'smoke FAIL: claim_trust has % rows but claims has % -- every claim must appear exactly once', v_view, v_claims;
  END IF;
END $$;

-- Fixture A: a qualitative-class claim (founder.expertise.*) carrying a
-- STRONG documented, independently-sourced support -- the exact regression
-- design.md SS7.1 measured live (373 sourced supports on qualitative topics
-- that an evidence-only formula would render 'verified' on day one). The
-- trust NUMBER is still computed from that evidence (SS7.1: "the trust
-- number is still computed and still shown"); only the VERDICT is withheld.
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000602',
    'founder.expertise.f05smoke_strong', 'Smoke: qualitative claim with a strong sourced support.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000950', 'supports', 'documented', 0.95,
    'https://github.com/ada-lovelace-01', (SELECT id FROM raw_signals WHERE source = 'github_api' LIMIT 1),
    'f05-smoke-0950-supports-a'
  );
END $$;

DO $$
DECLARE
  v_class  text;
  v_status text;
  v_trust  numeric;
BEGIN
  SELECT router_class, derived_status, trust INTO v_class, v_status, v_trust
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000950';

  IF v_class <> 'qualitative' THEN
    RAISE EXCEPTION 'smoke FAIL: founder.expertise.* expected router_class=qualitative, got %', v_class;
  END IF;
  IF v_status <> 'unverified' THEN
    RAISE EXCEPTION 'smoke FAIL: SS7.1 regression -- qualitative claim with a strong sourced support rendered derived_status=%, expected unverified (the verdict must never be granted regardless of evidence)', v_status;
  END IF;
  -- base 0.95 * independence_factor 0.70 (n_independent=1: 0.70+0.15*0) - 0 penalty = 0.665.
  IF v_trust IS DISTINCT FROM 0.6650 THEN
    RAISE EXCEPTION 'smoke FAIL: qualitative claim trust NUMBER expected 0.6650 (still computed from real evidence), got %', v_trust;
  END IF;
END $$;

-- Fixture B: factual_static claim, one documented contradicts, zero supports
-- -- SS7.4 row "contradicts at tier documented > 0 (no supports)" -> contradicted.
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000951', '00000000-0000-0000-0000-000000000602',
    'founder.execution.f05smoke_contradicted', 'Smoke: factual_static claim contradicted at documented tier.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000951', 'contradicts', 'documented', 0.80,
    'https://example.com/counter-evidence', (SELECT id FROM raw_signals WHERE source = 'github_api' LIMIT 1),
    'f05-smoke-0951-contradicts-a'
  );
END $$;

DO $$
DECLARE
  v_class  text;
  v_status text;
BEGIN
  SELECT router_class, derived_status INTO v_class, v_status
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000951';

  IF v_class <> 'factual_static' THEN
    RAISE EXCEPTION 'smoke FAIL: founder.execution.f05smoke_contradicted expected router_class=factual_static (catch-all), got %', v_class;
  END IF;
  IF v_status <> 'contradicted' THEN
    RAISE EXCEPTION 'smoke FAIL: documented-tier contradiction with no supports expected derived_status=contradicted, got %', v_status;
  END IF;
END $$;

-- Fixture C: qualitative claim, one INFERRED-tier contradicts, zero supports
-- -- reproduces the live founder.expertise.insight case (design.md SS14):
-- must stay unverified (never contradicted) AND apply zero trust penalty
-- (n_contradicts_counting excludes inferred/missing tier, SS7.2).
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000952', '00000000-0000-0000-0000-000000000602',
    'founder.expertise.f05smoke_inferred', 'Smoke: qualitative claim with an inferred-tier contradiction only.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, source_url, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000952', 'contradicts', 'inferred',
    'https://example.com/weak-counter-evidence', 'f05-smoke-0952-contradicts-a'
  );
END $$;

DO $$
DECLARE
  v_status    text;
  v_penalty   numeric;
BEGIN
  SELECT derived_status, contradiction_penalty INTO v_status, v_penalty
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000952';

  IF v_status = 'contradicted' THEN
    RAISE EXCEPTION 'smoke FAIL: inferred-tier contradiction must never yield derived_status=contradicted (SS6.0 Tier-1-only rule)';
  END IF;
  IF v_penalty <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: inferred-tier contradiction expected zero contradiction_penalty (SS7.2 same tier gate as the verdict), got %', v_penalty;
  END IF;
END $$;

-- Fixture D: factual_static claim, one documented contradicts AND one
-- (weak, inferred-tier) supports -- SS7.4's mixed-evidence row sits ABOVE the
-- flat-refutation row deliberately: ANY supports alongside a docdisc
-- contradiction reads as conflicting, never flatly refuted, even when the
-- supporting evidence itself is weak.
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000953', '00000000-0000-0000-0000-000000000602',
    'founder.execution.f05smoke_mixed', 'Smoke: factual_static claim with both a documented contradiction and a weak support.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000953', 'contradicts', 'documented', 0.80,
    'https://example.com/mixed-counter-evidence', (SELECT id FROM raw_signals WHERE source = 'github_api' LIMIT 1),
    'f05-smoke-0953-contradicts-a'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000953', 'supports', 'inferred', 0.50,
    'https://example.com/mixed-weak-support', 'f05-smoke-0953-supports-a'
  );
END $$;

DO $$
DECLARE
  v_status text;
BEGIN
  SELECT derived_status INTO v_status
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000953';

  IF v_status <> 'partially_supported' THEN
    RAISE EXCEPTION 'smoke FAIL: documented contradiction + any supports expected derived_status=partially_supported (mixed-evidence row outranks flat refutation), got %', v_status;
  END IF;
END $$;

-- Fixture E: factual_static claim, one DISCOVERED-tier contradicts, zero
-- supports -- SS7.4 "contradicts at tier discovered > 0" -> partially_supported
-- (Tier-2 evidence caps below 'contradicted', SS6.0).
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000954', '00000000-0000-0000-0000-000000000602',
    'founder.execution.f05smoke_discovered', 'Smoke: factual_static claim contradicted at discovered tier only.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000954', 'contradicts', 'discovered', 0.70,
    'https://example.com/discovered-counter-evidence', (SELECT id FROM raw_signals WHERE source = 'hn_algolia' LIMIT 1),
    'f05-smoke-0954-contradicts-a'
  );
END $$;

DO $$
DECLARE
  v_status text;
BEGIN
  SELECT derived_status INTO v_status
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000954';

  IF v_status <> 'partially_supported' THEN
    RAISE EXCEPTION 'smoke FAIL: discovered-tier-only contradiction expected derived_status=partially_supported (Tier-1-only rule, SS6.0), got %', v_status;
  END IF;
END $$;

-- Fixture F: factual_static claim, two documented supports from two
-- INDEPENDENT sources (github_api + hn_algolia raw_signals, picked
-- dynamically -- no new raw_signals rows needed) -- SS7.4's last row
-- ("supports > 0 tier docdisc AND n_independent >= 1") -> verified, and the
-- trust NUMBER is checked against SS7.2's formula exactly: base 0.90 (tier
-- default, no strength override) x independence_factor 0.85
-- (0.70 + 0.15*(2-1)) - 0 penalty = 0.765.
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000955', '00000000-0000-0000-0000-000000000602',
    'founder.execution.f05smoke_verified', 'Smoke: factual_static claim with two independently-sourced documented supports.', 'public'
  );
  INSERT INTO evidence (claim_id, relation, tier, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000955', 'supports', 'documented',
    'https://github.com/verified-smoke-fixture', (SELECT id FROM raw_signals WHERE source = 'github_api' LIMIT 1),
    'f05-smoke-0955-supports-a'
  );
  INSERT INTO evidence (claim_id, relation, tier, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000955', 'supports', 'documented',
    'https://news.ycombinator.com/verified-smoke-fixture', (SELECT id FROM raw_signals WHERE source = 'hn_algolia' LIMIT 1),
    'f05-smoke-0955-supports-b'
  );
END $$;

DO $$
DECLARE
  v_status  text;
  v_trust   numeric;
  v_indep   int;
BEGIN
  SELECT derived_status, trust, n_independent INTO v_status, v_trust, v_indep
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000955';

  IF v_indep <> 2 THEN
    RAISE EXCEPTION 'smoke FAIL: two distinct-source supports expected n_independent=2, got %', v_indep;
  END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'smoke FAIL: two independent documented supports expected derived_status=verified, got %', v_status;
  END IF;
  IF v_trust IS DISTINCT FROM 0.7650 THEN
    RAISE EXCEPTION 'smoke FAIL: verified-claim trust NUMBER expected 0.7650 (0.90 base x 0.85 independence_factor), got %', v_trust;
  END IF;
END $$;

-- Fixture G: an ALREADY-missing claim (REQ-004 first-class gap) that later
-- gains a documented-tier contradiction -- SS7.4 "already missing and
-- contradicts > 0" -> stays missing. The single most emphasized rule in the
-- design: "a gap is never converted into an accusation."
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind, verification_status)
  VALUES (
    '00000000-0000-0000-0000-000000000956', '00000000-0000-0000-0000-000000000602',
    'round.f05smoke_gap', 'Smoke: cap table not disclosed.', 'derived', 'missing'
  );
  INSERT INTO evidence (claim_id, relation, tier, strength, source_url, raw_signal_id, content_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000956', 'contradicts', 'documented', 0.90,
    'https://example.com/gap-counter-evidence', (SELECT id FROM raw_signals WHERE source = 'github_api' LIMIT 1),
    'f05-smoke-0956-contradicts-a'
  );
END $$;

DO $$
DECLARE
  v_status text;
BEGIN
  SELECT derived_status INTO v_status
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000956';

  IF v_status <> 'missing' THEN
    RAISE EXCEPTION 'smoke FAIL: REQ-004 violated -- an already-missing claim with a new documented contradiction rendered derived_status=%, expected missing (a gap must never become an accusation)', v_status;
  END IF;
END $$;

-- Fixture H: a topic matching NONE of the 22 router prefixes -- the
-- default_class fail-safe (design.md SS4.1). No evidence at all.
DO $$
BEGIN
  INSERT INTO claims (id, card_id, topic, text_verbatim, source_kind)
  VALUES (
    '00000000-0000-0000-0000-000000000957', '00000000-0000-0000-0000-000000000602',
    'zzz_totally_unrecognized_topic_f05smoke', 'Smoke: a topic the router table does not know.', 'derived'
  );
END $$;

DO $$
DECLARE
  v_class  text;
  v_status text;
BEGIN
  SELECT router_class, derived_status INTO v_class, v_status
  FROM claim_trust WHERE claim_id = '00000000-0000-0000-0000-000000000957';

  IF v_class <> 'unverifiable' THEN
    RAISE EXCEPTION 'smoke FAIL: unmatched topic expected router_class=unverifiable (the fail-safe default_class), got %', v_class;
  END IF;
  IF v_status <> 'unverified' THEN
    RAISE EXCEPTION 'smoke FAIL: unmatched topic (unverifiable class, not already missing) expected derived_status=unverified, got %', v_status;
  END IF;
END $$;

-- Critical regression (design.md SS7.1, the reason this design exists):
-- ZERO founder.expertise.*/founder.leadership.* claims may ever read
-- derived_status='verified' -- 373 sourced supports exist on those topics
-- live and must never render as verdicts. Re-checked here, after this
-- section's own fixtures (including Fixture A above) have landed, so the
-- assertion covers both the live corpus AND this file's own additions.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM claim_trust
  WHERE derived_status = 'verified'
    AND (topic LIKE 'founder.expertise.%' OR topic LIKE 'founder.leadership.%');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: REQ-004/SS7.1 violated -- % founder.expertise./founder.leadership. claim(s) rendered derived_status=verified, expected 0', v_count;
  END IF;
END $$;

-- Row-count parity, re-checked with this section's 8 new claims in place
-- (view construction is LEFT-JOIN-only end to end, so it must never drop a
-- claim regardless of router match or evidence presence).
DO $$
DECLARE
  v_claims int;
  v_view   int;
BEGIN
  SELECT count(*) INTO v_claims FROM claims;
  SELECT count(*) INTO v_view FROM claim_trust;
  IF v_view <> v_claims THEN
    RAISE EXCEPTION 'smoke FAIL: after Feature 05 fixtures, claim_trust has % rows but claims has % -- every claim must appear exactly once', v_view, v_claims;
  END IF;
END $$;

ROLLBACK;
