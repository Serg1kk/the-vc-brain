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
