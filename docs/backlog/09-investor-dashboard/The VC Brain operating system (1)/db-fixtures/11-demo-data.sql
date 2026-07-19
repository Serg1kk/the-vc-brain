-- db/fixtures/11-demo-data.sql
--
-- Feature 11 (demo data): 10 realistic synthetic applications for the investor
-- dashboard demo. 5 inbound (deck applications) + 5 radar_activated (found by
-- outbound scanning, deckless by design).
--
-- Conventions follow db/fixtures/03-founder-score.sql / 07-thesis-engine.sql:
--   * Fixed, explicitly-written UUIDs (never gen_random_uuid()) so rows are
--     reproducible and referenceable. Reserved range: 11f0....
--       11f0<TTTT>-0000-0000-0000-<SEQ>
--       TTTT = 0001 companies / 0002 applications / 0003 cards / 0004 claims /
--              0005 raw_signals / 0006 evidence / 0007 founders /
--              0008 founder_identities / 0009 founder_company / 000a events /
--              000b metric_observations
--       SEQ first digit groups by company (1xx..axx).
--   * Every INSERT ends with ON CONFLICT (id) DO NOTHING — idempotent re-runs.
--   * is_synthetic = true on every founder and company. All people and
--     companies are fictional; scenarios are modeled on real 2026 pre-seed
--     patterns. Never attach fabricated claims to real people (feature 11
--     ethics; the entity gate exists to prevent exactly that).
--   * NO scores / score_components / thesis_evaluations / memos rows here —
--     those are the pipelines' job (f03/f04/f05/f07 runs against this data),
--     same stance as fixture 07. This file supplies only source-of-truth rows:
--     founders, companies, identities, edges, applications, cards, claims,
--     raw_signals, evidence, metric_observations, and a few audit events.
--
-- Apply:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/11-demo-data.sql

BEGIN;

-- ============================================================================
-- INBOUND 1/5 — Voltaic Labs (Berlin, DE · ai-infra · b2b)
-- Fully extractable, on-thesis. Carries the demo's headline CONTRADICTION:
-- deck says "three paying pilot customers"; the company's own site says the
-- waitlist is still open. Documented-tier contradiction + claim_contradicted
-- event (the richest UI object in the system).
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000001', 'Jonas Reiter',
   'Systems engineer building GPU-aware inference routing',
   '{"pedigree": {"prior_employer": "SAP", "serial_founder": false}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000001', 'Voltaic Labs', 'voltaic-demo11.example',
   'On-prem inference gateway with GPU-aware routing for regulated EU enterprises.',
   'ai-infra', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: on-thesis inbound application with a documented contradiction (deck vs own website)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000101', '11f00007-0000-0000-0000-000000000001',
   'github', 'jreiter-voltaic', 'https://github.com/jreiter-voltaic', 0.95, 'github_api'),
  ('11f00008-0000-0000-0000-000000000102', '11f00007-0000-0000-0000-000000000001',
   'site', 'voltaic-demo11.example', 'https://voltaic-demo11.example', 0.95, 'tavily_extract')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000001', '11f00007-0000-0000-0000-000000000001',
   '11f00001-0000-0000-0000-000000000001', 'founder', true, 0.95, 'deck_parse')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000001', '11f00001-0000-0000-0000-000000000001',
   'inbound', 'screening', 's3://decks/11-demo/voltaic-labs.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000101', 'company',
   '11f00001-0000-0000-0000-000000000001', '11f00002-0000-0000-0000-000000000001', 'confirmed', 0.90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000102', 'founder',
   '11f00007-0000-0000-0000-000000000001', '11f00002-0000-0000-0000-000000000001', 'confirmed', 0.80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000101', 'deck_parse', NULL,
   '{"text": "Voltaic Labs builds an on-prem inference gateway with GPU-aware routing for regulated EU enterprises. Engineering platform teams pay per node. The founding team is based in Berlin, Germany. We are live with three paying pilot customers in banking and healthcare. Voltaic is developer tools and infrastructure for self-hosted model fleets.", "note": "fixture deck excerpt"}'::jsonb,
   'f11fix:rawsignal:101', '11f00001-0000-0000-0000-000000000001', '2026-07-14T09:12:00Z'),
  ('11f00005-0000-0000-0000-000000000102', 'tavily_extract', 'https://voltaic-demo11.example',
   '{"text": "Join the waitlist. Voltaic is in private beta with design partners. Request early access.", "note": "company homepage snapshot"}'::jsonb,
   'f11fix:rawsignal:102', '11f00001-0000-0000-0000-000000000001', '2026-07-16T11:40:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000103', 'github_api', 'https://github.com/jreiter-voltaic',
   '{"repos": [{"name": "voltaic-gateway", "stars": 3100, "forks": 210, "pushed_weeks_active": 11}], "followers": 340, "note": "profile snapshot"}'::jsonb,
   'f11fix:rawsignal:103', '11f00007-0000-0000-0000-000000000001', '2026-07-16T11:44:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000101', '11f00003-0000-0000-0000-000000000101',
   'company.sector', 'Voltaic Labs builds an on-prem inference gateway for regulated EU enterprises.',
   '"ai-infra"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:101'),
  ('11f00004-0000-0000-0000-000000000102', '11f00003-0000-0000-0000-000000000101',
   'company.business_model', 'Engineering platform teams pay per node.',
   '"b2b"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:102'),
  ('11f00004-0000-0000-0000-000000000103', '11f00003-0000-0000-0000-000000000101',
   'company.geography_country', 'The founding team is based in Berlin, Germany.',
   '"DE"'::jsonb, NULL, 'self_reported', 0.80, 'f11fix:claim:103'),
  ('11f00004-0000-0000-0000-000000000104', '11f00003-0000-0000-0000-000000000101',
   'company.stage_evidence', 'We are live with three paying pilot customers in banking and healthcare.',
   '"early_revenue"'::jsonb, NULL, 'self_reported', 0.60, 'f11fix:claim:104'),
  ('11f00004-0000-0000-0000-000000000105', '11f00003-0000-0000-0000-000000000101',
   'company.what_is_built', 'Voltaic is developer tools and infrastructure: an inference gateway with GPU-aware routing for self-hosted model fleets.',
   NULL, NULL, 'self_reported', 0.75, 'f11fix:claim:105'),
  ('11f00004-0000-0000-0000-000000000106', '11f00003-0000-0000-0000-000000000102',
   'founder.execution.commit_consistency', 'Jonas has shipped weekly to voltaic-gateway for the last eleven weeks.',
   NULL, NULL, 'public', 0.80, 'f11fix:claim:106'),
  ('11f00004-0000-0000-0000-000000000107', '11f00003-0000-0000-0000-000000000102',
   'founder.expertise.vertical_tenure', 'Six years on SAP''s in-memory database kernel team before founding Voltaic.',
   NULL, NULL, 'self_reported', 0.60, 'f11fix:claim:107'),
  ('11f00004-0000-0000-0000-000000000108', '11f00003-0000-0000-0000-000000000102',
   'founder.leadership.icp_specificity', 'Our buyer is the platform-engineering lead at a 1,000+ seat regulated enterprise running self-hosted models, currently gluing vLLM and spreadsheets together, triggered by an internal audit finding.',
   NULL, NULL, 'self_reported', 0.60, 'f11fix:claim:108')
