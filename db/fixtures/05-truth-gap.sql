-- db/fixtures/05-truth-gap.sql
--
-- Feature 05 (Truth-Gap & Trust) labelled fixture. Authoritative design:
-- docs/backlog/05-truth-gap-trust/design.md SS6/SS6.0/SS7.4/SS12/SS14 -- read
-- those before touching this file.
--
-- NOT applied by db/apply.sh (schema.sql + seed.sql only). Explicit invocation:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/05-truth-gap.sql
--
-- WHY THIS FILE EXISTS (design SS12): the metric that decides this feature's
-- quality is helpful fixes vs harmful flips, reported as TWO separate numbers.
-- A harmful flip = flagging a TRUE founder claim as contradicted. Feature 11
-- (seeded contradictions) is still backlog, so 05 builds its own labelled
-- ground truth here, entirely at the claims+evidence(+one events row) level --
-- exactly the shape features 02/03/04 already produce, so no rework once this
-- fixture is read by lib/f05/run.js (B3) or the `claim_trust` view (A1).
--
-- This fixture does NOT precompute `claim_trust` outcomes -- the view is being
-- built concurrently by another agent (A1) and lib/f05/run.js (B3) has not run
-- yet either. What it provides is the RAW INPUT (claims/raw_signals/evidence)
-- that those components read, with the expected `derived_status` written as a
-- comment next to every claim so QA (D3) has a checklist to verify against
-- once both land. One row (claim 204, SS14) additionally needs a pre-existing
-- `events` row -- see that section's comment for why.
--
-- Fixed, explicitly-written UUIDs (never gen_random_uuid()), same reproducibility
-- rationale as db/fixtures/03-founder-score.sql and db/fixtures/07-thesis-engine.sql.
-- Id scheme, all hex-safe:
--
--   05f0<TTTT>-0000-0000-0000-<SEQ, 12 hex digits>
--   TTTT = entity type: 0001 founders / 0002 companies / 0003 founder_company /
--          0004 cards / 0005 claims / 0006 raw_signals / 0007 evidence /
--          0008 events / 0009 ai_runs
--   SEQ  = for founders/companies/founder_company/cards: 001 = Priya
--          Kessler/Ledgerly, 002 = Tomasz Wieckowski/Fenwick Analytics. For
--          claims/raw_signals/evidence: 1xx = Priya/Ledgerly's claims, 2xx =
--          Tomasz/Fenwick's claims, matching the claim's own last 3 digits so
--          a reader can tell which claim a raw_signal/evidence row backs from
--          the id alone. A second, independent corroborating raw_signal for
--          the same claim uses that claim's SEQ + 10 (e.g. claim 104's second
--          source is 114), the same offset convention 03's Pieter Levels rows
--          used for supplementary evidence.
--
-- This range (05f0...) is reserved for this feature and cannot collide with
-- feature 01/09's smoke fixtures (00000000-...-00000000xxx range, and note the
-- `...0950`-`...0959` sub-range within THAT file is reserved for smoke.sql's
-- OWN feature-05 assertions specifically -- design SS10 -- not for this file),
-- feature 03's fixture (03f0...), feature 07's fixture (07f0...), or any other
-- feature's fixture range.
--
-- Both founders/companies are entirely fictional (is_synthetic = true
-- throughout); all non-GitHub/non-HN source URLs use the RFC 2606 reserved
-- .example TLD so they can never collide with a real registration, matching
-- 03/07's convention. GitHub/HN source_urls use the real github.com /
-- news.ycombinator.com domains with fictional org names and fixture-only item
-- ids (also matching 03's precedent), never a real repository or thread.
--
-- Every claim below intentionally routes through the LIVE
-- score_formulas.config.router.prefix_map (design SS4.1) by topic prefix --
-- not asserted, but a property of the topic chosen, cross-checked against the
-- table as of 2026-07-19 when this fixture was written.
--
-- ============================================================================
-- THE TEN CLAIMS -- expectation table (the QA gate's checklist, design SS12
-- acceptance). "Metric" = which half of the helpful-fixes/harmful-flips split
-- (or which other named guard) this row measures.
-- ============================================================================
--
-- id (05f00005-...-SEQ)  topic                              router class     expected derived_status   metric / guard measured
-- ---------------------- ---------------------------------  ---------------  ------------------------  ------------------------------------------------
-- ...0000000101          founder.execution.live_product      factual_static   contradicted              helpful fix (genuinely contradicted, #1)
-- ...0000000102          founder.execution.provenance        factual_static   contradicted              helpful fix (genuinely contradicted, #2)
-- ...0000000103          founder.execution.commit_consistency factual_static  verified                  harmful-flip guard (true+evidenced, #1)
-- ...0000000104          founder.execution.merged_pr_foreign  factual_static  verified                  harmful-flip guard (true+evidenced, #2)
-- ...0000000105          round.cap_table                     unverifiable     missing                   honest gap, REQ-004 canonical case (#1)
-- ...0000000106          traction.customer_references        factual_dynamic  missing                   honest gap + AVeriTeC NEI-to-Refuted guard (#2)
-- ...0000000201          company.geography_country           factual_static   verified                  harmful-flip guard (true+evidenced, #3)
-- ...0000000202          traction.active_users                factual_dynamic verified                  harmful-flip guard (true+evidenced, #4)
-- ...0000000203          founder.execution.external_usage    factual_static   unverified (never verified) Tier-3-only guard -- self-reported cannot self-verify
-- ...0000000204          founder.expertise.vertical_tenure    qualitative      unverified (never anything else) qualitative-class contradiction suppression (SS14) -- documented-tier contradicts STILL present in evidence + a claim_contradicted event, so the trust NUMBER moves and the finding is queryable even though the verdict is pinned
--
-- Rows 101/102 (2 of the "2-3 genuinely contradicted") and 103/104/201/202
-- (4 of the "3-4 true and adequately evidenced") satisfy design SS12's
-- composition minimums; 105/106 are the "1-2 honest gaps"; 203 is "the
-- Tier-3-only claim"; 204 is the qualitative documented-tier contradiction
-- design SS14 says "no live row in the database covers".
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Entities: Priya Kessler (synthetic) + Ledgerly ; Tomasz Wieckowski
-- (synthetic) + Fenwick Analytics
-- ----------------------------------------------------------------------------

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('05f00001-0000-0000-0000-000000000001',
   'Priya Kessler',
   'Founder & CEO, Ledgerly (synthetic fixture -- not a real person)',
   '{"fixture_purpose": "feature 05 truth-gap labelled fixture: hosts 2 genuinely-contradicted claims (SS12 bucket 1), 2 true-and-evidenced claims (bucket 2) and both honest-gap claims (bucket 3)", "note": "Fictional person. Any resemblance to a real founder or company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('05f00002-0000-0000-0000-000000000001',
   'Ledgerly',
   'ledgerly-05.example',
   'Automated transaction reconciliation for mid-size banks (synthetic fixture company).',
   'fintech / ops automation',
   'pre_seed',
   '{"note": "Fictional company. Uses the RFC 2606 reserved .example TLD on purpose so its domain can never collide with a real registration."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founders (id, full_name, headline, profile, is_synthetic) VALUES
  ('05f00001-0000-0000-0000-000000000002',
   'Tomasz Wieckowski',
   'Founder, Fenwick Analytics (synthetic fixture -- not a real person)',
   '{"fixture_purpose": "feature 05 truth-gap labelled fixture: hosts 2 more true-and-evidenced claims (SS12 bucket 2), the Tier-3-only claim (bucket 4) and the qualitative documented-tier contradiction (SS14, the case no live row covers)", "note": "Fictional person. Any resemblance to a real founder or company is coincidental."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, domain, one_liner, category, stage, profile, is_synthetic) VALUES
  ('05f00002-0000-0000-0000-000000000002',
   'Fenwick Analytics',
   'fenwick-analytics-05.example',
   'Retail merchandising analytics for independent brands (synthetic fixture company).',
   'retail tech / analytics',
   'pre_seed',
   '{"note": "Fictional company. Uses the RFC 2606 reserved .example TLD on purpose so its domain can never collide with a real registration."}'::jsonb,
   true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_company (id, founder_id, company_id, role, is_current, confidence, source) VALUES
  ('05f00003-0000-0000-0000-000000000001',
   '05f00001-0000-0000-0000-000000000001',
   '05f00002-0000-0000-0000-000000000001',
   'founder', true, 0.90, 'manual'),
  ('05f00003-0000-0000-0000-000000000002',
   '05f00001-0000-0000-0000-000000000002',
   '05f00002-0000-0000-0000-000000000002',
   'founder', true, 0.90, 'manual')
ON CONFLICT (id) DO NOTHING;

-- One 'founder' card per founder hosting ALL of that founder's claims below,
-- including company-flavoured topics (company.*, traction.*) -- same mixed
-- pattern db/fixtures/03-founder-score.sql uses, and simpler than adding a
-- second 'company'-typed card per entity for a fixture this size. No
-- application_id: this fixture tests per-claim trust (design SS7), not the
-- SS8 rollup, so no `applications` row is needed.
INSERT INTO cards (id, card_type, founder_id, company_id, status, completeness) VALUES
  ('05f00004-0000-0000-0000-000000000001',
   'founder',
   '05f00001-0000-0000-0000-000000000001',
   '05f00002-0000-0000-0000-000000000001',
   'confirmed', 0.70),
  ('05f00004-0000-0000-0000-000000000002',
   'founder',
   '05f00001-0000-0000-0000-000000000002',
   '05f00002-0000-0000-0000-000000000002',
   'confirmed', 0.70)
ON CONFLICT (id) DO NOTHING;

-- axis is left NULL throughout this fixture (unlike 03's founder_score-tagged
-- claims): this fixture is scoped to feature 05's router/verification/trust
-- machinery, not to feature 03's scoring, and axis is not consumed by
-- anything 05 reads (design SS7/SS8 key off topic + evidence, never axis).

-- ============================================================================
-- Priya Kessler / Ledgerly -- claims 101-106
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Claim 101 -- GENUINELY CONTRADICTED #1 (SS12 bucket 1, helpful-fix metric)
-- Topic prefix "founder.execution.live_product" -> factual_static, check
-- url_liveness (design SS4.1). A direct fetch of the claimed production URL
-- (Tier 1 / documented per SS6.0 -- the same class of direct inspection as a
-- domain registration) shows the domain is unconfigured -- the textbook
-- AI-washing shape. No supports row. Expected derived_status: `contradicted`
-- (SS7.4: contradicts at tier documented > 0, no supports).
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000101',
   '05f00004-0000-0000-0000-000000000001',
   'founder.execution.live_product',
   'Ledgerly''s automated reconciliation product is live in production at app.ledgerly-05.example, processing real customer transactions today.',
   NULL, NULL, 'self_reported', 0.45, 'f05fix:claim:101')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000101', 'tavily_extract',
   'https://app.ledgerly-05.example',
   '{"url": "https://app.ledgerly-05.example", "http_status": 404, "extracted_text": "This domain is not configured. Nothing is hosted at this address.", "note": "synthetic fixture: url_liveness check target, direct-fetch result"}'::jsonb,
   'f05fix:rawsignal:101', '05f00001-0000-0000-0000-000000000001', '2026-07-14T09:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000101',
   '05f00005-0000-0000-0000-000000000101', 'contradicts', 0.85, 'documented',
   'This domain is not configured. Nothing is hosted at this address.',
   'https://app.ledgerly-05.example', '05f00006-0000-0000-0000-000000000101',
   'f05fix:evidence:101')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 102 -- GENUINELY CONTRADICTED #2 (SS12 bucket 1, helpful-fix metric)
-- Topic prefix "founder.execution.provenance" -> factual_static, check
-- gh_provenance (design SS4.1/SS5.1b -- MVP's one comparison: earliest commit
-- author date vs. the company's own Show HN submission date, an anchor the
-- founder does not control). The repo's earliest commit postdates the
-- company's own public HN trace by ~4 months -- the opposite of "under
-- development well before Ledgerly was founded". Direct codebase inspection
-- (github_api) = Tier 1 / documented per SS6.0. No supports row. Expected
-- derived_status: `contradicted`.
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000102',
   '05f00004-0000-0000-0000-000000000001',
   'founder.execution.provenance',
   'The ledgerly/recon-engine GitHub repository has been under continuous active development since 2022, well before Ledgerly was founded, showing years of technical groundwork.',
   NULL, NULL, 'self_reported', 0.35, 'f05fix:claim:102')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000102', 'github_api',
   'https://github.com/ledgerly/recon-engine',
   '{"repo": "ledgerly/recon-engine", "earliest_commit_author_date": "2024-05-01T00:00:00Z", "company_hn_show_hn_submission_date": "2024-01-10T00:00:00Z", "note": "synthetic fixture: the repo''s earliest commit author date postdates the company''s own Show HN submission (an anchor the founder does not control, design SS5.1b) by roughly four months -- inconsistent with development since 2022"}'::jsonb,
   'f05fix:rawsignal:102', '05f00001-0000-0000-0000-000000000001', '2026-07-14T09:30:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000102',
   '05f00005-0000-0000-0000-000000000102', 'contradicts', 0.80, 'documented',
   'earliest commit author date 2024-05-01 postdates the company''s own Show HN submission (2024-01-10) by roughly four months',
   'https://github.com/ledgerly/recon-engine', '05f00006-0000-0000-0000-000000000102',
   'f05fix:evidence:102')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 103 -- TRUE AND ADEQUATELY EVIDENCED #1 (SS12 bucket 2 -- harmful-flip
-- guard: this claim must survive verification UNTOUCHED)
-- Topic prefix "founder.execution.commit_consistency" -> factual_static,
-- check gh_commit_weeks. One documented-tier supports row, n_independent = 1
-- (single source slug/host). No contradicts. Expected derived_status:
-- `verified` (SS7.4: supports > 0, tier documented, n_independent >= 1).
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000103',
   '05f00004-0000-0000-0000-000000000001',
   'founder.execution.commit_consistency',
   'GitHub commit history for the ledgerly/recon-engine repo shows activity in 10 of the last 12 weeks.',
   '{"commit_weeks_active": 10, "window_weeks": 12}'::jsonb,
   NULL, 'derived', 0.55, 'f05fix:claim:103')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000103', 'github_api',
   'https://github.com/ledgerly/recon-engine',
   '{"repo": "ledgerly/recon-engine", "commit_weeks_active": 10, "window_weeks": 12}'::jsonb,
   'f05fix:rawsignal:103', '05f00001-0000-0000-0000-000000000001', '2026-07-14T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000103',
   '05f00005-0000-0000-0000-000000000103', 'supports', 0.80, 'documented',
   'commit_weeks_active: 10 of 12',
   'https://github.com/ledgerly/recon-engine', '05f00006-0000-0000-0000-000000000103',
   'f05fix:evidence:103')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 104 -- TRUE AND ADEQUATELY EVIDENCED #2 (SS12 bucket 2, harmful-flip
-- guard). Topic prefix "founder.execution.merged_pr_foreign" -> factual_static,
-- check gh_merged_pr -- the project's own top cold-start weight (CLAUDE.md:
-- "merged PR into foreign repos > PR review..."). TWO independent supports
-- (github_api + hn_algolia, distinct source AND distinct host) so this claim
-- also exercises n_independent = 2 -> independence_factor 0.85. Both tier
-- documented. No contradicts. Expected derived_status: `verified`.
--
-- "openledger/ingest-core" is a fictional upstream OSS project invented for
-- this fixture -- no resemblance to any real repository intended, same
-- fictional-org-on-a-real-domain convention 03's fixture used for
-- fintrace-ai/fintrace-shield on github.com.
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000104',
   '05f00004-0000-0000-0000-000000000001',
   'founder.execution.merged_pr_foreign',
   'Our lead engineer has had three pull requests merged into the independent open-source project openledger/ingest-core, demonstrating engineering credibility validated by an outside maintainer community.',
   '{"merged_prs": 3, "repo": "openledger/ingest-core"}'::jsonb,
   NULL, 'self_reported', 0.50, 'f05fix:claim:104')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000104', 'github_api',
   'https://github.com/openledger/ingest-core',
   '{"repo": "openledger/ingest-core", "merged_prs_by_author": 3, "author": "priya-kessler-dev", "note": "synthetic fixture: fictional upstream OSS project, no resemblance to any real repository intended"}'::jsonb,
   'f05fix:rawsignal:104', '05f00001-0000-0000-0000-000000000001', '2026-07-14T10:15:00Z'),

  ('05f00006-0000-0000-0000-000000000114', 'hn_algolia',
   'https://news.ycombinator.com/item?id=f05fixture114',
   '{"story_title": "Ask HN: notable PRs merged into openledger/ingest-core this quarter? -- priya-kessler-dev''s reconciliation-batching patch got a shoutout", "points": 9, "note": "synthetic fixture: fictional HN thread, independent third-party corroboration"}'::jsonb,
   'f05fix:rawsignal:114', '05f00001-0000-0000-0000-000000000001', '2026-07-14T10:20:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000104',
   '05f00005-0000-0000-0000-000000000104', 'supports', 0.85, 'documented',
   'merged_prs_by_author: 3 (openledger/ingest-core)',
   'https://github.com/openledger/ingest-core', '05f00006-0000-0000-0000-000000000104',
   'f05fix:evidence:104'),

  ('05f00007-0000-0000-0000-000000000114',
   '05f00005-0000-0000-0000-000000000104', 'supports', 0.75, 'documented',
   'notable PRs merged into openledger/ingest-core this quarter -- priya-kessler-dev''s reconciliation-batching patch got a shoutout',
   'https://news.ycombinator.com/item?id=f05fixture114', '05f00006-0000-0000-0000-000000000114',
   'f05fix:evidence:114')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 105 -- HONEST GAP #1 (SS12 bucket 3, the plain case)
-- Topic prefix "round." -> unverifiable. The canonical REQ-004 example
-- ("Cap table: not disclosed"), same convention db/fixtures/07-thesis-engine.sql
-- uses for its missing claims: no raw_signals/evidence rows at all -- a
-- missing claim has no underlying source content to hash or cite.
-- verification_status is set explicitly to 'missing' at insert (not the
-- 'unverified' default). Expected derived_status: `missing` (SS7.4 row 1:
-- class in {qualitative,forecast,unverifiable}, already missing -> stays
-- missing; must never be upgraded away and must never become an accusation).
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000105',
   '05f00004-0000-0000-0000-000000000001',
   'round.cap_table',
   'Cap table: not disclosed.',
   NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 106 -- HONEST GAP #2 (SS12 bucket 3, the AVeriTeC NEI-to-Refuted
-- guard -- the case this bucket's citation is actually about)
--
-- Topic "traction.customer_references" -> prefix "traction." -> factual_dynamic,
-- a class ELIGIBLE for a `contradicted` verdict in principle (unlike claim
-- 105's unverifiable-class gap, which SS7.4 row 1 pins regardless of evidence).
-- The founder's deck never named any customers/LOIs -- this is STUB-003's
-- exact phrasing (design SS13: "references: unavailable at this stage") --
-- but a completed entity-gate pass separately turned up the company's own
-- GitHub README (github_api = direct codebase inspection = Tier 1 / documented
-- per SS6.0) disclosing that two pilot integrations were discontinued. That
-- is a real, hard-tier `contradicts` row sitting on a claim that was never
-- actually asserted.
--
-- On the AVeriTeC shared task, humans-labelled "Not Enough Evidence" claims
-- were answered "Refuted" 60.3% of the time by systems that skip straight to
-- the tier-based contradiction rule (design SS12/plan.md D1). SS7.4's table
-- is evaluated top-down and the "already missing" rows (2 and 3) sit ABOVE
-- the tier-based `contradicted` row precisely to prevent that: "already
-- missing and contradicts > 0" resolves to `missing` + the contradiction
-- surfaced separately, never `contradicted`. This is the row that guards
-- against the failure mode, so it needs a documented-tier contradicts row
-- attached to prove the guard actually holds under the hardest tier, not just
-- the easy (zero-evidence) case claim 105 covers.
--
-- Expected derived_status: `missing` (a gap is never converted into an
-- accusation, no matter how strong the contradicting evidence is).
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, verification_status, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000106',
   '05f00004-0000-0000-0000-000000000001',
   'traction.customer_references',
   'Customer references: unavailable at this stage.',
   NULL, NULL, 'derived', 'missing', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000106', 'github_api',
   'https://github.com/ledgerly/recon-engine',
   '{"repo": "ledgerly/recon-engine", "readme_excerpt": "Note: pilot integrations with two early bank partners were discontinued in Q2 2024 after an internal security review.", "note": "synthetic fixture: a directly-observed, documented-tier fact (their own repo README -- Tier 1 per design SS6.0''s direct-codebase-inspection example) surfaced by an entity-gate pass, attached to a claim the founder never actually made in the deck -- exercises the AVeriTeC NEI-to-Refuted guard (SS7.4 rows 2/3) rather than a trivially-empty gap"}'::jsonb,
   'f05fix:rawsignal:106', '05f00001-0000-0000-0000-000000000001', '2026-07-14T11:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000106',
   '05f00005-0000-0000-0000-000000000106', 'contradicts', 0.70, 'documented',
   'pilot integrations with two early bank partners were discontinued in Q2 2024 after an internal security review',
   'https://github.com/ledgerly/recon-engine', '05f00006-0000-0000-0000-000000000106',
   'f05fix:evidence:106')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Tomasz Wieckowski / Fenwick Analytics -- claims 201-204
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Claim 201 -- TRUE AND ADEQUATELY EVIDENCED #3 (SS12 bucket 2, harmful-flip
-- guard). Topic prefix "company.geography_country" -> factual_static. Single
-- documented-tier supports row (direct public registry lookup, Tier 1 per
-- SS6.0). n_independent = 1. No contradicts. Expected derived_status:
-- `verified`.
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000201',
   '05f00004-0000-0000-0000-000000000002',
   'company.geography_country',
   'Fenwick Analytics is incorporated and headquartered in Warsaw, Poland.',
   '"PL"'::jsonb, NULL, 'self_reported', 0.70, 'f05fix:claim:201')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000201', 'tavily_extract',
   'https://company-registry.example/pl/fenwick-analytics-sp-zoo',
   '{"url": "https://company-registry.example/pl/fenwick-analytics-sp-zoo", "extracted_text": "Fenwick Analytics sp. z o.o. -- registered address: Warsaw, Poland. Registration current, no other jurisdiction on file.", "note": "synthetic fixture: direct public business-registry lookup, Tier 1 per design SS6.0''s registry-filings example"}'::jsonb,
   'f05fix:rawsignal:201', '05f00002-0000-0000-0000-000000000002', '2026-07-15T09:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000201',
   '05f00005-0000-0000-0000-000000000201', 'supports', 0.85, 'documented',
   'registered address: Warsaw, Poland',
   'https://company-registry.example/pl/fenwick-analytics-sp-zoo', '05f00006-0000-0000-0000-000000000201',
   'f05fix:evidence:201')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 202 -- TRUE AND ADEQUATELY EVIDENCED #4 (SS12 bucket 2, harmful-flip
