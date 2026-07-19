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
    'watch'
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
DO $$
DECLARE
  v_grant_count int;
BEGIN
  SELECT count(*) INTO v_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('scores', 'raw_signals', 'evidence', 'ai_runs', 'events', 'memos')
    AND grantee IN ('anon', 'authenticated', 'service_role')
    AND privilege_type = 'TRUNCATE';

  IF v_grant_count <> 0 THEN
    RAISE EXCEPTION 'smoke FAIL: expected 0 TRUNCATE grants to anon/authenticated/service_role on the 6 append-only tables, found %', v_grant_count;
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

ROLLBACK;