ON CONFLICT (id) DO NOTHING;

-- Not-disclosed gaps are first-class rows (REQ-004), not omissions.
INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000109', '11f00003-0000-0000-0000-000000000101',
   'round.cap_table', 'Cap table: not disclosed.', NULL, NULL, 'derived', 'missing', NULL),
  ('11f00004-0000-0000-0000-00000000010a', '11f00003-0000-0000-0000-000000000101',
   'round.prior_funding', 'Prior funding: not disclosed.', NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000101', '11f00004-0000-0000-0000-000000000101', 'supports', 0.90, 'documented',
   'on-prem inference gateway with GPU-aware routing for regulated EU enterprises', NULL, '11f00005-0000-0000-0000-000000000101', 'f11fix:evidence:101'),
  ('11f00006-0000-0000-0000-000000000102', '11f00004-0000-0000-0000-000000000102', 'supports', 0.90, 'documented',
   'Engineering platform teams pay per node', NULL, '11f00005-0000-0000-0000-000000000101', 'f11fix:evidence:102'),
  ('11f00006-0000-0000-0000-000000000103', '11f00004-0000-0000-0000-000000000103', 'supports', 0.90, 'documented',
   'based in Berlin, Germany', NULL, '11f00005-0000-0000-0000-000000000101', 'f11fix:evidence:103'),
  -- The contradiction: the company's own homepage vs the deck's pilot claim.
  ('11f00006-0000-0000-0000-000000000104', '11f00004-0000-0000-0000-000000000104', 'supports', 0.60, 'documented',
   'live with three paying pilot customers', NULL, '11f00005-0000-0000-0000-000000000101', 'f11fix:evidence:104'),
  ('11f00006-0000-0000-0000-000000000105', '11f00004-0000-0000-0000-000000000104', 'contradicts', 0.90, 'documented',
   'Join the waitlist. Voltaic is in private beta with design partners.', 'https://voltaic-demo11.example', '11f00005-0000-0000-0000-000000000102', 'f11fix:evidence:105'),
  ('11f00006-0000-0000-0000-000000000106', '11f00004-0000-0000-0000-000000000106', 'supports', 0.90, 'documented',
   'pushed_weeks_active: 11', 'https://github.com/jreiter-voltaic', '11f00005-0000-0000-0000-000000000103', 'f11fix:evidence:106')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, event_type, entity_type, entity_id, payload, actor) VALUES
  ('11f0000a-0000-0000-0000-000000000101', 'claim_contradicted', 'application',
   '11f00002-0000-0000-0000-000000000001',
   '{"claim_id": "11f00004-0000-0000-0000-000000000104", "class": "factual_dynamic", "check": "web_traction", "verdict_before": "unverified", "verdict_after": "contradicted", "source_url": "https://voltaic-demo11.example", "checked_at": "2026-07-16T11:41:00Z", "run_id": "f11fix-run-101", "nature": "factual", "severity": "moderate", "founder_claim": "We are live with three paying pilot customers in banking and healthcare.", "found_reality": "Company homepage invites visitors to join the waitlist and describes a private beta with design partners.", "question": "Which of the three pilots are paying today, and can we speak to one of them?", "entity_match": {"resolved_by": "domain", "quote": "Voltaic is in private beta", "disambiguator": "voltaic-demo11.example"}}'::jsonb,
   'f11-fixture')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- INBOUND 2/5 — Cassia Health (Amsterdam, NL · healthtech · b2b)