-- guard). Topic prefix "traction." -> factual_dynamic (the paid Tavily
-- branch, design SS5.2). TWO independent discovered-tier supports (distinct
-- source slug AND distinct host: a trade-press mention + a third-party vendor
-- directory listing -- deliberately NOT the founder''s own site, so
-- independence here is unambiguous rather than resting on SS7.3''s documented
-- quirk that a founder-owned host is not excluded by the source-slug rule).
-- n_independent = 2. No contradicts. Expected derived_status: `verified`,
-- exercising the discovered-tier (not just documented-tier) verified path.
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000202',
   '05f00004-0000-0000-0000-000000000002',
   'traction.active_users',
   'Fenwick Analytics has approximately 40 paying retail-analytics customers as of this month.',
   '{"active_customers": 40}'::jsonb,
   NULL, 'self_reported', 0.55, 'f05fix:claim:202')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, company_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000202', 'tavily_news',
   'https://retailtechnews.example/fenwick-40-customers',
   '{"url": "https://retailtechnews.example/fenwick-40-customers", "extracted_text": "Fenwick Analytics, a Warsaw-based retail analytics startup, has grown to roughly 40 paying customers, the company said.", "note": "synthetic fixture: independent trade-press mention"}'::jsonb,
   'f05fix:rawsignal:202', '05f00002-0000-0000-0000-000000000002', '2026-07-15T09:30:00Z'),

  ('05f00006-0000-0000-0000-000000000212', 'tavily_extract',
   'https://retail-vendor-directory.example/fenwick-analytics',
   '{"url": "https://retail-vendor-directory.example/fenwick-analytics", "extracted_text": "Fenwick Analytics -- retail merchandising analytics vendor, ~40 client brands listed in our verified vendor directory.", "note": "synthetic fixture: independent third-party vendor directory, not founder-controlled"}'::jsonb,
   'f05fix:rawsignal:212', '05f00002-0000-0000-0000-000000000002', '2026-07-15T09:35:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000202',
   '05f00005-0000-0000-0000-000000000202', 'supports', 0.65, 'discovered',
   'grown to roughly 40 paying customers',
   'https://retailtechnews.example/fenwick-40-customers', '05f00006-0000-0000-0000-000000000202',
   'f05fix:evidence:202'),

  ('05f00007-0000-0000-0000-000000000212',
   '05f00005-0000-0000-0000-000000000202', 'supports', 0.60, 'discovered',
   '~40 client brands listed in our verified vendor directory',
   'https://retail-vendor-directory.example/fenwick-analytics', '05f00006-0000-0000-0000-000000000212',
   'f05fix:evidence:212')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 203 -- THE TIER-3-ONLY CLAIM (SS12 bucket 4). Topic prefix
