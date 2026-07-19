-- db/seed.sql
--
-- Seed data for db/schema.sql -- registry rows and any other reference data.
-- Authoritative source for values: docs/backlog/01-memory-data-model/design.md SS4.1
-- and docs/backlog/01-memory-data-model/plan.md Task 3.
--
-- Conventions (binding for every INSERT appended below):
--   * Every INSERT ends with ON CONFLICT (<natural key>) DO NOTHING -- seeding must
--     be idempotent: running db/apply.sh twice against the same database changes
--     nothing and errors on nothing.
--   * Seed rows only for registry tables (score_axes, signal_sources, card_types,
--     metric_kinds) per plan.md Task 3. No fixture/demo data here -- that is
--     feature 11's job (synthetic founders/companies, is_synthetic = true).
--   * Applied strictly after schema.sql in the same run (see db/apply.sh) --
--     every table referenced here must already exist.
--
-- Applied via db/apply.sh (psql, ON_ERROR_STOP=1). Do not apply by hand.

-- ============================================================================
-- Task 3: Registry seeds (design.md SS4.1)
-- ============================================================================

INSERT INTO score_axes (slug, label, description, is_screening_axis) VALUES
  ('founder',         'Founder',
   'Independent screening axis: founder capability/trajectory signal.', true),
  ('market',          'Market',
   'Independent screening axis: market size, timing and dynamics.', true),
  ('idea_vs_market',  'Idea vs Market',
   'Independent screening axis: product-market fit of the idea against the market.', true),
  ('trust',           'Trust',
   'Application-level rollup derived from per-claim trust (written by feature 05); per-claim trust itself is always computed live from evidence, never stored per company.', false),
  ('founder_score',   'Founder Score',
   'Persistent, cross-application founder score stored in Memory; an input to the founder axis, never a replacement (REQ-002).', false)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO signal_sources (slug, label, base_tier) VALUES
  ('github_api',        'GitHub API',                 'documented'),
  ('hn_algolia',         'Hacker News (Algolia)',       'documented'),
  ('tavily_extract',    'Tavily Extract/Crawl/Map',    'discovered'),
  ('deck_parse',         'Deck Parse',                  'documented'),
  ('interview_answer',  'Interview Answer',            'discovered'),
  ('manual',              'Manual Entry',                 'documented')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO card_types (slug, label) VALUES
  ('company', 'Company'),
  ('founder', 'Founder'),
  ('team',    'Team')
ON CONFLICT (slug) DO NOTHING;

-- Starter set (design.md SS4.1 example list); extensible by INSERT as new
-- sourcing signals come online -- not an exhaustive vocabulary.
INSERT INTO metric_kinds (slug, label, unit) VALUES
  ('gh_stars',         'GitHub stars',                          'count'),
  ('gh_commit_weeks',  'GitHub active commit weeks',            'weeks'),
  ('gh_merged_prs',    'GitHub merged PRs (external repos)',    'count'),
  ('hn_points',        'Hacker News points',                    'count'),
  ('site_updated',     'Days since personal site last updated', 'days')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- Feature 04 (outbound sourcing): additional signal_sources rows.
-- New source, not a migration -- same extensibility stance as Task 3 above.
-- ============================================================================

INSERT INTO signal_sources (slug, label, base_tier) VALUES
  ('tavily_search',  'Tavily Search',         'discovered'),
  ('tavily_news',    'Tavily Search (news)',  'discovered')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- Feature 03 (founder score): score_axes registry growth + the shipped
-- rubric formula. docs/backlog/03-founder-score/design.md SS4.2/SS4.3.
-- ============================================================================

-- thesis_fit is owned by feature 07 (below) -- founder_score's own axis row
-- already exists from Task 3's original INSERT (score_axes has carried it
-- since feature 01); no new axis row is needed here, only the formula config
-- that scores against it.