-- Well-extracted, on-geo; stage evidence NOT disclosed (one honest gap).
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000002', 'Femke de Winter',
   'Former GP practice manager; building ambient clinical documentation',
   '{"pedigree": {"prior_employer": "Nivel (research institute)", "serial_founder": false}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000002', 'Cassia Health', 'cassia-demo11.example',
   'Ambient clinical documentation for Dutch GP practices, tuned to NHG guidelines.',
   'healthtech', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: on-geo inbound with a stage_evidence gap (not disclosed)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000002', '11f00007-0000-0000-0000-000000000002',
   '11f00001-0000-0000-0000-000000000002', 'founder', true, 0.95, 'deck_parse')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000002', '11f00001-0000-0000-0000-000000000002',
   'inbound', 'sourced', 's3://decks/11-demo/cassia-health.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000201', 'company',
   '11f00001-0000-0000-0000-000000000002', '11f00002-0000-0000-0000-000000000002', 'confirmed', 0.80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000201', 'deck_parse', NULL,
   '{"text": "Cassia Health builds ambient clinical documentation for Dutch GP practices, tuned to NHG guidelines. Practices subscribe per clinician seat. We are based in Amsterdam, Netherlands. Twelve practices are on our discovery-interview panel.", "note": "fixture deck excerpt"}'::jsonb,
   'f11fix:rawsignal:201', '11f00001-0000-0000-0000-000000000002', '2026-07-15T08:30:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000201', '11f00003-0000-0000-0000-000000000201',
   'company.sector', 'Ambient clinical documentation for Dutch GP practices.',
   '"healthtech"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:201'),
  ('11f00004-0000-0000-0000-000000000202', '11f00003-0000-0000-0000-000000000201',
   'company.business_model', 'Practices subscribe per clinician seat.',
   '"b2b"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:202'),
  ('11f00004-0000-0000-0000-000000000203', '11f00003-0000-0000-0000-000000000201',
   'company.geography_country', 'We are based in Amsterdam, Netherlands.',
   '"NL"'::jsonb, NULL, 'self_reported', 0.80, 'f11fix:claim:203'),
  ('11f00004-0000-0000-0000-000000000204', '11f00003-0000-0000-0000-000000000201',
   'company.what_is_built', 'Ambient documentation that listens to consultations and drafts the record against NHG guideline codes.',
   NULL, NULL, 'self_reported', 0.70, 'f11fix:claim:204')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000205', '11f00003-0000-0000-0000-000000000201',
   'company.stage_evidence', 'Product stage: not disclosed.', NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000201', '11f00004-0000-0000-0000-000000000201', 'supports', 0.90, 'documented',
   'ambient clinical documentation for Dutch GP practices', NULL, '11f00005-0000-0000-0000-000000000201', 'f11fix:evidence:201'),
  ('11f00006-0000-0000-0000-000000000202', '11f00004-0000-0000-0000-000000000202', 'supports', 0.90, 'documented',
   'Practices subscribe per clinician seat', NULL, '11f00005-0000-0000-0000-000000000201', 'f11fix:evidence:202'),
  ('11f00006-0000-0000-0000-000000000203', '11f00004-0000-0000-0000-000000000203', 'supports', 0.90, 'documented',
   'based in Amsterdam, Netherlands', NULL, '11f00005-0000-0000-0000-000000000201', 'f11fix:evidence:203')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- INBOUND 3/5 — Kelpgrid (Copenhagen, DK · climate/energy · b2b)
-- Well-extracted but DK is outside the default thesis geos → "Outside thesis"
-- lane demo (outside mandate, not "bad company").
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000003', 'Nikolaj Brandt',
   'Power-markets quant; forecasting for grid-scale battery arbitrage',
   '{"pedigree": {"prior_employer": "Ørsted (trading desk)", "serial_founder": true}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000003', 'Kelpgrid', 'kelpgrid-demo11.example',
   'Forecasting API for grid-scale battery arbitrage on Nordic intraday markets.',
   'climate-energy', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: strong application outside the default thesis geographies (DK) — exercises the Outside-thesis lane", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000003', '11f00007-0000-0000-0000-000000000003',
   '11f00001-0000-0000-0000-000000000003', 'founder', true, 0.95, 'deck_parse')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000003', '11f00001-0000-0000-0000-000000000003',
   'inbound', 'sourced', 's3://decks/11-demo/kelpgrid.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000301', 'company',
   '11f00001-0000-0000-0000-000000000003', '11f00002-0000-0000-0000-000000000003', 'confirmed', 0.85)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000301', 'deck_parse', NULL,
   '{"text": "Kelpgrid sells a forecasting API for grid-scale battery arbitrage on Nordic intraday markets. Battery asset operators pay per MW under management. The team is based in Copenhagen, Denmark. One operator with 40 MW under management has signed a paid pilot.", "note": "fixture deck excerpt"}'::jsonb,
   'f11fix:rawsignal:301', '11f00001-0000-0000-0000-000000000003', '2026-07-13T10:05:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000301', '11f00003-0000-0000-0000-000000000301',
   'company.sector', 'Forecasting API for grid-scale battery arbitrage.',
   '"climate-energy"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:301'),
  ('11f00004-0000-0000-0000-000000000302', '11f00003-0000-0000-0000-000000000301',
   'company.business_model', 'Battery asset operators pay per MW under management.',
   '"b2b"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:302'),
  ('11f00004-0000-0000-0000-000000000303', '11f00003-0000-0000-0000-000000000301',
   'company.geography_country', 'The team is based in Copenhagen, Denmark.',
   '"DK"'::jsonb, NULL, 'self_reported', 0.80, 'f11fix:claim:303'),
  ('11f00004-0000-0000-0000-000000000304', '11f00003-0000-0000-0000-000000000301',
   'company.stage_evidence', 'One operator with 40 MW under management has signed a paid pilot.',
   '"early_revenue"'::jsonb, NULL, 'self_reported', 0.65, 'f11fix:claim:304'),
  ('11f00004-0000-0000-0000-000000000305', '11f00003-0000-0000-0000-000000000301',
   'company.what_is_built', 'A forecasting API that prices intraday battery arbitrage windows for Nordic markets.',
   NULL, NULL, 'self_reported', 0.70, 'f11fix:claim:305')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000301', '11f00004-0000-0000-0000-000000000301', 'supports', 0.90, 'documented',
   'forecasting API for grid-scale battery arbitrage', NULL, '11f00005-0000-0000-0000-000000000301', 'f11fix:evidence:301'),
  ('11f00006-0000-0000-0000-000000000302', '11f00004-0000-0000-0000-000000000303', 'supports', 0.90, 'documented',
   'based in Copenhagen, Denmark', NULL, '11f00005-0000-0000-0000-000000000301', 'f11fix:evidence:302'),
  ('11f00006-0000-0000-0000-000000000303', '11f00004-0000-0000-0000-000000000304', 'supports', 0.70, 'documented',
   'One operator with 40 MW under management has signed a paid pilot', NULL, '11f00005-0000-0000-0000-000000000301', 'f11fix:evidence:303')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- INBOUND 4/5 — Ledgerline (Paris, FR · fintech-compliance · b2b)