-- "founder.execution.external_usage" -> factual_static, check gh_dependents --
-- a class fully ELIGIBLE for `verified` in principle. Its only support is
-- self-reported (source_kind='self_reported', an interview_answer raw_signal,
-- tier explicitly 'inferred' per SS6.0''s Tier-3 mapping) with zero
-- independent corroboration. Two independent guards both suppress
-- `verified` here: (1) SS7.4''s verified rule tests the TIER explicitly
-- ('documented'/'discovered' only) rather than a numeric threshold, so
-- 'inferred' can never qualify no matter how high its strength; (2) SS7.3
-- excludes 'interview_answer' from the independence count entirely, so
-- n_independent = 0 regardless. Expected derived_status: `unverified` (falls
-- to SS7.4's final "otherwise" row) -- must NOT reach `verified`, per SS6.0:
-- "a Tier-3 claim can never bootstrap itself into `verified`".
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000203',
   '05f00004-0000-0000-0000-000000000002',
   'founder.execution.external_usage',
   'Our open-source ingestion SDK is now a dependency in over 50 other projects, per our own internal telemetry dashboard.',
   '{"dependent_projects_reported": 50}'::jsonb,
   NULL, 'self_reported', 0.35, 'f05fix:claim:203')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000203', 'interview_answer',
   NULL,
   '{"question": "How many downstream projects depend on your SDK?", "answer": "Around 50, based on our own internal telemetry dashboard -- we haven''t cross-checked against the public registry.", "note": "synthetic fixture: self-reported only, zero independent corroboration by construction"}'::jsonb,
   'f05fix:rawsignal:203', '05f00001-0000-0000-0000-000000000002', '2026-07-15T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000203',
   '05f00005-0000-0000-0000-000000000203', 'supports', 0.40, 'inferred',
   'Around 50, based on our own internal telemetry dashboard',
   NULL, '05f00006-0000-0000-0000-000000000203',
   'f05fix:evidence:203')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Claim 204 -- QUALITATIVE CLASS, DOCUMENTED-TIER CONTRADICTION (design SS14,
-- "no live row in the database covers this case"). Topic prefix
-- "founder.expertise." -> qualitative -- SS5.3's branch writes only `context`
-- evidence and "cannot contradict" on its OWN pass. This scenario represents
-- a documented-tier contradiction reaching the claim through an ADJACENT
-- mechanism (an entity-gate / public-registry cross-check, NOT one of SS5's
-- four verification branches) -- exactly how the one live analogue mentioned
-- in SS14 (founder.expertise.insight in db/fixtures/03-founder-score.sql,
-- claim ...0103) actually got its 'contradicts' row: feature 03's own
-- red-flag machinery wrote it, not 05's qualitative branch. That live row is
-- 'inferred' tier, so per SS7.2 it moves neither the verdict nor the trust
-- number -- this fixture supplies the DOCUMENTED-tier case, which does move
-- the number even though the verdict stays pinned.
--
-- The claim itself is genuinely asserted (NOT a 'missing' placeholder, unlike
-- 105/106) -- verification_status left at its 'unverified' default.
--
-- Expected derived_status: `unverified`, never anything else (SS7.4 row 1:
-- class in {qualitative,forecast,unverifiable} -> "else unverified"). The
-- documented-tier contradicts row below still moves the TRUST NUMBER via
-- SS7.2's contradiction_penalty (n_contradicts_counting counts documented/
-- discovered contradicts regardless of class), and the claim_contradicted
-- event below (SS6.2/SS9) is what lets 06/09 surface the finding at all --
-- "suppressing the verdict on a judgement claim is correct; suppressing the
-- finding is not" (SS14).
-- ----------------------------------------------------------------------------

