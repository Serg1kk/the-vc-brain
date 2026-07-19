-- db/fixtures/07-thesis-engine.sql
--
-- Feature 07 (Thesis Engine) test data. Authoritative design:
-- docs/backlog/07-thesis-engine/design.md SS8.3 -- read that section before
-- touching this file.
--
-- NOT applied by db/apply.sh (schema.sql + seed.sql only). Explicit invocation:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/07-thesis-engine.sql
--
-- Four applications, entirely at the company.*-claims level (D-02: the gate
-- evaluates already-extracted attributes, so the fixture supplies the claims
-- an extraction pass would have produced -- it does not call an LLM and it
-- does not pre-compute thesis_evaluations/scores rows; that is
-- lib/f07/run.js's job against this data). Mirrors db/fixtures/03-founder-score.sql
-- in shape and idempotency style. Fixed, explicitly-written UUIDs (never
-- gen_random_uuid()) so the fixture is reproducible and referenceable by id
-- from other tasks (lib/f07/run.js --recorded, D1's e2e run, QA). Id scheme,
-- all hex-safe:
--
--   07f0<TTTT>-0000-0000-0000-<SEQ, 12 hex digits>
--   TTTT = entity type: 0001 companies / 0002 applications / 0003 cards /
--          0004 claims / 0005 raw_signals / 0006 evidence
--   SEQ  = per-type sequence, grouped by application (1xx = app A, 2xx = app
--          B, 3xx = app C, 4xx = app D) so a reader can tell which
--          application a row belongs to from the id alone.
--
-- This range (07f0...) is reserved for this feature and cannot collide with
-- feature 01/09's smoke fixtures (00000000-...-00000000xxx range), feature
-- 03's fixture (03f0...), or any other feature's fixture range.
--
-- ============================================================================
-- THE FOUR APPLICATIONS -- quick reference
-- ============================================================================
--
-- A. 07f00002-0000-0000-0000-000000000001  Nordkit (synthetic, .example)
--    Fully extractable: all five company.* attributes present, on-thesis
--    (b2b-software, b2b, DE -> EU region, prototype -> pre_seed). Its
--    `raw_signals.payload.text` (NOT any claim -- SS1.1, `_text` is the
--    gate's raw input text, never a concatenation of claims) also names both
--    of the default thesis's positive_keywords, so M_poskw should match too.
--    Exercises the "everything checks out" path -- high coverage, no
--    triggered deal-breaker, verdict expected `passed` or `borderline`
--    depending on the exact fit arithmetic lib/f07/rules.js computes.
--
-- B. 07f00002-0000-0000-0000-000000000002  Fogline (synthetic, .example)
--    Deliberately sparse: only company.sector was extractable from the deck;
--    business_model, geography_country, stage_evidence and what_is_built are
--    all first-class 'missing' claims (REQ-004 -- a gap is a row, not an
--    omission), same pattern as db/tests/smoke.sql's Task 6 fixture. Against
--    the default thesis this leaves the M_geo / M_stage / M_poskw / R2 rules
--    all `unknown`, driving coverage well under fit.min_coverage (0.5) by
--    construction -- guaranteed `insufficient_evidence`, independent of any
--    LLM judgement call, exactly like feature 03's Kwame Asante fixture.
--
-- C. 07f00002-0000-0000-0000-000000000003  StakeCircle (synthetic, .example)
--    All five company.* attributes present and well-extracted (high
--    coverage, on purpose) EXCEPT company.sector = 'gambling', which fires
--    the default thesis's one hand-authored hard deal-breaker (R1). Verdict
--    procedure step 1 fires before the coverage check -- this is the D-03
--    guarantee that a firing hard rule is a confidently-observed fact, not a
--    thin-deck accident -- so this application is expected `failed`, not
--    `insufficient_evidence`.
--
-- D. 07f00002-0000-0000-0000-000000000004  GameLoop (synthetic, .example)
--    All five company.* attributes present and well-extracted, sector =
--    'consumer' -- deliberately NOT in R1's ["gambling","adtech"] list, so
--    the one HARD rule never fires. Its `raw_signals.payload.text` (NOT any
--    claim -- SS1.1, `_text` is the gate's raw input text, never a
--    concatenation of claims, and on re-evaluation resolves from exactly
--    this stored payload) names both configured negative_keywords ("casino",
--    "betting"), which compile (SS1.2) to M_negkw: kind=deal_breaker,
--    enforcement=soft (all mandate-compiled rules are soft by construction)
--    -- so it fires ALONE, with nothing hard to pre-empt it. This is the
--    only fixture that can exercise SS8.3's «a soft deal-breaker yields
--    borderline, visible under Outside thesis» -- C's gambling rule is hard
--    and fires first (verdict `failed`), so C cannot stand in for this case.
--    Expected verdict: `borderline` (SS2 step 2b), never `passed`.
--
-- Wrapped in one transaction: either the whole fixture lands or none of it
-- does. Every INSERT carries ON CONFLICT (id) DO NOTHING against the fixed
-- id above, sufficient for idempotent re-runs of this exact file.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Application A: Nordkit -- fully extractable, on-thesis
-- ----------------------------------------------------------------------------

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('07f00001-0000-0000-0000-000000000001',
   'Nordkit',
   'nordkit-thesis07.example',
   'Developer tooling and infrastructure for backend teams debugging distributed systems in production.',
   'devtools',
   'pre_seed',
   '{"fixture_purpose": "feature 07 thesis-gate demo: fully extractable, on-thesis application (all five company.* attributes present)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('07f00002-0000-0000-0000-000000000001',
   '07f00001-0000-0000-0000-000000000001',
   'inbound', 'sourced', 's3://decks/07-thesis-engine/nordkit.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('07f00003-0000-0000-0000-000000000001',
   'company',
   '07f00001-0000-0000-0000-000000000001',
   '07f00002-0000-0000-0000-000000000001',
   'confirmed', 0.90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('07f00004-0000-0000-0000-000000000101',
   '07f00003-0000-0000-0000-000000000001',
   'company.sector',
   'We build a developer-tools platform for backend engineering teams inside larger enterprises.',
   '"b2b-software"'::jsonb, NULL, 'self_reported', 0.70, 'f07fix:claim:101'),

  ('07f00004-0000-0000-0000-000000000102',
   '07f00003-0000-0000-0000-000000000001',
   'company.business_model',
   'Our customers are engineering organizations that pay per seat, not individual hobbyist developers.',
   '"b2b"'::jsonb, NULL, 'self_reported', 0.70, 'f07fix:claim:102'),

  ('07f00004-0000-0000-0000-000000000103',
   '07f00003-0000-0000-0000-000000000001',
   'company.geography_country',
   'The founding team is based in Berlin, Germany.',
   '"DE"'::jsonb, NULL, 'self_reported', 0.80, 'f07fix:claim:103'),

  ('07f00004-0000-0000-0000-000000000104',
   '07f00003-0000-0000-0000-000000000001',
   'company.stage_evidence',
   'We have a working prototype in daily use by two design-partner engineering teams.',
   '"prototype"'::jsonb, NULL, 'self_reported', 0.60, 'f07fix:claim:104'),

  ('07f00004-0000-0000-0000-000000000105',
   '07f00003-0000-0000-0000-000000000001',
   'company.what_is_built',
   'Nordkit is developer tooling and infrastructure that lets backend teams trace and debug distributed systems directly in production.',
   NULL, NULL, 'self_reported', 0.70, 'f07fix:claim:105')
ON CONFLICT (id) DO NOTHING;

-- `payload.text` is the gate's raw input (design.md SS1.1 -- `_text` resolves
-- from here, verbatim, on re-evaluation, never from claims). Key name is
-- this fixture's own convention (the design specifies WHAT is preserved, not
-- what jsonb key it lives under) -- chosen to match the `text` parameter
-- name the gate itself takes (SS6.1); adjust if lib/f07's actual write path
-- lands on a different key.
INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('07f00005-0000-0000-0000-000000000001',
   'deck_parse', NULL,
   '{"text": "Nordkit is developer tools and infrastructure for backend engineering teams inside larger enterprises, letting them trace and debug distributed systems directly in production. Customers are engineering organizations that pay per seat, not individual hobbyist developers. The founding team is based in Berlin, Germany, with a working prototype already in daily use by two design-partner teams.", "note": "fixture deck excerpt, not a full parse -- feature 07 fully-extractable case"}'::jsonb,
   'f07fix:rawsignal:app-a', '07f00001-0000-0000-0000-000000000001', '2026-07-10T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, raw_signal_id, content_hash) VALUES
  ('07f00006-0000-0000-0000-000000000101', '07f00004-0000-0000-0000-000000000101', 'supports', 'documented',
   'developer-tools platform for backend engineering teams', '07f00005-0000-0000-0000-000000000001', 'f07fix:evidence:101'),
  ('07f00006-0000-0000-0000-000000000102', '07f00004-0000-0000-0000-000000000102', 'supports', 'documented',
   'engineering organizations that pay per seat', '07f00005-0000-0000-0000-000000000001', 'f07fix:evidence:102'),
  ('07f00006-0000-0000-0000-000000000103', '07f00004-0000-0000-0000-000000000103', 'supports', 'documented',
   'based in Berlin, Germany', '07f00005-0000-0000-0000-000000000001', 'f07fix:evidence:103'),
  ('07f00006-0000-0000-0000-000000000104', '07f00004-0000-0000-0000-000000000104', 'supports', 'documented',
   'working prototype in daily use by two design-partner engineering teams', '07f00005-0000-0000-0000-000000000001', 'f07fix:evidence:104'),
  ('07f00006-0000-0000-0000-000000000105', '07f00004-0000-0000-0000-000000000105', 'supports', 'documented',
   'developer tooling and infrastructure', '07f00005-0000-0000-0000-000000000001', 'f07fix:evidence:105')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Application B: Fogline -- deliberately sparse (coverage < min_coverage)
-- ----------------------------------------------------------------------------

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('07f00001-0000-0000-0000-000000000002',
   'Fogline',
   'fogline-thesis07.example',
   'Fintech analytics tool for community banks (fixture deck reveals almost nothing else).',
   'fintech',
   'pre_seed',
   '{"fixture_purpose": "feature 07 thesis-gate demo: deliberately sparse application, forces insufficient_evidence by construction (D-07 / SS2 step 2)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('07f00002-0000-0000-0000-000000000002',
   '07f00001-0000-0000-0000-000000000002',
   'inbound', 'sourced', 's3://decks/07-thesis-engine/fogline.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('07f00003-0000-0000-0000-000000000002',
   'company',
   '07f00001-0000-0000-0000-000000000002',
   '07f00002-0000-0000-0000-000000000002',
   'draft', 0.20)
ON CONFLICT (id) DO NOTHING;

-- Only company.sector was extractable from the deck. The other four
-- gateable/near-gateable attributes are first-class 'missing' claims
-- (REQ-004), same pattern as db/tests/smoke.sql:408-412 -- a gap is a row,
-- not an omission. No raw_signals/evidence for these: a missing claim has no
-- underlying source content to hash or cite.
INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('07f00004-0000-0000-0000-000000000201',
   '07f00003-0000-0000-0000-000000000002',
   'company.sector',
   'Fogline is a fintech analytics tool for community banks.',
   '"fintech"'::jsonb, NULL, 'self_reported', 'unverified', 'f07fix:claim:201'),

  ('07f00004-0000-0000-0000-000000000202',
   '07f00003-0000-0000-0000-000000000002',
   'company.business_model',
   'Business model: not disclosed.',
   NULL, NULL, 'derived', 'missing', NULL),

  ('07f00004-0000-0000-0000-000000000203',
   '07f00003-0000-0000-0000-000000000002',
   'company.geography_country',
   'Headquarters location: not disclosed.',
   NULL, NULL, 'derived', 'missing', NULL),

  ('07f00004-0000-0000-0000-000000000204',
   '07f00003-0000-0000-0000-000000000002',
   'company.stage_evidence',
   'Product stage: not disclosed.',
   NULL, NULL, 'derived', 'missing', NULL),

  ('07f00004-0000-0000-0000-000000000205',
   '07f00003-0000-0000-0000-000000000002',
   'company.what_is_built',
   'Product description: not disclosed.',
   NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

-- payload.text (see App A's note above for the key-name convention). Kept
-- genuinely one-line -- the sparseness is a property of the source text
-- itself, not just of what got extracted from it.
INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('07f00005-0000-0000-0000-000000000002',
   'deck_parse', NULL,
   '{"text": "Fogline is a fintech analytics tool for community banks.", "note": "fixture deck excerpt, not a full parse -- feature 07 sparse case, one usable page"}'::jsonb,
   'f07fix:rawsignal:app-b', '07f00001-0000-0000-0000-000000000002', '2026-07-11T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, raw_signal_id, content_hash) VALUES
  ('07f00006-0000-0000-0000-000000000201', '07f00004-0000-0000-0000-000000000201', 'supports', 'documented',
   'fintech analytics tool for community banks', '07f00005-0000-0000-0000-000000000002', 'f07fix:evidence:201')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Application C: StakeCircle -- well-extracted, hard deal-breaker (gambling)
-- ----------------------------------------------------------------------------

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('07f00001-0000-0000-0000-000000000003',
   'StakeCircle',
   'stakecircle-thesis07.example',
   'Real-money betting and casino-style wagering platform for consumers.',
   'gambling',
   'seed',
   '{"fixture_purpose": "feature 07 thesis-gate demo: well-extracted application that trips the default thesis''s one hand-authored hard deal-breaker (sector=gambling) -- proves failed is a confidently-observed fact, not a thin-deck accident (D-03)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('07f00002-0000-0000-0000-000000000003',
   '07f00001-0000-0000-0000-000000000003',
   'inbound', 'sourced', 's3://decks/07-thesis-engine/stakecircle.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('07f00003-0000-0000-0000-000000000003',
   'company',
   '07f00001-0000-0000-0000-000000000003',
   '07f00002-0000-0000-0000-000000000003',
   'confirmed', 0.90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('07f00004-0000-0000-0000-000000000301',
   '07f00003-0000-0000-0000-000000000003',
   'company.sector',
   'StakeCircle operates an online real-money gambling and betting platform.',
   '"gambling"'::jsonb, NULL, 'self_reported', 0.80, 'f07fix:claim:301'),

  ('07f00004-0000-0000-0000-000000000302',
   '07f00003-0000-0000-0000-000000000003',
   'company.business_model',
   'Consumers sign up directly and deposit funds to place wagers.',
   '"b2c"'::jsonb, NULL, 'self_reported', 0.75, 'f07fix:claim:302'),

  ('07f00004-0000-0000-0000-000000000303',
   '07f00003-0000-0000-0000-000000000003',
   'company.geography_country',
   'The team is incorporated and based in Amsterdam, Netherlands.',
   '"NL"'::jsonb, NULL, 'self_reported', 0.75, 'f07fix:claim:303'),

  ('07f00004-0000-0000-0000-000000000304',
   '07f00003-0000-0000-0000-000000000003',
   'company.stage_evidence',
   'The product has been live with paying users for eight months.',
   '"early_revenue"'::jsonb, NULL, 'self_reported', 0.70, 'f07fix:claim:304'),

  ('07f00004-0000-0000-0000-000000000305',
   '07f00003-0000-0000-0000-000000000003',
   'company.what_is_built',
   'StakeCircle is a real-money betting and casino-style wagering platform for consumers.',
   NULL, NULL, 'self_reported', 0.75, 'f07fix:claim:305')
ON CONFLICT (id) DO NOTHING;

-- payload.text (see App A's note above). Also happens to contain "betting"
-- (M_negkw, soft) alongside R1's hard trigger -- realistic (real decks say
-- both), and harmless: SS2's verdict procedure checks the hard rule (step 1)
-- before any soft deal-breaker (step 2b), so `failed` still wins here.
INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('07f00005-0000-0000-0000-000000000003',
   'deck_parse', NULL,
   '{"text": "StakeCircle operates an online real-money gambling and betting platform where consumers sign up directly and deposit funds to place wagers. The team is incorporated and based in Amsterdam, Netherlands, and the product has been live with paying users for eight months.", "note": "fixture deck excerpt, not a full parse -- feature 07 hard-deal-breaker case"}'::jsonb,
   'f07fix:rawsignal:app-c', '07f00001-0000-0000-0000-000000000003', '2026-07-12T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, raw_signal_id, content_hash) VALUES
  ('07f00006-0000-0000-0000-000000000301', '07f00004-0000-0000-0000-000000000301', 'supports', 'documented',
   'online real-money gambling and betting platform', '07f00005-0000-0000-0000-000000000003', 'f07fix:evidence:301'),
  ('07f00006-0000-0000-0000-000000000302', '07f00004-0000-0000-0000-000000000302', 'supports', 'documented',
   'deposit funds to place wagers', '07f00005-0000-0000-0000-000000000003', 'f07fix:evidence:302'),
  ('07f00006-0000-0000-0000-000000000303', '07f00004-0000-0000-0000-000000000303', 'supports', 'documented',
   'incorporated and based in Amsterdam, Netherlands', '07f00005-0000-0000-0000-000000000003', 'f07fix:evidence:303'),
  ('07f00006-0000-0000-0000-000000000304', '07f00004-0000-0000-0000-000000000304', 'supports', 'documented',
   'live with paying users for eight months', '07f00005-0000-0000-0000-000000000003', 'f07fix:evidence:304'),
  ('07f00006-0000-0000-0000-000000000305', '07f00004-0000-0000-0000-000000000305', 'supports', 'documented',
   'real-money betting and casino-style wagering platform', '07f00005-0000-0000-0000-000000000003', 'f07fix:evidence:305')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Application D: GameLoop -- well-extracted, soft deal-breaker only
-- (negative-keyword hit, sector NOT in R1's hard list) -- the fixture that
-- exercises "a soft deal-breaker yields borderline" (team-lead review
-- finding, 2026-07-19): C's gambling sector trips R1 (hard) first, so C can
-- never reach that verdict.
-- ----------------------------------------------------------------------------

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('07f00001-0000-0000-0000-000000000004',
   'GameLoop',
   'gameloop-thesis07.example',
   'SDK that lets mobile game publishers add real-money wagering mini-games to existing apps.',
   'consumer',
   'seed',
   '{"fixture_purpose": "feature 07 thesis-gate demo: well-extracted application whose sector is outside R1''s hard-listed set but whose text trips the mandate-compiled negative_keywords rule (M_negkw), a SOFT deal-breaker -- proves a soft deal-breaker down-ranks to borderline rather than blocking (D-01 / SS2 step 2b), isolated from C''s hard-rule case", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('07f00002-0000-0000-0000-000000000004',
   '07f00001-0000-0000-0000-000000000004',
   'inbound', 'sourced', 's3://decks/07-thesis-engine/gameloop.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('07f00003-0000-0000-0000-000000000004',
   'company',
   '07f00001-0000-0000-0000-000000000004',
   '07f00002-0000-0000-0000-000000000004',
   'confirmed', 0.90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('07f00004-0000-0000-0000-000000000401',
   '07f00003-0000-0000-0000-000000000004',
   'company.sector',
   'GameLoop is a consumer mobile gaming platform, not a gambling operator.',
   '"consumer"'::jsonb, NULL, 'self_reported', 0.75, 'f07fix:claim:401'),

  ('07f00004-0000-0000-0000-000000000402',
   '07f00003-0000-0000-0000-000000000004',
   'company.business_model',
   'Players download the app directly and pay for in-game credits themselves.',
   '"b2c"'::jsonb, NULL, 'self_reported', 0.75, 'f07fix:claim:402'),

  ('07f00004-0000-0000-0000-000000000403',
   '07f00003-0000-0000-0000-000000000004',
   'company.geography_country',
   'The team is based in Austin, Texas, United States.',
   '"US"'::jsonb, NULL, 'self_reported', 0.80, 'f07fix:claim:403'),

  ('07f00004-0000-0000-0000-000000000404',
   '07f00003-0000-0000-0000-000000000004',
   'company.stage_evidence',
   'GameLoop has been generating revenue from real users for the past five months.',
   '"early_revenue"'::jsonb, NULL, 'self_reported', 0.70, 'f07fix:claim:404'),

  -- Mirrors the raw_signals.payload.text below for realism (a real deck
  -- would say this in prose too) -- but this claim itself is NOT what trips
  -- M_negkw. `_text` never derives from claims (SS1.1); the raw_signals
  -- payload is the only thing that matters for that rule. See the
  -- raw_signals INSERT below.
  ('07f00004-0000-0000-0000-000000000405',
   '07f00003-0000-0000-0000-000000000004',
   'company.what_is_built',
   'GameLoop lets mobile game publishers add real-money betting mini-games that their casino partners can white-label inside existing apps.',
   NULL, NULL, 'self_reported', 0.70, 'f07fix:claim:405')
ON CONFLICT (id) DO NOTHING;

-- payload.text is THE point of this fixture (design.md SS1.1, team-lead
-- ruling 2026-07-19): `_text` is the gate's raw input text, never a
-- concatenation of claims, and on re-evaluation it resolves from exactly
-- this stored payload -- not from company.what_is_built or any other claim.
-- Names both configured negative_keywords ("casino", "betting") so M_negkw
-- (SS1.2: field=_text, op=contains, always soft by construction) fires
-- alone, with R1 (hard, keyed on the `sector` field, not `_text`) staying
-- silent because sector='consumer' is not in its list.
INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('07f00005-0000-0000-0000-000000000004',
   'deck_parse', NULL,
   '{"text": "GameLoop is a consumer mobile gaming platform, not a gambling operator. Players download the app directly and pay for in-game credits themselves. The team is based in Austin, Texas, United States, and has been generating revenue from real users for the past five months. GameLoop lets mobile game publishers add real-money betting mini-games that their casino partners can white-label inside existing apps.", "note": "fixture deck excerpt, not a full parse -- feature 07 soft-deal-breaker-only case"}'::jsonb,
   'f07fix:rawsignal:app-d', '07f00001-0000-0000-0000-000000000004', '2026-07-13T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, tier, quote_verbatim, raw_signal_id, content_hash) VALUES
  ('07f00006-0000-0000-0000-000000000401', '07f00004-0000-0000-0000-000000000401', 'supports', 'documented',
   'consumer mobile gaming platform, not a gambling operator', '07f00005-0000-0000-0000-000000000004', 'f07fix:evidence:401'),
  ('07f00006-0000-0000-0000-000000000402', '07f00004-0000-0000-0000-000000000402', 'supports', 'documented',
   'pay for in-game credits themselves', '07f00005-0000-0000-0000-000000000004', 'f07fix:evidence:402'),
  ('07f00006-0000-0000-0000-000000000403', '07f00004-0000-0000-0000-000000000403', 'supports', 'documented',
   'based in Austin, Texas, United States', '07f00005-0000-0000-0000-000000000004', 'f07fix:evidence:403'),
  ('07f00006-0000-0000-0000-000000000404', '07f00004-0000-0000-0000-000000000404', 'supports', 'documented',
   'generating revenue from real users for the past five months', '07f00005-0000-0000-0000-000000000004', 'f07fix:evidence:404'),
  ('07f00006-0000-0000-0000-000000000405', '07f00004-0000-0000-0000-000000000405', 'supports', 'documented',
   'real-money betting mini-games that their casino partners can white-label', '07f00005-0000-0000-0000-000000000004', 'f07fix:evidence:405')
ON CONFLICT (id) DO NOTHING;

COMMIT;