-- On-thesis-adjacent; carries a FORECAST claim (market.size_tam) that must
-- never enter the verification queue, plus a qualitative judgement claim.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000004', 'Claire Bosquet',
   'Ex-Big-4 auditor; audit trails for AI-generated accounting entries',
   '{"pedigree": {"prior_employer": "Mazars", "serial_founder": false}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000004', 'Ledgerline', 'ledgerline-demo11.example',
   'Autonomous audit-trail agents for AI-generated accounting entries.',
   'fintech', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: inbound with a TAM forecast claim (never verdict-eligible) and a qualitative judgement claim", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000004', '11f00007-0000-0000-0000-000000000004',
   '11f00001-0000-0000-0000-000000000004', 'founder', true, 0.95, 'deck_parse')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000004', '11f00001-0000-0000-0000-000000000004',
   'inbound', 'sourced', 's3://decks/11-demo/ledgerline.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000401', 'company',
   '11f00001-0000-0000-0000-000000000004', '11f00002-0000-0000-0000-000000000004', 'confirmed', 0.85)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000401', 'deck_parse', NULL,
   '{"text": "Ledgerline builds autonomous audit-trail agents for AI-generated accounting entries. Mid-market accounting firms pay per entity audited. The team is based in Paris, France. The market for AI audit tooling will reach $6B by 2029. Claire writes with unusual clarity about where auditors actually lose time.", "note": "fixture deck excerpt"}'::jsonb,
   'f11fix:rawsignal:401', '11f00001-0000-0000-0000-000000000004', '2026-07-12T14:20:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000401', '11f00003-0000-0000-0000-000000000401',
   'company.sector', 'Autonomous audit-trail agents for AI-generated accounting entries.',
   '"fintech"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:401'),
  ('11f00004-0000-0000-0000-000000000402', '11f00003-0000-0000-0000-000000000401',
   'company.business_model', 'Mid-market accounting firms pay per entity audited.',
   '"b2b"'::jsonb, NULL, 'self_reported', 0.75, 'f11fix:claim:402'),
  ('11f00004-0000-0000-0000-000000000403', '11f00003-0000-0000-0000-000000000401',
   'company.geography_country', 'The team is based in Paris, France.',
   '"FR"'::jsonb, NULL, 'self_reported', 0.80, 'f11fix:claim:403'),
  -- FORECAST: market.size_* routes to class=forecast — labeled, never verified.
  ('11f00004-0000-0000-0000-000000000404', '11f00003-0000-0000-0000-000000000401',
   'market.size_tam', 'The market for AI audit tooling will reach $6B by 2029.',
   '{"tam_usd_high": 6000000000, "year": 2029}'::jsonb, NULL, 'self_reported', 0.50, 'f11fix:claim:404'),
  -- Qualitative: founder.leadership.* routes to class=qualitative — pinned to
  -- unverified by design (judgement, not a checkable fact).
  ('11f00004-0000-0000-0000-000000000405', '11f00003-0000-0000-0000-000000000401',
   'company.what_is_built', 'Agents that reconstruct and sign the audit trail behind every AI-generated ledger entry.',
   NULL, NULL, 'self_reported', 0.70, 'f11fix:claim:405')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000401', '11f00004-0000-0000-0000-000000000401', 'supports', 0.90, 'documented',
   'autonomous audit-trail agents for AI-generated accounting entries', NULL, '11f00005-0000-0000-0000-000000000401', 'f11fix:evidence:401'),
  ('11f00006-0000-0000-0000-000000000402', '11f00004-0000-0000-0000-000000000403', 'supports', 0.90, 'documented',
   'based in Paris, France', NULL, '11f00005-0000-0000-0000-000000000401', 'f11fix:evidence:402'),
  ('11f00006-0000-0000-0000-000000000403', '11f00004-0000-0000-0000-000000000404', 'supports', 0.50, 'documented',
   'will reach $6B by 2029', NULL, '11f00005-0000-0000-0000-000000000401', 'f11fix:evidence:403')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- INBOUND 5/5 — Playdrift (Austin, US · consumer gaming · b2c)
-- Deliberately sparse deck: 3 of 5 attributes missing → insufficient_evidence
-- by construction (like fixture 07's Fogline). Also off-sector.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000005', 'Marcus Vale', NULL,
   '{"note": "Fictional person for demo purposes. Deck disclosed almost nothing about the founder."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000005', 'Playdrift', 'playdrift-demo11.example',
   'Monetization SDK for user-generated game content.',
   'consumer', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: sparse deck, 3 of 5 attributes missing — forces insufficient_evidence; also off-sector", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000005', '11f00007-0000-0000-0000-000000000005',
   '11f00001-0000-0000-0000-000000000005', 'founder', true, 0.90, 'deck_parse')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000005', '11f00001-0000-0000-0000-000000000005',
   'inbound', 'sourced', 's3://decks/11-demo/playdrift.pdf')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, company_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000501', 'company',
   '11f00001-0000-0000-0000-000000000005', '11f00002-0000-0000-0000-000000000005', 'draft', 0.25)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000501', 'deck_parse', NULL,
   '{"text": "Playdrift is a monetization SDK for user-generated game content. Creators earn; platforms grow.", "note": "fixture deck excerpt — four slides, almost no checkable content"}'::jsonb,
   'f11fix:rawsignal:501', '11f00001-0000-0000-0000-000000000005', '2026-07-17T16:45:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000501', '11f00003-0000-0000-0000-000000000501',
   'company.sector', 'Playdrift is a monetization SDK for user-generated game content.',
   '"consumer"'::jsonb, NULL, 'self_reported', 0.70, 'f11fix:claim:501'),
  ('11f00004-0000-0000-0000-000000000502', '11f00003-0000-0000-0000-000000000501',
   'company.what_is_built', 'An SDK that lets game platforms pay creators for user-generated content.',
   NULL, NULL, 'self_reported', 0.60, 'f11fix:claim:502')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000503', '11f00003-0000-0000-0000-000000000501',
   'company.business_model', 'Business model: not disclosed.', NULL, NULL, 'derived', 'missing', NULL),
  ('11f00004-0000-0000-0000-000000000504', '11f00003-0000-0000-0000-000000000501',
   'company.geography_country', 'Headquarters location: not disclosed.', NULL, NULL, 'derived', 'missing', NULL),
  ('11f00004-0000-0000-0000-000000000505', '11f00003-0000-0000-0000-000000000501',
   'company.stage_evidence', 'Product stage: not disclosed.', NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000501', '11f00004-0000-0000-0000-000000000501', 'supports', 0.90, 'documented',
   'monetization SDK for user-generated game content', NULL, '11f00005-0000-0000-0000-000000000501', 'f11fix:evidence:501')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- RADAR 1/5 — tracewire / Mila Sørensen (Berlin, DE · ai-infra)