INSERT INTO claims (id, card_id, topic, text_verbatim, value, axis, source_kind, base_confidence, content_hash) VALUES
  ('05f00005-0000-0000-0000-000000000204',
   '05f00004-0000-0000-0000-000000000002',
   'founder.expertise.vertical_tenure',
   'Tomasz has spent over 8 years working in retail-analytics and merchandising software, giving him deep domain expertise in the space Fenwick now serves.',
   NULL, NULL, 'self_reported', 0.55, 'f05fix:claim:204')
ON CONFLICT (id) DO NOTHING;

INSERT INTO raw_signals (id, source, source_url, payload, content_hash, founder_id, observed_at) VALUES
  ('05f00006-0000-0000-0000-000000000204', 'tavily_extract',
   'https://officer-registry.example/tomasz-wieckowski',
   '{"url": "https://officer-registry.example/tomasz-wieckowski", "extracted_text": "Tomasz Wieckowski -- director appointments on file: Brightline Logistics Ltd (freight/logistics software), appointed 2021-03-01 to present. No prior directorships on record.", "note": "synthetic fixture: direct public company-officer registry record, Tier 1 per design SS6.0''s registry-filings example"}'::jsonb,
   'f05fix:rawsignal:204', '05f00001-0000-0000-0000-000000000002', '2026-07-15T11:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, claim_id, relation, strength, tier, quote_verbatim, source_url, raw_signal_id, content_hash) VALUES
  ('05f00007-0000-0000-0000-000000000204',
   '05f00005-0000-0000-0000-000000000204', 'contradicts', 0.75, 'documented',
   'director appointments on file: Brightline Logistics Ltd (freight/logistics software), appointed 2021-03-01 to present. No prior directorships on record.',
   'https://officer-registry.example/tomasz-wieckowski', '05f00006-0000-0000-0000-000000000204',
   'f05fix:evidence:204')
ON CONFLICT (id) DO NOTHING;

-- ai_runs row: NOT an LLM step (the entity resolution below resolves by
-- raw_signal FK, method 1 of SS6 -- no model call was needed), but recorded
-- anyway so the event's `run_id` below is traceable to something concrete per
-- SS9's audit-trail pattern, rather than a dangling id. model names the
-- deterministic check, not a language model -- consistent with SS5.1's "all
-- zero-LLM" stance for factual_static-style checks and SS6.0b's "no LLM in
-- this feature ever emits a confidence number" (confidence intentionally
-- NULL here: this is a registry lookup, not a model judgement).
INSERT INTO ai_runs (id, task_type, founder_id, model, output_json, created_at) VALUES
  ('05f00009-0000-0000-0000-000000000204',
   'truth_gap', '05f00001-0000-0000-0000-000000000002',
   'deterministic:registry_cross_check',
   '{"check": "public_registry_cross_check", "claim_id": "05f00005-0000-0000-0000-000000000204", "finding": "director appointments on file: Brightline Logistics Ltd (freight/logistics software), appointed 2021-03-01 to present. No prior directorships on record.", "note": "synthetic fixture: zero-LLM deterministic registry cross-check, not one of design SS5''s four verification branches -- see the claim-204 comment above for why this event has no other live producer"}'::jsonb,
   '2026-07-15T11:05:00Z')
