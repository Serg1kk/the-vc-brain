-- db/fixtures/03-founder-score.sql
--
-- Feature 03 (Founder Score) test data. Authoritative design:
-- docs/backlog/03-founder-score/design.md SS6 ("Test data") -- read that section
-- before touching this file.
--
-- NOT applied by db/apply.sh (schema.sql + seed.sql only). Explicit invocation:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/03-founder-score.sql
--
-- Three founders, entirely at the claims+evidence level -- exactly the shape
-- feature 02 (sourcing radar) will eventually produce, so this fixture needs no
-- rework once 02 lands. Fixed, explicitly-written UUIDs (never gen_random_uuid())
-- so the fixture is reproducible and referenceable by id from other tasks
-- (lib/f03/run.js --recorded fixtures, D1's e2e run, QA). Id scheme, all hex-safe:
--
--   03f0<TTTT>-0000-0000-0000-<SEQ, 12 hex digits>
--   TTTT = entity type: 0001 founders / 0002 companies / 0003 founder_identities /
--          0004 founder_company / 0005 cards / 0006 claims / 0007 raw_signals /
--          0008 evidence
--   SEQ  = per-type sequence, grouped by founder (1xx = founder 1, 2xx = founder 2,
--          3xx = founder 3) so a reader can tell which founder a row belongs to
--          from the id alone.
--
-- This range (03f0...) is reserved for this feature and cannot collide with
-- feature 01/09's smoke fixtures (00000000-...-00000000009xx range) or any other
-- feature's fixture range -- see docs/backlog/03-founder-score/plan.md's
-- cross-feature coordination table.
--
-- ============================================================================
-- THE THREE FOUNDERS -- quick reference (also see the final report handed back
-- to the orchestrator for the full per-criterion expectation table)
-- ============================================================================
--
-- 1. 03f00001-0000-0000-0000-000000000001  Devon Ashworth   (is_synthetic=true)
--    "Seeded contradictions" founder. Fintrace AI (synthetic). Exercises:
--    R4 (AI-washing) demoting E4 + X2 met->self_asserted; R1 (provenance
--    spoofing) demoting BOTH E7 and E1 to not_met. NOTE: an earlier version of
--    this comment called E1's demotion "a no-op because E1 has no claim" -- that
--    was wrong, and QA caught it (qa-report-03.md Finding 2). gate.js step 6
--    demotes unconditionally regardless of the current verdict, and step 5's
--    re-application then finds a source-level neg_src match, because the
--    execution pack does contain OTHER github_api-sourced claims. E1 therefore
--    lands not_met, exactly as gate.js's own comments say it should.
--    R2 (star farming) demoting E5; a clean
--    self_asserted with zero corroborating evidence (L2); a clean self_asserted
--    reached via step 6a tier-coercion, not a flag (L3); one genuinely clean
--    positive signal (E3) so the founder is not a one-note fabrication.
--
-- 2. 03f00001-0000-0000-0000-000000000002  Kwame Asante     (is_synthetic=true)
--    Deliberately sparse -- revision 2, 2026-07-19: 2 claims, BOTH sourced
--    hn_algolia (single source cluster -- a Show HN post and its own thread,
--    the most realistic footprint for a true cold-start founder). Verified
--    against the live score_formulas.config registry: hn_algolia appears in
--    exactly one criterion's neg_src, L5 (weight 0.06000); no criterion lists
--    'manual'. So gate.js step 5's not_met licence can never fire on anything
--    but L5, and with zero claims routed into the execution/expertise packs,
--    every other criterion is cannot_assess by construction (design SS4.4 step
--    3). Worst-case max assessed_weight = 0.06000 -> max coverage = 0.06 <
--    min_coverage (0.25), proven from the registry, not assumed -- see the
--    claims block below for the full derivation and why revision 1 (3 claims,
--    3 different sources) was wrong: it scored 0.25125 on a live n8n run
--    because the not_met licence is source-level, not question-level, and one
--    github_api claim silently licensed all five execution criteria at once.
--
-- 3. 03f00001-0000-0000-0000-000000000003  Pieter Levels    (is_synthetic=false,
--    a REAL person). Photo AI (real product, real domain). Public signals only:
--    products, GitHub/HN/personal-site identity, writing style, self-published
--    revenue/usage transparency. No age, no photo, no location, no Art. 9
--    category. E4/E5/X1/X6/L2 carry verbatim, exact-substring quotes from his
--    own published writing, verified via Exa on 2026-07-19 (tier 'documented'
--    on those rows) -- exercises the I6 verbatim-substring path (design SS4.4
--    step 7) for real. X2/X5/L3/L5 were outside that verification pass and
--    remain hand-compiled/unquoted (tier 'discovered', no quote). See
--    founders.profile.fixture_provenance on this row for the full disclosure
--    and source list. Subject to purge_founder() on request, same
--    as any founder row (CLAUDE.md publication-gate: real people in demo data
--    require public-signals-only + an opt-out path -- purge_founder() is that
--    path).
--
-- Wrapped in one transaction: either the whole fixture lands or none of it does.
-- Every INSERT carries ON CONFLICT (id) DO NOTHING against the fixed id above,
-- which is sufficient for idempotent re-runs of this exact file (a second run's
-- rows conflict on id before any other unique constraint -- domain, content_hash,
-- (kind,value) -- is ever evaluated, because the row is never inserted).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Founder 1: Devon Ashworth (synthetic) + Fintrace AI (synthetic)
-- ----------------------------------------------------------------------------

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('03f00001-0000-0000-0000-000000000001',
   'Devon Ashworth',
   'Founder & CEO, Fintrace AI (synthetic fixture -- not a real person)',
   '{"fixture_purpose": "seeded-contradictions demo for feature 03: red flags R1/R2/R4, self_asserted verdicts via both the no-evidence path and the step-6a tier-coercion path", "note": "Fictional person. Any resemblance to a real founder or company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('03f00002-0000-0000-0000-000000000001',
   'Fintrace AI',
   'fintrace-ai.example',
   'AI-powered fraud detection for regional banks (synthetic fixture company).',
   'fintech / fraud detection',
   'seed',
   '{"note": "Fictional company. Uses the RFC 2606 reserved .example TLD on purpose so its domain can never collide with a real registration."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('03f00003-0000-0000-0000-000000000001',
   '03f00001-0000-0000-0000-000000000001',
   'github', 'devon-ashworth-dev', 'https://github.com/devon-ashworth-dev',
   0.70, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('03f00004-0000-0000-0000-000000000001',
   '03f00001-0000-0000-0000-000000000001',
   '03f00002-0000-0000-0000-000000000001',
   'founder', true, 0.90, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, company_id, status, completeness) VALUES
  ('03f00005-0000-0000-0000-000000000001',
   'founder',
   '03f00001-0000-0000-0000-000000000001',
   '03f00002-0000-0000-0000-000000000001',
   'confirmed', 0.65)
ON CONFLICT (id) DO NOTHING;

-- Claims. topic prefixes per design SS4.7. axis='founder_score' (seeded in
-- seed.sql) -- not consumed by feature 03's read query (design SS4.1 lists what
-- is consumed and axis is not in that list) but correctly tags the claim for
-- any other feature that filters by axis later.

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  -- C1 (E4 setup, half of the R4 pair): a "live production URL" claim whose
  -- only observable artifact is a marketing page with zero verifiable
  -- specifics -- the textbook AI-washing shape (FACT-010 / BuilderAI).
  ('03f00006-0000-0000-0000-000000000101',
   '03f00005-0000-0000-0000-000000000001',
   'founder.execution.product',
   'Fintrace Shield is live in production at fintrace-shield.example and is used by three regional banks to flag fraudulent transactions in real time.',
   NULL, 'founder_score', 'self_reported', 0.40, 'f03fix:claim:101'),

  -- C2: "the GitHub repo contains the core engine" -- contradicted by its own
  -- evidence below (near-empty repo).
  ('03f00006-0000-0000-0000-000000000102',
   '03f00005-0000-0000-0000-000000000001',
   'founder.execution.tech',
   'Our GitHub repository fintrace-ai/fintrace-shield contains the core fraud-detection engine that powers the product.',
   NULL, 'founder_score', 'self_reported', 0.35, 'f03fix:claim:102'),

  -- C3 (X2 setup, other half of the R4 pair): a specific-sounding technical
  -- capability claim with no observable artifact behind it.
  ('03f00006-0000-0000-0000-000000000103',
   '03f00005-0000-0000-0000-000000000001',
   'founder.expertise.insight',
   'We use a proprietary transformer-based architecture, fine-tuned on transaction sequences, achieving 94% fraud-catch accuracy -- well above the roughly 70% typical of the rule-based legacy systems banks currently run.',
   NULL, 'founder_score', 'self_reported', 0.35, 'f03fix:claim:103'),

  -- C4 (E7 / R1 setup): provenance-spoofing bait -- first commit predates the
  -- author's account creation, per the raw_signals payload below.
  ('03f00006-0000-0000-0000-000000000104',
   '03f00005-0000-0000-0000-000000000001',
   'founder.execution.provenance',
   'The fintrace-ai/fintrace-shield GitHub repository has been under active development by our team since well before Fintrace AI was founded, demonstrating early conviction in the fraud-detection approach.',
   NULL, 'founder_score', 'self_reported', 0.30, 'f03fix:claim:104'),

  -- C5 (E5 / R2 setup): star-farming bait -- high stars, ~0 forks, issues
  -- disabled, per the raw_signals payload below.
  ('03f00006-0000-0000-0000-000000000105',
   '03f00005-0000-0000-0000-000000000001',
   'founder.execution.traction',
   'Our open-source SDK on GitHub has significant community traction, which validates market demand for our approach.',
   '{"stars": 850, "forks": 2, "issues_enabled": false}'::jsonb,
   'founder_score', 'self_reported', 0.30, 'f03fix:claim:105'),

  -- C6 (L2): the clean self_asserted case the task explicitly asks for --
  -- founder-asserted, zero evidence rows, no red-flag machinery involved.
  ('03f00006-0000-0000-0000-000000000106',
   '03f00005-0000-0000-0000-000000000001',
   'founder.leadership.customers',
   'We have signed letters of intent with two additional banks who plan to pilot Fintrace Shield in Q4.',
   NULL, 'founder_score', 'self_reported', 0.30, 'f03fix:claim:106'),

  -- C7 (L3): also zero evidence -- exercises the OTHER self_asserted path
  -- (design SS4.4 step 6a: a `met` verdict whose best evidence tier is
  -- inferred/missing is coerced to self_asserted). No corroborating evidence
  -- row exists at all here, so best tier is effectively "missing".
  ('03f00006-0000-0000-0000-000000000107',
   '03f00005-0000-0000-0000-000000000001',
   'founder.leadership.icp',
   'We target mid-size regional banks with $1B-$10B in assets and an existing fraud-ops team of 3-8 people who are currently stitching together spreadsheets and a legacy rules engine.',
   NULL, 'founder_score', 'self_reported', 0.40, 'f03fix:claim:107'),

  -- C8 (E3): one genuinely clean positive signal, so this founder is a
  -- realistic mixed picture rather than a one-note fabrication.
  ('03f00006-0000-0000-0000-000000000108',
   '03f00005-0000-0000-0000-000000000001',
   'founder.execution.consistency',
   'GitHub commit history for the fintrace-ai/fintrace-shield repo shows activity in 9 of the last 12 weeks.',
   '{"commit_weeks_active": 9, "window_weeks": 12}'::jsonb,
   'founder_score', 'derived', 0.50, 'f03fix:claim:108')
ON CONFLICT (id) DO NOTHING;

-- Raw signals. source in the seeded signal_sources vocabulary
-- (github_api/hn_algolia/tavily_extract/deck_parse/interview_answer/manual).
-- observed_at is NOT NULL with no default -- always supplied explicitly.

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('03f00007-0000-0000-0000-000000000101', 'tavily_extract',
   'https://fintrace-shield.example',
   '{"url": "https://fintrace-shield.example", "extracted_text": "Fintrace Shield -- AI-Powered Fraud Detection for Modern Banks. Real-time protection you can trust.", "note": "synthetic fixture content -- no bank names, no case studies, no benchmark link"}'::jsonb,
   'f03fix:rawsignal:101', '03f00001-0000-0000-0000-000000000001', '2026-06-20T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000102', 'github_api',
   'https://github.com/fintrace-ai/fintrace-shield',
   '{"repo": "fintrace-ai/fintrace-shield", "commits": 1, "files": ["README.md"], "readme_excerpt": "Fintrace Shield core engine -- coming soon.", "has_ml_code": false}'::jsonb,
   'f03fix:rawsignal:102', '03f00001-0000-0000-0000-000000000001', '2026-06-22T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000104', 'github_api',
   'https://github.com/fintrace-ai/fintrace-shield',
   '{"repo": "fintrace-ai/fintrace-shield", "first_commit_at": "2024-01-15T00:00:00Z", "author_account_created_at": "2024-06-01T00:00:00Z", "note": "first commit predates author account creation -- classic backdating signature"}'::jsonb,
   'f03fix:rawsignal:104', '03f00001-0000-0000-0000-000000000001', '2026-06-23T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000105', 'github_api',
   'https://github.com/fintrace-ai/fintrace-sdk',
   '{"repo": "fintrace-ai/fintrace-sdk", "stars": 850, "forks": 2, "issues_enabled": false}'::jsonb,
   'f03fix:rawsignal:105', '03f00001-0000-0000-0000-000000000001', '2026-06-24T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000108', 'github_api',
   'https://github.com/fintrace-ai/fintrace-shield',
   '{"repo": "fintrace-ai/fintrace-shield", "commit_weeks_active": 9, "window_weeks": 12}'::jsonb,
   'f03fix:rawsignal:108', '03f00001-0000-0000-0000-000000000001', '2026-06-25T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- Evidence. EVERY row sets raw_signal_id (design SS6 mandatory obligation --
-- neg_src / SS4.4 step 5 is load-bearing on it). Tier varied deliberately:
-- documented (102,104,105,108), inferred (103) -- see the code comment there.
-- Claims 106/107 intentionally have NO evidence row at all (the self_asserted
-- demonstrations).

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('03f00008-0000-0000-0000-000000000101',
   '03f00006-0000-0000-0000-000000000101', 'supports', 0.40, 'discovered',
   'Fintrace Shield -- AI-Powered Fraud Detection for Modern Banks. Real-time protection you can trust.',
   'https://fintrace-shield.example', '03f00007-0000-0000-0000-000000000101',
   'f03fix:evidence:101'),

  ('03f00008-0000-0000-0000-000000000102',
   '03f00006-0000-0000-0000-000000000102', 'contradicts', 0.75, 'documented',
   'Fintrace Shield core engine -- coming soon.',
   'https://github.com/fintrace-ai/fintrace-shield', '03f00007-0000-0000-0000-000000000102',
   'f03fix:evidence:102'),

  -- Tier deliberately 'inferred', not 'documented': the raw fact (repo has no
  -- ML code) is directly observed, but concluding "no substance behind the
  -- specific 94%-accuracy/transformer claim" from that fact is one inferential
  -- step further -- exercises SS4.4 step 6a's met->self_asserted coercion path
  -- if this criterion is ever judged `met` on thin grounds.
  ('03f00008-0000-0000-0000-000000000103',
   '03f00006-0000-0000-0000-000000000103', 'contradicts', 0.60, 'inferred',
   'Fintrace Shield core engine -- coming soon.',
   'https://github.com/fintrace-ai/fintrace-shield', '03f00007-0000-0000-0000-000000000102',
   'f03fix:evidence:103'),

  ('03f00008-0000-0000-0000-000000000104',
   '03f00006-0000-0000-0000-000000000104', 'contradicts', 0.85, 'documented',
   'first commit predates author account creation',
   'https://github.com/fintrace-ai/fintrace-shield', '03f00007-0000-0000-0000-000000000104',
   'f03fix:evidence:104'),

  ('03f00008-0000-0000-0000-000000000105',
   '03f00006-0000-0000-0000-000000000105', 'context', 0.55, 'documented',
   'stars: 850, forks: 2, issues: disabled',
   'https://github.com/fintrace-ai/fintrace-sdk', '03f00007-0000-0000-0000-000000000105',
   'f03fix:evidence:105'),

  ('03f00008-0000-0000-0000-000000000108',
   '03f00006-0000-0000-0000-000000000108', 'supports', 0.80, 'documented',
   'commit_weeks_active: 9 of 12',
   'https://github.com/fintrace-ai/fintrace-shield', '03f00007-0000-0000-0000-000000000108',
   'f03fix:evidence:108')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Founder 2: Kwame Asante (synthetic, deliberately sparse) + Ridgeline Data
-- ----------------------------------------------------------------------------

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('03f00001-0000-0000-0000-000000000002',
   'Kwame Asante',
   'Founder, Ridgeline Data (synthetic fixture -- not a real person)',
   '{"fixture_purpose": "deliberately sparse cold-start demo for feature 03: forces the insufficient_evidence branch (design SS2.4) by construction, not by chance -- revision 2, 2026-07-19: reworked to a single-source-cluster footprint after a live n8n run scored 0.25125 (over the 0.25 floor) on the original 3-source design; see the claims block below for the registry-derived proof this cannot recur.", "note": "Fictional person. Any resemblance to a real founder or company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('03f00002-0000-0000-0000-000000000002',
   'Ridgeline Data',
   'ridgeline-data.example',
   'Schema-drift monitoring for data pipelines (synthetic fixture company).',
   'data infrastructure / observability',
   'pre_seed',
   '{"note": "Fictional company. Uses the RFC 2606 reserved .example TLD on purpose so its domain can never collide with a real registration."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

-- Identity reworked to match the single-source-cluster story: a genuine
-- cold-start founder surfaced from one Show HN post has an HN handle, not a
-- separately-discovered GitHub profile with nothing behind it. (Revision 1 had
-- a 'github' identity row with zero corroborating claims -- narratively
-- inconsistent with "almost no other footprint"; founder_identities does not
-- feed the scoring pack so this was never a coverage risk, only a coherence one.)
INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('03f00003-0000-0000-0000-000000000002',
   '03f00001-0000-0000-0000-000000000002',
   'hn', 'kwame-asante-dev', 'https://news.ycombinator.com/user?id=kwame-asante-dev',
   0.70, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('03f00004-0000-0000-0000-000000000002',
   '03f00001-0000-0000-0000-000000000002',
   '03f00002-0000-0000-0000-000000000002',
   'founder', true, 0.90, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, company_id, status, completeness) VALUES
  ('03f00005-0000-0000-0000-000000000002',
   'founder',
   '03f00001-0000-0000-0000-000000000002',
   '03f00002-0000-0000-0000-000000000002',
   'draft', 0.10)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Revision 2 (2026-07-19): reworked after a real defect. The revision-1 design
-- (3 claims, 3 DIFFERENT sources -- github_api/interview_answer/hn_algolia,
-- one per sub-scorer pack) proved the coverage bound wrong: gate.js step 5's
-- not_met licence is SOURCE-LEVEL, not question-level (design SS4.4 step 5 /
-- SS8.5) -- a single github_api claim in the execution pack licenses not_met
-- across ALL FIVE execution criteria (E1/E3/E4/E5/E7 all list github_api in
-- neg_src), not just the one the claim actually described. A live n8n run
-- exercised that licence and landed at coverage 0.25125 -- over the 0.25
-- floor -- entirely legitimately per the gate's own rules, which the
-- revision-1 comment here did not account for.
--
-- The fix, verified against the LIVE score_formulas.config registry (queried
-- 2026-07-19), not assumed: restrict every one of Kwame's claims to a SINGLE
-- source, hn_algolia -- also the most realistic choice for a founder whose
-- only public footprint is a Show HN post. Scanning all 12 criteria's neg_src
-- arrays in the active formula:
--
--   E1 [github_api]  E3 [github_api]  E4 [tavily_extract, github_api]
--   E5 [github_api]  E7 [github_api]
--   X1 [deck_parse, interview_answer, tavily_extract]
--   X2 [deck_parse, interview_answer, tavily_extract]
--   X5 [deck_parse, interview_answer]
--   X6 [github_api, tavily_extract]
--   L2 [deck_parse, interview_answer]  L3 [deck_parse, interview_answer]
--   L5 [hn_algolia, tavily_extract]                <-- the only match
--
-- exactly ONE criterion, L5 (weight 0.06000), lists hn_algolia. No criterion
-- lists 'manual' at all. So for a founder whose claim sources are drawn
-- exclusively from {hn_algolia, manual}, not_met can NEVER be licensed for
-- anything but L5 -- by registry construction, independent of which pack a
-- claim lands in and independent of how liberally any given LLM run applies
-- the licence.
--
-- The remaining question is met/self_asserted via genuine topical relevance.
-- Both claims below are topic-prefixed founder.leadership.communication (the
-- ONLY thing a Show HN post + its own thread can honestly speak to) -- neither
-- execution-signals' nor expertise-signals' context pack receives ANY claim at
-- all, so per design SS4.4 step 3 every one of E1/E3/E4/E5/E7/X1/X2/X5/X6 is
-- inserted as cannot_assess with no data to reason from, full stop. Within the
-- leadership-sales-proxies pack, L2 (0.15000) and L3 (0.09000) have no claim
-- addressing customers/LOI/pilot or ICP either, so they stay cannot_assess too
-- (topically nothing to judge, and hn_algolia does not license a not_met for
-- either of them).
--
-- WORST CASE, proven arithmetically rather than assumed: the only criterion
-- that can ever be assessed (met, self_asserted, or not_met -- any verdict,
-- it does not matter which) is L5. max assessed_weight = weight(L5) = 0.06000.
-- max coverage = 0.06000 / 1.00000 = 0.06 < min_coverage (0.25). This holds
-- for EVERY possible LLM output on this pack, not just the one the fixture
-- happens to record -- insufficient_evidence is now guaranteed by the
-- registry, not by an assumption about which criteria "happen to have claims".
INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  -- L5, part 1 (0.06000, the only assessable criterion): the Show HN post
  -- itself. UNCHANGED from revision 1 (same id) -- this claim was never the
  -- problem; kept as-is so it stays meaningful evidence rather than churn.
  ('03f00006-0000-0000-0000-000000000203',
   '03f00005-0000-0000-0000-000000000002',
   'founder.leadership.communication',
   'Show HN: Ridgeline -- a tool that flags schema drift before it breaks your pipeline. Free tier, no signup needed.',
   NULL, 'founder_score', 'public', 0.40, 'f03fix:claim:203'),

  -- L5, part 2 (new): a follow-up reply in the SAME HN thread -- still
  -- hn_algolia, still leadership.communication (a second, independent data
  -- point for "concise, structured under compression", not a new criterion).
  ('03f00006-0000-0000-0000-000000000204',
   '03f00005-0000-0000-0000-000000000002',
   'founder.leadership.communication',
   'Replying to a pricing question in the same Hacker News thread, the poster wrote: "Free forever for one pipeline. Paid tier is $29/mo for unlimited. No sales call."',
   NULL, 'founder_score', 'public', 0.40, 'f03fix:claim:204')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('03f00007-0000-0000-0000-000000000203', 'hn_algolia',
   'https://news.ycombinator.com/item?id=f03fixture203',
   '{"story_title": "Show HN: Ridgeline -- flag schema drift before it breaks your pipeline", "points": 4}'::jsonb,
   'f03fix:rawsignal:203', '03f00001-0000-0000-0000-000000000002', '2026-07-08T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000204', 'hn_algolia',
   'https://news.ycombinator.com/item?id=f03fixture204',
   '{"comment_text": "Free forever for one pipeline. Paid tier is $29/mo for unlimited. No sales call.", "parent_item": "f03fixture203"}'::jsonb,
   'f03fix:rawsignal:204', '03f00001-0000-0000-0000-000000000002', '2026-07-08T11:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- Both tier 'documented' (hn_algolia's seeded base_tier) -- no 'inferred' row
-- for this founder any more (revision 1's E3 aggregate-stat claim, which
-- carried the 'inferred' tier, is gone along with E3 itself). The "vary tier"
-- obligation (design SS6) is satisfied across the fixture as a whole by
-- founder 1 (documented/inferred) and founder 3 (documented/discovered) --
-- Kwame does not need to carry it alone, and forcing an artificial 'inferred'
-- row here would mean inventing a claim/source this founder's single-cluster
-- story does not actually have.

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('03f00008-0000-0000-0000-000000000203',
   '03f00006-0000-0000-0000-000000000203', 'supports', 0.60, 'documented',
   'Show HN: Ridgeline -- flag schema drift before it breaks your pipeline',
   'https://news.ycombinator.com/item?id=f03fixture203', '03f00007-0000-0000-0000-000000000203',
   'f03fix:evidence:203'),

  ('03f00008-0000-0000-0000-000000000204',
   '03f00006-0000-0000-0000-000000000204', 'supports', 0.60, 'documented',
   'Free forever for one pipeline. Paid tier is $29/mo for unlimited. No sales call.',
   'https://news.ycombinator.com/item?id=f03fixture204', '03f00007-0000-0000-0000-000000000204',
   'f03fix:evidence:204')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Founder 3: Pieter Levels (REAL person, is_synthetic=false) + Photo AI
-- (real product, real domain)
-- ----------------------------------------------------------------------------
--
-- Sourcing method disclosure (read before relying on exact wording of any
-- claim below -- revision 2, 2026-07-19): the original build session had no
-- live web-fetch / Exa / Tavily tool available to the agent that authored this
-- fixture, so the first pass was a hand-compiled, non-quote-verified summary
-- of well-known public facts, with quote_verbatim left NULL everywhere on
-- principle (no invented exact wording attributed to a real person).
--
-- The orchestrating agent then independently verified the underlying facts via
-- Exa on 2026-07-19 and supplied real, character-for-character quotes with
-- their exact source URLs, pulled from Pieter Levels' own published writing.
-- E4, E5, X1, X6 and L2 below now carry verbatim primary-source quotes
-- (evidence.tier bumped to 'documented' on those rows accordingly -- this is
-- his own first-person account, the same class of authority as a direct API
-- read, not a third-party paraphrase). X2, X5, L3 and L5 were NOT part of this
-- verification pass and still rest on the original hand-compiled summary
-- (tier 'discovered'/no quote) -- flagged here rather than silently upgraded.
--
-- Ethics (design SS6 / CLAUDE.md publication gate): public professional
-- signals only -- products, GitHub/HN/personal-site identity, writing style,
-- self-published revenue/usage transparency. No age, no photo, no precise
-- location, no GDPR Art. 9 category. Subject to purge_founder() on request,
-- same as any founder row.

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('03f00001-0000-0000-0000-000000000003',
   'Pieter Levels',
   'Solo/bootstrapped SaaS builder -- Nomad List, Remote OK, Photo AI, Interior AI',
   '{
      "fixture_provenance": "Initial claim text (2026-07-19, first pass) was hand-compiled from well-known public knowledge -- no live web-fetch tool was available in that build session. Verified against live sources via Exa by the orchestrating agent on 2026-07-19: the quotes and URLs now attached to the E4/E5/X1/X6/L2 evidence rows are confirmed, character-for-character source text from Pieter Levels own published writing (levels.io/photoai-14000-lines-raw-php-revenue, 2023-07-03; levels.io/projects; levels.io/startups, 2018-01-24; levels.io/nomad-list-founder). X2/X5/L3/L5 were not part of this verification pass and still rest on the original hand-compiled, non-quote-verified summary -- recommend the same verification pass for those if used beyond pipeline testing.",
      "public_sources": [
        "https://levels.io",
        "https://levels.io/about",
        "https://levels.io/photoai-14000-lines-raw-php-revenue",
        "https://levels.io/projects",
        "https://levels.io/startups",
        "https://levels.io/nomad-list-founder",
        "https://nomadlist.com",
        "https://photoai.com",
        "https://github.com/levelsio",
        "https://news.ycombinator.com/user?id=levelsio",
        "https://x.com/levelsio"
      ],
      "opt_out": "Subject to purge_founder() on request per the project data-ethics policy (CLAUDE.md publication gate: real people in demo data require public-signals-only + an opt-out path)."
    }'::jsonb,
   false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('03f00002-0000-0000-0000-000000000003',
   'Photo AI',
   'photoai.com',
   'AI-generated photos/avatars from user-uploaded images -- a real, long-running solo-built product by Pieter Levels.',
   'consumer AI / creator tools',
   'seed',
   '{"note": "Real product. In reality this company is self-funded/bootstrapped and has never raised outside capital -- the stage=seed tag is a schema-required categorical placeholder for this fixture (companies.stage CHECK only allows pre_seed/seed), not a claim that a real funding round occurred or that this person applied for VC funding."}'::jsonb,
   false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_identities (id, founder_id, kind, value, url, confidence, discovered_via) VALUES
  ('03f00003-0000-0000-0000-000000000003',
   '03f00001-0000-0000-0000-000000000003',
   'github', 'levelsio', 'https://github.com/levelsio', 0.90, 'manual'),
  ('03f00003-0000-0000-0000-000000000004',
   '03f00001-0000-0000-0000-000000000003',
   'hn', 'levelsio', 'https://news.ycombinator.com/user?id=levelsio', 0.90, 'manual'),
  ('03f00003-0000-0000-0000-000000000005',
   '03f00001-0000-0000-0000-000000000003',
   'site', 'levels.io', 'https://levels.io', 0.90, 'manual'),
  ('03f00003-0000-0000-0000-000000000006',
   '03f00001-0000-0000-0000-000000000003',
   'x', 'levelsio', 'https://x.com/levelsio', 0.90, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('03f00004-0000-0000-0000-000000000003',
   '03f00001-0000-0000-0000-000000000003',
   '03f00002-0000-0000-0000-000000000003',
   'founder', true, 0.90, 'manual')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cards (id, card_type, founder_id, company_id, status, completeness) VALUES
  ('03f00005-0000-0000-0000-000000000003',
   'founder',
   '03f00001-0000-0000-0000-000000000003',
   '03f00002-0000-0000-0000-000000000003',
   'confirmed', 0.80)
ON CONFLICT (id) DO NOTHING;

-- 9 claims spanning E4/E5/X1/X2/X5/X6/L2/L3/L5 -- deliberately NOT touching
-- E1/E3/E7 (no confident public data on his GitHub commit cadence or PR
-- history into repos he does not own -- his product code is largely closed;
-- left as honest cannot_assess gaps rather than fabricated).

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  -- E4: live production URL, now with a verbatim primary-source quote on the
  -- product's real scale (levels.io/photoai-14000-lines-raw-php-revenue).
  ('03f00006-0000-0000-0000-000000000301',
   '03f00005-0000-0000-0000-000000000003',
   'founder.execution.product',
   'Photo AI (photoai.com), built and operated by Pieter Levels, is live in production. In his own published writing about it, Levels described its scale: "Photo AI is now almost 14,000 lines of raw PHP mixed with inline HTML, CSS in and raw JS in tags" (levels.io/photoai-14000-lines-raw-php-revenue, 2023-07-03).',
   NULL, 'founder_score', 'public', 0.60, 'f03fix:claim:301'),

  -- E5: measured external usage -- verbatim, self-published revenue/customer
  -- count for Photo AI.
  ('03f00006-0000-0000-0000-000000000302',
   '03f00005-0000-0000-0000-000000000003',
   'founder.execution.traction',
   'Pieter Levels has publicly disclosed measured usage and revenue for Photo AI in his own writing: "It has 1,872 paying customers making $61,808 per month" (levels.io/photoai-14000-lines-raw-php-revenue, 2023-07-03).',
   NULL, 'founder_score', 'public', 0.60, 'f03fix:claim:302'),

  -- X1: documented tenure in the same vertical, 10+ years -- verbatim origin
  -- date from his own account of founding Nomad List.
  ('03f00006-0000-0000-0000-000000000303',
   '03f00005-0000-0000-0000-000000000003',
   'founder.expertise.tenure',
   'Levels has operated continuously in the remote-work / digital-nomad and solo-SaaS tools vertical for over a decade. He wrote about its origin: "I started Nomad List in 2014 as part of my goal to launch 12 startups in 12 months" (levels.io/nomad-list-founder).',
   NULL, 'founder_score', 'public', 0.65, 'f03fix:claim:303'),

  -- X2: insight specificity -- a contrarian, specific operating stance.
  ('03f00006-0000-0000-0000-000000000304',
   '03f00005-0000-0000-0000-000000000003',
   'founder.expertise.insight',
   'Levels has written and spoken publicly (blog posts, interviews, conference talks) about running profitable SaaS products with small, tightly-scoped teams and minimal infrastructure, arguing that most solo founders overbuild for scale they will never need.',
   NULL, 'founder_score', 'public', 0.50, 'f03fix:claim:304'),

  -- X5: competitor insider granularity -- deliberately the weakest/thinnest
  -- claim about him in this fixture (left with no evidence row below), since
  -- this is genuinely a less-documented angle for this particular person.
  ('03f00006-0000-0000-0000-000000000305',
   '03f00005-0000-0000-0000-000000000003',
   'founder.expertise.competitors',
   'Levels has publicly contrasted his products'' approach (fast-shipping, single-developer-maintained, narrowly-scoped tools) with larger venture-backed competitors in the remote-work-tools and AI-photo-generation spaces, without naming specific competitor weaknesses in technical detail.',
   NULL, 'founder_score', 'public', 0.35, 'f03fix:claim:305'),

  -- X6: work nobody asked for, before any funding -- the strongest, most
  -- well-documented signal in this entire fixture for this founder, now with
  -- a verbatim primary-source quote of the actual origin story.
  ('03f00006-0000-0000-0000-000000000306',
   '03f00005-0000-0000-0000-000000000003',
   'founder.expertise.bootstrap',
   'Nomad List began as unrequested work built before any funding existed. Levels wrote about it: "12 Startups in 12 Months, to fight my depression and decreasing income, I decided to build one project per month for 12 months to see if I could get traction with anything" (levels.io/projects). He has never raised outside/VC funding for Nomad List, Remote OK, Photo AI or Interior AI, funding all of them from their own revenue.',
   NULL, 'founder_score', 'public', 0.70, 'f03fix:claim:306'),

  -- L2: first customers -- verbatim, self-published paying-member count for
  -- Nomad List.
  ('03f00006-0000-0000-0000-000000000307',
   '03f00005-0000-0000-0000-000000000003',
   'founder.leadership.customers',
   'Nomad List has had a large, long-running base of paying members. Levels wrote: "It''s now used by millions of people every month and its revenue ranges from $20k-$40k/month or ~$300k/year with a thousands of paying members." (levels.io/nomad-list-founder).',
   NULL, 'founder_score', 'public', 0.60, 'f03fix:claim:307'),

  -- L3: ICP specificity.
  ('03f00006-0000-0000-0000-000000000308',
   '03f00005-0000-0000-0000-000000000003',
   'founder.leadership.icp',
   'Nomad List''s target user is explicitly a remote worker or digital nomad choosing a city to live and work from, with the product organized around concrete, filterable attributes (cost of living, internet speed, safety, visa requirements) rather than generic city-guide content.',
   NULL, 'founder_score', 'public', 0.55, 'f03fix:claim:308'),

  -- L5: concise, structured writing under compression.
  ('03f00006-0000-0000-0000-000000000309',
   '03f00005-0000-0000-0000-000000000003',
   'founder.leadership.communication',
   'Levels is known for short, structured, high-signal public writing and product-launch posts (including historical Show HN submissions for Nomad List and later products), consistently distilling a product down to a one-line description plus a link.',
   NULL, 'founder_score', 'public', 0.50, 'f03fix:claim:309')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  -- Verified via Exa by the orchestrating agent on 2026-07-19. observed_at set
  -- to the article's own publish date where Exa returned one (301, 304);
  -- undated pages (302, 303) use the 2026-07-19 verification date instead.
  ('03f00007-0000-0000-0000-000000000301', 'tavily_extract',
   'https://levels.io/photoai-14000-lines-raw-php-revenue',
   '{"url": "https://levels.io/photoai-14000-lines-raw-php-revenue", "published_at": "2023-07-03", "verified_via": "Exa, 2026-07-19", "quotes": ["Photo AI is now almost 14,000 lines of raw PHP mixed with inline HTML, CSS in and raw JS in tags", "It has 1,872 paying customers making $61,808 per month"]}'::jsonb,
   'f03fix:rawsignal:301', '03f00001-0000-0000-0000-000000000003', '2023-07-03T00:00:00Z'),

  ('03f00007-0000-0000-0000-000000000302', 'tavily_extract',
   'https://levels.io/nomad-list-founder',
   '{"url": "https://levels.io/nomad-list-founder", "verified_via": "Exa, 2026-07-19", "quotes": ["I started Nomad List in 2014 as part of my goal to launch 12 startups in 12 months", "It''s now used by millions of people every month and its revenue ranges from $20k-$40k/month or ~$300k/year with a thousands of paying members."]}'::jsonb,
   'f03fix:rawsignal:302', '03f00001-0000-0000-0000-000000000003', '2026-07-19T00:00:00Z'),

  ('03f00007-0000-0000-0000-000000000303', 'tavily_extract',
   'https://levels.io/projects',
   '{"url": "https://levels.io/projects", "verified_via": "Exa, 2026-07-19", "quotes": ["12 Startups in 12 Months, to fight my depression and decreasing income, I decided to build one project per month for 12 months to see if I could get traction with anything", "MAKE Book, I wrote and self published a book on building startups without funding in public, it has sold 10,000+ copies"]}'::jsonb,
   'f03fix:rawsignal:303', '03f00001-0000-0000-0000-000000000003', '2026-07-19T00:00:00Z'),

  ('03f00007-0000-0000-0000-000000000304', 'tavily_extract',
   'https://levels.io/startups',
   '{"url": "https://levels.io/startups", "published_at": "2018-01-24", "verified_via": "Exa, 2026-07-19", "quotes": ["They''re mostly bootstrapped, and bootstrapped means that you build a business without any funding.", "And importantly, there''s no VCs involved. No venture capital, just self-funded.", "I bootstrapped Remote OK from Nomad List success."]}'::jsonb,
   'f03fix:rawsignal:304', '03f00001-0000-0000-0000-000000000003', '2018-01-24T00:00:00Z'),

  -- Unchanged from the first pass -- not part of the 2026-07-19 verification
  -- (X2/X5/L3/L5 were not in scope for that pass; see the disclosure above).
  ('03f00007-0000-0000-0000-000000000306', 'tavily_extract', 'https://levels.io',
   '{"url": "https://levels.io", "note": "Hand-compiled: Levels publishes live revenue/usage dashboards and build-in-public writing on this site. Not live-fetched/quote-verified."}'::jsonb,
   'f03fix:rawsignal:306', '03f00001-0000-0000-0000-000000000003', '2026-07-11T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000307', 'tavily_extract', 'https://nomadlist.com',
   '{"url": "https://nomadlist.com", "note": "Hand-compiled: long-running paid-membership product with a specific, filterable ICP (remote workers/digital nomads choosing a city). Not live-fetched/quote-verified."}'::jsonb,
   'f03fix:rawsignal:307', '03f00001-0000-0000-0000-000000000003', '2026-07-13T10:00:00Z'),

  ('03f00007-0000-0000-0000-000000000309', 'hn_algolia', 'https://news.ycombinator.com/user?id=levelsio',
   '{"hn_username": "levelsio", "note": "Well-known, long-standing HN identity consistent with the GitHub/X/site handle levelsio. Not queried live via the Algolia API."}'::jsonb,
   'f03fix:rawsignal:309', '03f00001-0000-0000-0000-000000000003', '2026-07-14T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- quote_verbatim now set, character-for-character, on the rows backed by the
-- 2026-07-19 Exa verification pass (301, 302, 303, 306, 311, 312, 313, 314,
-- 307) -- tier bumped to 'documented' on those: this is Levels' own
-- first-person published account, the same class of authority as a direct API
-- read, not a third-party paraphrase. Rows NOT in that pass (304, 308, 309)
-- are unchanged: quote_verbatim NULL, tier as before. raw_signal_id set on
-- every row regardless, per the mandatory obligation -- none NULL. Claim 305
-- (X5) intentionally still has NO evidence row -- the thinnest, most honestly
-- uncorroborated claim in this founder's set, untouched by this pass.
--
-- I6 substring check (design SS4.4 step 7): 301/302/303/306/307's
-- quote_verbatim is an exact substring of that same claim's text_verbatim
-- above -- the primary citation path. 311/312/313/314 (X6's three
-- supplementary quotes) are additional, independently genuine ground-truth
-- quotes in the pack for claim 306 -- consistent with, but not required to be
-- textually embedded inside, claim 306's own text_verbatim (design SS4.4 step
-- 7's "or of one of that claim's evidence.quote_verbatim values" clause covers
-- exactly this: any future agent citation that echoes one of THESE rows back
-- verbatim also passes, since the row is itself already ground truth in the
-- pack).

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('03f00008-0000-0000-0000-000000000301',
   '03f00006-0000-0000-0000-000000000301', 'supports', 0.85, 'documented',
   'Photo AI is now almost 14,000 lines of raw PHP mixed with inline HTML, CSS in and raw JS in tags',
   'https://levels.io/photoai-14000-lines-raw-php-revenue', '03f00007-0000-0000-0000-000000000301', 'f03fix:evidence:301'),

  ('03f00008-0000-0000-0000-000000000302',
   '03f00006-0000-0000-0000-000000000302', 'supports', 0.85, 'documented',
   'It has 1,872 paying customers making $61,808 per month',
   'https://levels.io/photoai-14000-lines-raw-php-revenue', '03f00007-0000-0000-0000-000000000301', 'f03fix:evidence:302'),

  ('03f00008-0000-0000-0000-000000000303',
   '03f00006-0000-0000-0000-000000000303', 'supports', 0.85, 'documented',
   'I started Nomad List in 2014 as part of my goal to launch 12 startups in 12 months',
   'https://levels.io/nomad-list-founder', '03f00007-0000-0000-0000-000000000302', 'f03fix:evidence:303'),

  -- X2: unchanged (not part of the verification pass) -- re-pointed to the
  -- new general-levels.io raw_signal id (306) since the old id 302 was
  -- reassigned above to the specific nomad-list-founder page.
  ('03f00008-0000-0000-0000-000000000304',
   '03f00006-0000-0000-0000-000000000304', 'supports', 0.55, 'discovered', NULL,
   'https://levels.io', '03f00007-0000-0000-0000-000000000306', 'f03fix:evidence:304'),

  ('03f00008-0000-0000-0000-000000000306',
   '03f00006-0000-0000-0000-000000000306', 'supports', 0.85, 'documented',
   '12 Startups in 12 Months, to fight my depression and decreasing income, I decided to build one project per month for 12 months to see if I could get traction with anything',
   'https://levels.io/projects', '03f00007-0000-0000-0000-000000000303', 'f03fix:evidence:306'),

  -- X6 supplementary evidence: three more verified quotes corroborating the
  -- same claim (the highest-value cold-start signal -- design SS3 table B).
  ('03f00008-0000-0000-0000-000000000311',
   '03f00006-0000-0000-0000-000000000306', 'supports', 0.80, 'documented',
   'They''re mostly bootstrapped, and bootstrapped means that you build a business without any funding.',
   'https://levels.io/startups', '03f00007-0000-0000-0000-000000000304', 'f03fix:evidence:311'),

  ('03f00008-0000-0000-0000-000000000312',
   '03f00006-0000-0000-0000-000000000306', 'supports', 0.80, 'documented',
   'And importantly, there''s no VCs involved. No venture capital, just self-funded.',
   'https://levels.io/startups', '03f00007-0000-0000-0000-000000000304', 'f03fix:evidence:312'),

  ('03f00008-0000-0000-0000-000000000313',
   '03f00006-0000-0000-0000-000000000306', 'supports', 0.80, 'documented',
   'I bootstrapped Remote OK from Nomad List success.',
   'https://levels.io/startups', '03f00007-0000-0000-0000-000000000304', 'f03fix:evidence:313'),

  ('03f00008-0000-0000-0000-000000000314',
   '03f00006-0000-0000-0000-000000000306', 'supports', 0.75, 'documented',
   'MAKE Book, I wrote and self published a book on building startups without funding in public, it has sold 10,000+ copies',
   'https://levels.io/projects', '03f00007-0000-0000-0000-000000000303', 'f03fix:evidence:314'),

  ('03f00008-0000-0000-0000-000000000307',
   '03f00006-0000-0000-0000-000000000307', 'supports', 0.85, 'documented',
   'It''s now used by millions of people every month and its revenue ranges from $20k-$40k/month or ~$300k/year with a thousands of paying members.',
   'https://levels.io/nomad-list-founder', '03f00007-0000-0000-0000-000000000302', 'f03fix:evidence:307'),

  -- L3 / L5: unchanged (not part of the verification pass).
  ('03f00008-0000-0000-0000-000000000308',
   '03f00006-0000-0000-0000-000000000308', 'supports', 0.65, 'discovered', NULL,
   'https://nomadlist.com', '03f00007-0000-0000-0000-000000000307', 'f03fix:evidence:308'),

  ('03f00008-0000-0000-0000-000000000309',
   '03f00006-0000-0000-0000-000000000309', 'supports', 0.60, 'documented', NULL,
   'https://news.ycombinator.com/user?id=levelsio', '03f00007-0000-0000-0000-000000000309', 'f03fix:evidence:309')
ON CONFLICT (id) DO NOTHING;

COMMIT;