-- The flagship radar story: high-obscurity founder, strong documented GitHub
-- execution signals, Show HN identity link. Deckless by design.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000006', 'Mila Sørensen',
   'eBPF engineer; token-level tracing for LLM serving stacks',
   '{"pedigree": {"prior_employer": null, "serial_founder": false}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000006', 'tracewire', 'tracewire-demo11.example',
   'eBPF-based token-level tracing for self-hosted LLM serving stacks.',
   'ai-infra', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: flagship radar-discovered founder — never applied, no deck, scored by the same pipeline as inbound", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000601', '11f00007-0000-0000-0000-000000000006',
   'hn', 'milasorensen', 'https://news.ycombinator.com/user?id=milasorensen', 0.95, 'hn_algolia'),
  ('11f00008-0000-0000-0000-000000000602', '11f00007-0000-0000-0000-000000000006',
   'github', 'mila-tracewire', 'https://github.com/mila-tracewire', 0.85, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000006', '11f00007-0000-0000-0000-000000000006',
   '11f00001-0000-0000-0000-000000000006', 'founder', true, 0.85, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000006', '11f00001-0000-0000-0000-000000000006',
   'radar_activated', 'sourced', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000601', 'founder',
   '11f00007-0000-0000-0000-000000000006', '11f00002-0000-0000-0000-000000000006', 'prefilled', 0.60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000601', 'hn_algolia', 'https://news.ycombinator.com/item?id=44811203',
   '{"title": "Show HN: tracewire — eBPF token-level tracing for LLM serving", "points": 312, "num_comments": 148, "author": "milasorensen", "author_replies": 23, "text": "I built tracewire because we kept losing tokens between the router and the runner and nothing in the stack could tell us where.", "note": "Show HN thread snapshot"}'::jsonb,
   'f11fix:rawsignal:601', '11f00007-0000-0000-0000-000000000006', '2026-07-15T18:00:00Z'),
  ('11f00005-0000-0000-0000-000000000602', 'github_api', 'https://github.com/mila-tracewire/tracewire',
   '{"repo": {"name": "tracewire", "stars": 2100, "forks": 96, "dependents": 41, "pushed_weeks_active": 12, "first_commit": "2025-11-02"}, "followers": 14, "merged_prs_foreign": [{"repo": "cilium/ebpf", "merged_at": "2026-03-11"}], "note": "profile + repo snapshot"}'::jsonb,
   'f11fix:rawsignal:602', '11f00007-0000-0000-0000-000000000006', '2026-07-16T02:10:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000601', '11f00003-0000-0000-0000-000000000601',
   'founder.execution.merged_pr_foreign', 'Merged a pull request into cilium/ebpf in March 2026.',
   NULL, NULL, 'public', 0.90, 'f11fix:claim:601'),
  ('11f00004-0000-0000-0000-000000000602', '11f00003-0000-0000-0000-000000000601',
   'founder.execution.commit_consistency', 'Commits present in 12 of the last 12 weeks on tracewire.',
   NULL, NULL, 'public', 0.90, 'f11fix:claim:602'),
  ('11f00004-0000-0000-0000-000000000603', '11f00003-0000-0000-0000-000000000601',
   'founder.execution.external_usage', '41 packages depend on tracewire; 96 forks.',
   NULL, NULL, 'public', 0.85, 'f11fix:claim:603'),
  ('11f00004-0000-0000-0000-000000000604', '11f00003-0000-0000-0000-000000000601',
   'founder.leadership.compression', 'The Show HN post states the problem, the mechanism and the limitation in three sentences.',
   NULL, NULL, 'public', 0.60, 'f11fix:claim:604'),
  ('11f00004-0000-0000-0000-000000000605', '11f00003-0000-0000-0000-000000000601',
   'founder.expertise.unrequested_work', 'Built tracewire over eight months before any funding or employer sponsorship.',
   NULL, NULL, 'self_reported', 0.50, 'f11fix:claim:605')
ON CONFLICT (id) DO NOTHING;