ON CONFLICT (id) DO NOTHING;

-- The claim_contradicted event itself (design SS6.2: the union of SS9's audit
-- fields and SS6.1's contradiction-record object, one event, one payload).
-- entity_type='founder' / entity_id=founders.id (NEVER claim_id, SS9's GDPR
-- rule -- purge_founder() sweeps on exactly this shape) -- claim_id lives
-- inside the payload instead. verdict_before = verdict_after = 'unverified':
-- the qualitative class gate never lets this contradiction move the verdict,
-- by design (SS7.4 row 1) -- only the trust NUMBER moves, via the evidence
-- row above. resolved_by='raw_signal_fk' because raw_signal 204 above already
-- carries founder_id -- the strongest of SS6's three resolution methods, no
-- model quote needed.
INSERT INTO events (id, event_type, entity_type, entity_id, payload, actor) VALUES
  ('05f00008-0000-0000-0000-000000000204',
   'claim_contradicted', 'founder', '05f00001-0000-0000-0000-000000000002',
   '{
      "claim_id": "05f00005-0000-0000-0000-000000000204",
      "class": "qualitative",
      "check": "public_registry_cross_check",
      "verdict_before": "unverified",
      "verdict_after": "unverified",
      "source_url": "https://officer-registry.example/tomasz-wieckowski",
      "checked_at": "2026-07-15T11:05:00Z",
      "run_id": "05f00009-0000-0000-0000-000000000204",
      "nature": "factual",
      "severity": "moderate",
      "founder_claim": "Tomasz has spent over 8 years working in retail-analytics and merchandising software, giving him deep domain expertise in the space Fenwick now serves.",
      "found_reality": "director appointments on file: Brightline Logistics Ltd (freight/logistics software), appointed 2021-03-01 to present. No prior directorships on record.",
      "question": "Can you walk us through your work history in retail or merchandising software prior to 2021?",
      "entity_match": {
        "resolved_by": "raw_signal_fk",
        "quote": "director appointments on file: Brightline Logistics Ltd (freight/logistics software), appointed 2021-03-01 to present.",
        "disambiguator": "Tomasz Wieckowski"
      }
    }'::jsonb,
   'fixture:db/fixtures/05-truth-gap.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