-- Exactly one active formula per axis (uq_score_formulas_active_axis, Feature
-- 03 schema addition) -- this is the boolean-rubric config the deterministic
-- aggregator in lib/f03/scoring.js reads at run time: 12 criteria across 3
-- sub-scorers, credit table by evidence tier, red-flag demotions, and
-- min_coverage. All arithmetic constants live here, none in code, so the
-- weights are auditable against a single row.
INSERT INTO score_formulas (version, axis, config, active) VALUES (
  'formula_v1', 'founder_score',
  '{"credit": {"not_met": 0.0, "self_asserted": 0.3, "met_discovered": 0.8, "met_documented": 1.0}, "criteria": [{"id": "E1", "raw": 5, "anchor": "Merged PR into a repo they do not own, within 12 months", "weight": 0.10000, "neg_src": ["github_api"], "subscorer": "execution-signals"}, {"id": "E3", "raw": 3, "anchor": "Commits present in ≥8 of the last 12 weeks (consistency, not volume)", "weight": 0.06000, "neg_src": ["github_api"], "subscorer": "execution-signals"}, {"id": "E4", "raw": 5, "anchor": "A live production URL responds — not merely a repository", "weight": 0.10000, "neg_src": ["tavily_extract", "github_api"], "subscorer": "execution-signals"}, {"id": "E5", "raw": 4, "anchor": "Measured external usage: forks / dependents / downloads / transactions", "weight": 0.08000, "neg_src": ["github_api"], "subscorer": "execution-signals"}, {"id": "E7", "raw": 3, "anchor": "Provenance clean: first-commit date consistent with account age; no earlier source for the flagship repo", "weight": 0.06000, "neg_src": ["github_api"], "subscorer": "execution-signals"}, {"id": "X1", "raw": 5, "anchor": "Documented tenure in the same vertical as the startup", "weight": 0.09375, "neg_src": ["deck_parse", "interview_answer", "tavily_extract"], "subscorer": "expertise-signals"}, {"id": "X2", "raw": 4, "anchor": "Insight specificity: states something about the industry an outsider could not guess", "weight": 0.07500, "neg_src": ["deck_parse", "interview_answer", "tavily_extract"], "subscorer": "expertise-signals"}, {"id": "X5", "raw": 3, "anchor": "Describes competitors at insider granularity (where deals are lost, what breaks in production) rather than pricing-page level", "weight": 0.05625, "neg_src": ["deck_parse", "interview_answer"], "subscorer": "expertise-signals"}, {"id": "X6", "raw": 4, "anchor": "Did substantial work nobody asked for, before any funding", "weight": 0.07500, "neg_src": ["github_api", "tavily_extract"], "subscorer": "expertise-signals"}, {"id": "L2", "raw": 5, "anchor": "First customers / LOI / pilot evidence", "weight": 0.15000, "neg_src": ["deck_parse", "interview_answer"], "subscorer": "leadership-sales-proxies"}, {"id": "L3", "raw": 3, "anchor": "ICP specificity: vertical + size + buyer role + trigger + current alternative", "weight": 0.09000, "neg_src": ["deck_parse", "interview_answer"], "subscorer": "leadership-sales-proxies"}, {"id": "L5", "raw": 2, "anchor": "Written communication concise and structured under compression (Show HN, homepage stranger-test)", "weight": 0.06000, "neg_src": ["hn_algolia", "tavily_extract"], "subscorer": "leadership-sales-proxies"}], "red_flags": [{"id": "R1", "demote_to": "not_met", "contradicts": ["E7", "E1"]}, {"id": "R2", "demote_to": "self_asserted", "contradicts": ["E5"]}, {"id": "R4", "demote_to": "self_asserted", "contradicts": ["E4", "X2"]}], "tier_factor": {"missing": 0.0, "inferred": 0.4, "discovered": 0.7, "documented": 1.0}, "min_coverage": 0.25, "topic_routing": {"prefix_map": {"founder.execution.": "execution-signals", "founder.expertise.": "expertise-signals", "founder.leadership.": "leadership-sales-proxies"}, "red_flags_pack": "union_of_all_claims", "unmatched_pack": "union_of_all_claims"}, "trend_epsilon": 3.0, "subscorer_weights": {"execution-signals": 0.40, "expertise-signals": 0.30, "leadership-sales-proxies": 0.30}, "max_claims_per_agent": 40}'::jsonb,
  true
)
ON CONFLICT (version, axis) DO NOTHING;