-- Provenance check ran and found nothing — a first-class "searched, nothing
-- found" evidence row (tier='missing', no quote by definition).
INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000606', '11f00003-0000-0000-0000-000000000601',
   'founder.execution.provenance', 'Commit history predating the Show HN post: no commit-level data available.',
   NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000601', '11f00004-0000-0000-0000-000000000601', 'supports', 0.90, 'documented',
   'merged_prs_foreign: cilium/ebpf, 2026-03-11', 'https://github.com/mila-tracewire', '11f00005-0000-0000-0000-000000000602', 'f11fix:evidence:601'),
  ('11f00006-0000-0000-0000-000000000602', '11f00004-0000-0000-0000-000000000602', 'supports', 0.90, 'documented',
   'pushed_weeks_active: 12', 'https://github.com/mila-tracewire/tracewire', '11f00005-0000-0000-0000-000000000602', 'f11fix:evidence:602'),
  ('11f00006-0000-0000-0000-000000000603', '11f00004-0000-0000-0000-000000000603', 'supports', 0.90, 'documented',
   'dependents: 41, forks: 96', 'https://github.com/mila-tracewire/tracewire', '11f00005-0000-0000-0000-000000000602', 'f11fix:evidence:603'),
  ('11f00006-0000-0000-0000-000000000604', '11f00004-0000-0000-0000-000000000604', 'supports', 0.80, 'discovered',
   'I built tracewire because we kept losing tokens between the router and the runner and nothing in the stack could tell us where.', 'https://news.ycombinator.com/item?id=44811203', '11f00005-0000-0000-0000-000000000601', 'f11fix:evidence:604'),
  ('11f00006-0000-0000-0000-000000000605', '11f00004-0000-0000-0000-000000000606', 'context', 0.00, 'missing',
   NULL, 'https://github.com/mila-tracewire/tracewire', '11f00005-0000-0000-0000-000000000602', 'f11fix:evidence:605')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_observations (id, metric, founder_id, value, observed_at) VALUES
  ('11f0000b-0000-0000-0000-000000000601', 'gh_followers', '11f00007-0000-0000-0000-000000000006', 14, '2026-07-16T02:10:00Z'),
  ('11f0000b-0000-0000-0000-000000000602', 'hn_karma', '11f00007-0000-0000-0000-000000000006', 89, '2026-07-16T02:10:00Z'),
  ('11f0000b-0000-0000-0000-000000000603', 'hn_points', '11f00007-0000-0000-0000-000000000006', 312, '2026-07-16T02:10:00Z'),
  ('11f0000b-0000-0000-0000-000000000604', 'hn_author_replies', '11f00007-0000-0000-0000-000000000006', 23, '2026-07-16T02:10:00Z'),
  ('11f0000b-0000-0000-0000-000000000605', 'gh_dependents', '11f00007-0000-0000-0000-000000000006', 41, '2026-07-16T02:10:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, event_type, entity_type, entity_id, payload, actor) VALUES
  ('11f0000a-0000-0000-0000-000000000601', 'radar_scan_completed', 'founder',
   '11f00007-0000-0000-0000-000000000006',
   '{"channel": "hn_algolia", "candidates_seen": 214, "activated": 1, "run_id": "f11fix-radar-601"}'::jsonb,
   'f11-fixture')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- RADAR 2/5 — quietgpu / Andrei Balan (Bucharest, RO)
-- HN-only identity (no cross-platform link) — the 64% normal branch.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000007', 'Andrei Balan',
   'Fractional GPU scheduling for small clusters',
   '{"note": "Fictional person for demo purposes. HN-only identity — no cross-platform link resolved."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000007', 'quietgpu', 'quietgpu-demo11.example',
   'Fractional GPU scheduler for small on-prem clusters.',
   'ai-infra', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: HN-only radar candidate (identity unresolved across platforms — the normal branch, not an error)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000701', '11f00007-0000-0000-0000-000000000007',
   'hn', 'abalan_gpu', 'https://news.ycombinator.com/user?id=abalan_gpu', 0.95, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000007', '11f00007-0000-0000-0000-000000000007',
   '11f00001-0000-0000-0000-000000000007', 'founder', true, 0.85, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000007', '11f00001-0000-0000-0000-000000000007',
   'radar_activated', 'sourced', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000701', 'founder',
   '11f00007-0000-0000-0000-000000000007', '11f00002-0000-0000-0000-000000000007', 'prefilled', 0.40)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000701', 'hn_algolia', 'https://news.ycombinator.com/item?id=44807551',
   '{"title": "Show HN: quietgpu — fractional GPU scheduling without Kubernetes", "points": 178, "num_comments": 84, "author": "abalan_gpu", "author_replies": 31, "text": "quietgpu slices a single A100 across up to nine inference jobs with per-job memory fences. No k8s, one binary.", "note": "Show HN thread snapshot"}'::jsonb,
   'f11fix:rawsignal:701', '11f00007-0000-0000-0000-000000000007', '2026-07-14T20:30:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000701', '11f00003-0000-0000-0000-000000000701',
   'founder.leadership.compression', 'quietgpu slices a single A100 across up to nine inference jobs with per-job memory fences. No k8s, one binary.',
   NULL, NULL, 'public', 0.60, 'f11fix:claim:701'),
  ('11f00004-0000-0000-0000-000000000702', '11f00003-0000-0000-0000-000000000701',
   'founder.execution.traction', 'Author replied 31 times in their own Show HN thread, including to critical comments about memory-fence overhead.',
   NULL, NULL, 'public', 0.70, 'f11fix:claim:702')
ON CONFLICT (id) DO NOTHING;

-- GitHub was searched for this author and no account could be linked —
-- searched-nothing-found, not never-checked.
INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000703', '11f00003-0000-0000-0000-000000000701',
   'founder.execution.provenance', 'Cross-platform identity: searched GitHub for a linkable account; none found.',
   NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000701', '11f00004-0000-0000-0000-000000000701', 'supports', 0.80, 'discovered',
   'quietgpu slices a single A100 across up to nine inference jobs with per-job memory fences. No k8s, one binary.', 'https://news.ycombinator.com/item?id=44807551', '11f00005-0000-0000-0000-000000000701', 'f11fix:evidence:701'),
  ('11f00006-0000-0000-0000-000000000702', '11f00004-0000-0000-0000-000000000702', 'supports', 0.80, 'discovered',
   'author_replies: 31', 'https://news.ycombinator.com/item?id=44807551', '11f00005-0000-0000-0000-000000000701', 'f11fix:evidence:702'),
  ('11f00006-0000-0000-0000-000000000703', '11f00004-0000-0000-0000-000000000703', 'context', 0.00, 'missing',
   NULL, 'https://github.com/search?q=abalan_gpu', '11f00005-0000-0000-0000-000000000701', 'f11fix:evidence:703')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_observations (id, metric, founder_id, value, observed_at) VALUES
  ('11f0000b-0000-0000-0000-000000000701', 'hn_karma', '11f00007-0000-0000-0000-000000000007', 412, '2026-07-14T20:30:00Z'),
  ('11f0000b-0000-0000-0000-000000000702', 'hn_points', '11f00007-0000-0000-0000-000000000007', 178, '2026-07-14T20:30:00Z'),
  ('11f0000b-0000-0000-0000-000000000703', 'hn_author_replies', '11f00007-0000-0000-0000-000000000007', 31, '2026-07-14T20:30:00Z')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- RADAR 3/5 — saltmarsh / Priya Raman (London, UK)
-- Strong externally-verifiable execution: merged PRs into a major project,
-- live demo URL, measured dependents. Lower obscurity (visible person).
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000008', 'Priya Raman',
   'Postgres internals; row-level data lineage as an extension',
   '{"pedigree": {"prior_employer": "Timescale", "serial_founder": false}, "note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000008', 'saltmarsh', 'saltmarsh-demo11.example',
   'Postgres extension for row-level data lineage and audit.',
   'devtools', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: low-obscurity radar candidate with strong documented execution signals (E1, E4, E5 all evidencable)", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000801', '11f00007-0000-0000-0000-000000000008',
   'github', 'priyar-pg', 'https://github.com/priyar-pg', 0.95, 'github_api'),
  ('11f00008-0000-0000-0000-000000000802', '11f00007-0000-0000-0000-000000000008',
   'hn', 'priyar_pg', 'https://news.ycombinator.com/user?id=priyar_pg', 0.90, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000008', '11f00007-0000-0000-0000-000000000008',
   '11f00001-0000-0000-0000-000000000008', 'founder', true, 0.90, 'github_api')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000008', '11f00001-0000-0000-0000-000000000008',
   'radar_activated', 'screening', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000801', 'founder',
   '11f00007-0000-0000-0000-000000000008', '11f00002-0000-0000-0000-000000000008', 'prefilled', 0.70)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000801', 'github_api', 'https://github.com/priyar-pg',
   '{"repo": {"name": "saltmarsh", "stars": 4800, "forks": 240, "dependents": 130, "pushed_weeks_active": 10}, "followers": 640, "merged_prs_foreign": [{"repo": "postgres/postgres", "merged_at": "2026-01-22"}, {"repo": "pgvector/pgvector", "merged_at": "2026-04-03"}], "note": "profile + repo snapshot"}'::jsonb,
   'f11fix:rawsignal:801', '11f00007-0000-0000-0000-000000000008', '2026-07-15T05:20:00Z'),
  ('11f00005-0000-0000-0000-000000000802', 'tavily_extract', 'https://saltmarsh-demo11.example/demo',
   '{"text": "Live playground: trace any row back through every transform. Status: responding, TLS valid.", "note": "liveness snapshot"}'::jsonb,
   'f11fix:rawsignal:802', '11f00007-0000-0000-0000-000000000008', '2026-07-15T05:25:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000801', '11f00003-0000-0000-0000-000000000801',
   'founder.execution.merged_pr_foreign', 'Merged PRs into postgres/postgres and pgvector/pgvector within 12 months.',
   NULL, NULL, 'public', 0.90, 'f11fix:claim:801'),
  ('11f00004-0000-0000-0000-000000000802', '11f00003-0000-0000-0000-000000000801',
   'founder.execution.live_product', 'A live playground at saltmarsh-demo11.example/demo responds with a working traced query.',
   NULL, NULL, 'public', 0.85, 'f11fix:claim:802'),
  ('11f00004-0000-0000-0000-000000000803', '11f00003-0000-0000-0000-000000000801',
   'founder.execution.external_usage', '130 packages depend on saltmarsh; 240 forks.',
   NULL, NULL, 'public', 0.85, 'f11fix:claim:803'),
  ('11f00004-0000-0000-0000-000000000804', '11f00003-0000-0000-0000-000000000801',
   'founder.expertise.vertical_tenure', 'Four years on Timescale''s storage engine before saltmarsh.',
   NULL, NULL, 'self_reported', 0.55, 'f11fix:claim:804')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000801', '11f00004-0000-0000-0000-000000000801', 'supports', 0.90, 'documented',
   'merged_prs_foreign: postgres/postgres 2026-01-22; pgvector/pgvector 2026-04-03', 'https://github.com/priyar-pg', '11f00005-0000-0000-0000-000000000801', 'f11fix:evidence:801'),
  ('11f00006-0000-0000-0000-000000000802', '11f00004-0000-0000-0000-000000000802', 'supports', 0.90, 'documented',
   'Status: responding, TLS valid', 'https://saltmarsh-demo11.example/demo', '11f00005-0000-0000-0000-000000000802', 'f11fix:evidence:802'),
  ('11f00006-0000-0000-0000-000000000803', '11f00004-0000-0000-0000-000000000803', 'supports', 0.90, 'documented',
   'dependents: 130, forks: 240', 'https://github.com/priyar-pg', '11f00005-0000-0000-0000-000000000801', 'f11fix:evidence:803')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_observations (id, metric, founder_id, value, observed_at) VALUES
  ('11f0000b-0000-0000-0000-000000000801', 'gh_followers', '11f00007-0000-0000-0000-000000000008', 640, '2026-07-15T05:20:00Z'),
  ('11f0000b-0000-0000-0000-000000000802', 'hn_karma', '11f00007-0000-0000-0000-000000000008', 2140, '2026-07-15T05:20:00Z'),
  ('11f0000b-0000-0000-0000-000000000803', 'gh_dependents', '11f00007-0000-0000-0000-000000000008', 130, '2026-07-15T05:20:00Z'),
  ('11f0000b-0000-0000-0000-000000000804', 'gh_forks', '11f00007-0000-0000-0000-000000000008', 240, '2026-07-15T05:20:00Z')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- RADAR 4/5 — ferrofluid / Tomás Aguiar (Lisbon, PT)