-- ============================================================================
-- Feature 02 (sourcing radar): metric_kinds registry growth.
-- docs/backlog/02-sourcing-radar/design.md SS6.4. New metrics, not a
-- migration -- same extensibility stance as Task 3 above. `site_updated` and
-- `hn_points` are REUSED, not duplicated -- both are already seeded above
-- with the same meaning the radar needs.
-- ============================================================================

INSERT INTO metric_kinds (slug, label, unit) VALUES
  ('gh_followers',         'GitHub followers',                                             'count'),
  ('gh_notable_followers',  'GitHub followers who themselves exceed a follower threshold', 'count'),
  ('gh_forks',              'GitHub forks (measured external usage)',                       'count'),
  ('gh_dependents',        'GitHub dependents (packages/repos depending on this one)',      'count'),
  ('hn_karma',              'Hacker News karma',                                            'count'),
  ('hn_comments',           'Hacker News comments (own thread size)',                       'count'),
  ('hn_author_replies',    'Hacker News author replies in their own thread',                'count')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- Feature 07 (thesis engine): score_axes growth + the starting thesis.
-- docs/backlog/07-thesis-engine/design.md SS5.3/SS7.
-- ============================================================================

-- Deterministic thesis-fit score from feature 07's rule evaluation; the
-- fourth non-screening axis alongside trust/founder_score. is_screening_axis
-- MUST be false: the three screening axes (founder/market/idea_vs_market)
-- are fixed per REQ-002, and this axis is independent of them by design
-- (invariant #1), never blended in.
INSERT INTO score_axes (slug, label, description, is_screening_axis) VALUES
  ('thesis_fit', 'Thesis Fit',
   'Deterministic thesis-fit score from feature 07 rule evaluation; independent of the three screening axes (invariant #1), never blended.',
   false)
ON CONFLICT (slug) DO NOTHING;

-- The gate cannot run without a thesis, so this row is system configuration,
-- not demo data, and ships in 07's own SQL. active=true AND is_default=true
-- together satisfy uq_theses_single_default -- without a row satisfying
-- both, the gate has nothing to load and every call fails. A generic
-- starting mandate: early-stage, generalist-technology focus, one hard
-- exclusion, one soft focus rule, and an "off-thesis but exceptional" lane
-- keyed on founder_score so a strong founder outside the stated focus is
-- down-ranked, never hidden.
INSERT INTO theses (name, version, config, active, is_default) VALUES (
  'default', 1,
  '{"fit": {"base": 50, "min_coverage": 0.5, "mandate_weight": 20, "strong_threshold": 70, "soft_deal_breaker_penalty": 30}, "geos": ["DE", "FR", "NL", "US"], "rules": [{"id": "R1", "expr": {"op": "in", "field": "sector", "value": ["gambling", "adtech"]}, "kind": "deal_breaker", "label": "Excluded sector: gambling", "weight": 0, "enabled": true, "enforcement": "hard", "hard_justification": "mandate_fatal"}, {"id": "R2", "expr": {"op": "eq", "field": "business_model", "value": "b2b"}, "kind": "focus", "label": "B2B focus", "weight": 25, "enabled": true, "enforcement": "soft"}], "mandate": {"stages": ["pre_seed", "seed"], "sectors": ["b2b-software", "ai-infra", "devtools"], "geographies": ["EU", "US"], "risk_appetite": "high", "check_size_usd": {"max": 150000, "min": 50000}, "ownership_target_pct": null}, "schema_version": 1, "exceptional_lane": {"axis": "founder_score", "aggregate": "max", "min_value": 75}, "negative_keywords": ["casino", "betting"], "positive_keywords": ["developer tools", "infrastructure"]}'::jsonb,
  true, true
)
ON CONFLICT (name, version) DO NOTHING;