-- Star-farming red-flag case (R2): high stars, ~zero forks, issues disabled.
-- The flag demotes E5 to self_asserted — rendered as ⚑ demoted_by, never a
-- point deduction.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-000000000009', 'Tomás Aguiar',
   'Rust sandboxing runtime for autonomous agents',
   '{"note": "Fictional person for demo purposes."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-000000000009', 'ferrofluid', 'ferrofluid-demo11.example',
   'Rust runtime that sandboxes autonomous agents with capability-scoped syscalls.',
   'ai-infra', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: star-farming red-flag case (R2) — high stars, near-zero forks, issues disabled; E5 demoted to self_asserted", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000901', '11f00007-0000-0000-0000-000000000009',
   'github', 'taguiar-ff', 'https://github.com/taguiar-ff', 0.95, 'github_api')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-000000000009', '11f00007-0000-0000-0000-000000000009',
   '11f00001-0000-0000-0000-000000000009', 'founder', true, 0.90, 'github_api')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-000000000009', '11f00001-0000-0000-0000-000000000009',
   'radar_activated', 'sourced', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000901', 'founder',
   '11f00007-0000-0000-0000-000000000009', '11f00002-0000-0000-0000-000000000009', 'prefilled', 0.50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000901', 'github_api', 'https://github.com/taguiar-ff/ferrofluid',
   '{"repo": {"name": "ferrofluid", "stars": 9200, "forks": 3, "dependents": 0, "issues_enabled": false, "pushed_weeks_active": 6}, "followers": 55, "note": "profile + repo snapshot; star/fork ratio anomalous"}'::jsonb,
   'f11fix:rawsignal:901', '11f00007-0000-0000-0000-000000000009', '2026-07-16T09:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000901', '11f00003-0000-0000-0000-000000000901',
   'founder.execution.external_usage', 'ferrofluid has 9,200 GitHub stars.',
   NULL, NULL, 'public', 0.40, 'f11fix:claim:901'),
  ('11f00004-0000-0000-0000-000000000902', '11f00003-0000-0000-0000-000000000901',
   'founder.execution.commit_consistency', 'Commits present in 6 of the last 12 weeks.',
   NULL, NULL, 'public', 0.85, 'f11fix:claim:902')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000901', '11f00004-0000-0000-0000-000000000901', 'supports', 0.40, 'documented',
   'stars: 9200', 'https://github.com/taguiar-ff/ferrofluid', '11f00005-0000-0000-0000-000000000901', 'f11fix:evidence:901'),
  -- The same snapshot contradicts "usage": 3 forks, 0 dependents, issues off.
  ('11f00006-0000-0000-0000-000000000902', '11f00004-0000-0000-0000-000000000901', 'contradicts', 0.85, 'documented',
   'forks: 3, dependents: 0, issues_enabled: false', 'https://github.com/taguiar-ff/ferrofluid', '11f00005-0000-0000-0000-000000000901', 'f11fix:evidence:902'),
  ('11f00006-0000-0000-0000-000000000903', '11f00004-0000-0000-0000-000000000902', 'supports', 0.90, 'documented',
   'pushed_weeks_active: 6', 'https://github.com/taguiar-ff/ferrofluid', '11f00005-0000-0000-0000-000000000901', 'f11fix:evidence:903')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_observations (id, metric, founder_id, value, observed_at) VALUES
  ('11f0000b-0000-0000-0000-000000000901', 'gh_followers', '11f00007-0000-0000-0000-000000000009', 55, '2026-07-16T09:00:00Z'),
  ('11f0000b-0000-0000-0000-000000000902', 'gh_stars', '11f00007-0000-0000-0000-000000000009', 9200, '2026-07-16T09:00:00Z'),
  ('11f0000b-0000-0000-0000-000000000903', 'gh_forks', '11f00007-0000-0000-0000-000000000009', 3, '2026-07-16T09:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- RADAR 5/5 — patchbay / Yuki Andersen (Oslo, NO)
-- Fresh signal, almost nothing known yet: 1 claim, high obscurity, karma-only
-- basis → renders "not enough evidence to score" at full prominence.
-- ============================================================================

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('11f00007-0000-0000-0000-00000000000a', 'Yuki Andersen', NULL,
   '{"note": "Fictional person for demo purposes. Discovered 18 hours ago; almost nothing assessed yet — the honest cold-start case."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('11f00001-0000-0000-0000-00000000000a', 'patchbay', 'patchbay-demo11.example',
   'Local-first config plane for edge inference boxes.',
   'ai-infra', 'pre_seed',
   '{"fixture_purpose": "feature 11 demo: cold-start radar candidate — one claim, coverage below every floor; exercises insufficient_evidence rendering at full prominence", "note": "Fictional company. Any resemblance to a real company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('11f00008-0000-0000-0000-000000000a01', '11f00007-0000-0000-0000-00000000000a',
   'hn', 'yuki_patchbay', 'https://news.ycombinator.com/user?id=yuki_patchbay', 0.95, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('11f00009-0000-0000-0000-00000000000a', '11f00007-0000-0000-0000-00000000000a',
   '11f00001-0000-0000-0000-00000000000a', 'founder', true, 0.85, 'hn_algolia')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, company_id, kind, status, deck_storage_path) VALUES
  ('11f00002-0000-0000-0000-00000000000a', '11f00001-0000-0000-0000-00000000000a',
   'radar_activated', 'sourced', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, application_id, status, completeness) VALUES
  ('11f00003-0000-0000-0000-000000000a01', 'founder',
   '11f00007-0000-0000-0000-00000000000a', '11f00002-0000-0000-0000-00000000000a', 'draft', 0.10)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('11f00005-0000-0000-0000-000000000a01', 'hn_algolia', 'https://news.ycombinator.com/item?id=44819902',
   '{"title": "Show HN: patchbay — local-first config plane for edge inference boxes", "points": 41, "num_comments": 12, "author": "yuki_patchbay", "author_replies": 5, "text": "patchbay keeps edge inference boxes configured without a cloud control plane.", "note": "Show HN thread snapshot — 18 hours old"}'::jsonb,
   'f11fix:rawsignal:a01', '11f00007-0000-0000-0000-00000000000a', '2026-07-18T14:40:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('11f00004-0000-0000-0000-000000000a01', '11f00003-0000-0000-0000-000000000a01',
   'founder.leadership.compression', 'patchbay keeps edge inference boxes configured without a cloud control plane.',
   NULL, NULL, 'public', 0.60, 'f11fix:claim:a01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('11f00006-0000-0000-0000-000000000a01', '11f00004-0000-0000-0000-000000000a01', 'supports', 0.80, 'discovered',
   'patchbay keeps edge inference boxes configured without a cloud control plane.', 'https://news.ycombinator.com/item?id=44819902', '11f00005-0000-0000-0000-000000000a01', 'f11fix:evidence:a01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_observations (id, metric, founder_id, value, observed_at) VALUES
  ('11f0000b-0000-0000-0000-000000000a01', 'hn_karma', '11f00007-0000-0000-0000-00000000000a', 12, '2026-07-18T14:40:00Z'),
  ('11f0000b-0000-0000-0000-000000000a02', 'hn_points', '11f00007-0000-0000-0000-00000000000a', 41, '2026-07-18T14:40:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, event_type, entity_type, entity_id, payload, actor) VALUES
  ('11f0000a-0000-0000-0000-000000000a01', 'founder_score_insufficient_evidence', 'founder',
   '11f00007-0000-0000-0000-00000000000a',
   '{"coverage": 0.06, "assessed": 1, "of": 12, "threshold": 0.25, "run_id": "f11fix-run-a01", "reason": "single discovered-tier claim; no execution signals collected yet"}'::jsonb,
   'f11-fixture')
ON CONFLICT (id) DO NOTHING;

COMMIT;
