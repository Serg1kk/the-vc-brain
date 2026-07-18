-- db/schema.sql
--
-- The VC Brain -- Memory layer schema (feature 01: docs/backlog/01-memory-data-model/).
-- Authoritative design: docs/backlog/01-memory-data-model/design.md (SS4-SS5).
--
-- Conventions (binding for every table group appended below, Tasks 3-8):
--   * CREATE TABLE IF NOT EXISTS -- never bare CREATE TABLE, never DROP.
--   * CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER (PG14+) for every
--     function and trigger -- this file must stay safely re-appliable end to end.
--   * Additive-only. No migration tooling in this project (design.md SS10) -- a
--     changed column is a NEW column + backfill, never an ALTER of an existing one.
--   * Append order follows the FK dependency chain and MUST NOT be reordered:
--       registries (Task 3) -> identity core (Task 4) -> funnel (Task 5)
--       -> evidence ledger (Task 6) -> intelligence (Task 7)
--       -> interview/experience/ops (Task 8) -> enforcement layer (Task 9).
--   * id uuid PRIMARY KEY DEFAULT gen_random_uuid() -- gen_random_uuid() ships in
--     Postgres core since PG13, no extension needed on Supabase's PG15+ image.
--   * created_at timestamptz DEFAULT now() on every table; updated_at + trigger
--     ONLY on the mutable tables listed in design.md SS5.3.
--   * All identifiers snake_case, English (project CLAUDE.md language policy).
--
-- Applied via db/apply.sh (psql, ON_ERROR_STOP=1). Do not apply by hand.

-- ============================================================================
-- Task 3: Registries (design.md SS4.1)
-- Extensible by INSERT: a new signal source / card type / metric kind / score
-- axis is a row, never a migration. Seeded in db/seed.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS score_axes (
  slug               text PRIMARY KEY,
  label              text NOT NULL,
  description        text,
  is_screening_axis  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_sources (
  slug        text PRIMARY KEY,
  label       text NOT NULL,
  -- Default evidence tier for this source; same vocabulary as evidence.tier
  -- (design.md SS4.4) so a source's base_tier can seed a claim's evidence tier
  -- without a translation table.
  base_tier   text CHECK (base_tier IN ('documented', 'discovered', 'inferred', 'missing')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_types (
  slug            text PRIMARY KEY,
  label           text NOT NULL,
  section_schema  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metric_kinds (
  slug        text PRIMARY KEY,
  label       text NOT NULL,
  unit        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Task 4: Identity core (design.md SS4.2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS founders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name                text NOT NULL,
  normalized_name          text GENERATED ALWAYS AS (lower(trim(full_name))) STORED,
  headline                 text,
  location_city            text,
  location_country         text,
  profile                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_synthetic             boolean NOT NULL DEFAULT false,
  -- Duplicate-canonicalization tombstone. RESTRICT (not CASCADE/SET NULL): a
  -- merged-duplicate founder row must never be dropped by a parent delete --
  -- purge_founder (Task 9) is the only path that walks and clears this chain
  -- (plan.md Task 9 R3: a self-FK RESTRICT is what forces the purge traversal).
  merged_into_founder_id   uuid REFERENCES founders(id) ON DELETE RESTRICT,
  opt_out_at               timestamptz,
  search_tsv               tsvector GENERATED ALWAYS AS (
                              to_tsvector('english',
                                coalesce(full_name, '') || ' ' ||
                                coalesce(headline, '') || ' ' ||
                                coalesce(location_city, '') || ' ' ||
                                coalesce(location_country, '')
                              )
                            ) STORED,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- Mutable table (design.md SS5.3 bucket 2) -- updated_at trigger attached
  -- centrally in Task 9 Step 2 (touch_updated_at() does not exist yet here).
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_founders_normalized_name ON founders (normalized_name);
CREATE INDEX IF NOT EXISTS idx_founders_search_tsv ON founders USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_founders_merged_into ON founders (merged_into_founder_id)
  WHERE merged_into_founder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  normalized_name   text GENERATED ALWAYS AS (lower(trim(name))) STORED,
  domain            text UNIQUE,
  one_liner         text,
  category          text,
  -- Early-stage only (operator, Jul 19) -- no series_a+ ever lands here.
  stage             text NOT NULL CHECK (stage IN ('pre_seed', 'seed')),
  hq_city           text,
  hq_country        text,
  aliases           text[] NOT NULL DEFAULT '{}',
  profile           jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_synthetic      boolean NOT NULL DEFAULT false,
  search_tsv        tsvector GENERATED ALWAYS AS (
                       to_tsvector('english',
                         coalesce(name, '') || ' ' ||
                         coalesce(one_liner, '') || ' ' ||
                         coalesce(category, '')
                       )
                     ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_companies_normalized_name ON companies (normalized_name);
CREATE INDEX IF NOT EXISTS idx_companies_search_tsv ON companies USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS founder_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id      uuid NOT NULL REFERENCES founders(id) ON DELETE RESTRICT,
  -- Deliberately NO CHECK on kind: new identity platforms (e.g. producthunt)
  -- must not need a migration (design.md SS4.2, extensibility stance). Seed
  -- vocabulary for reference only: github, hn, site, linkedin, x, email.
  kind            text NOT NULL,
  value           text NOT NULL,
  url             text,
  confidence      numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  discovered_via  text,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- DB-level dedup gate: re-ingesting the same GitHub login cannot create a
  -- second person (design.md SS4.2; proven in db/tests/smoke.sql).
  UNIQUE (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_founder_identities_founder_id ON founder_identities (founder_id);

CREATE TABLE IF NOT EXISTS founder_company (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id   uuid NOT NULL REFERENCES founders(id) ON DELETE RESTRICT,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role         text NOT NULL CHECK (role IN ('founder', 'cofounder', 'early_hire')),
  is_current   boolean NOT NULL DEFAULT true,
  confidence   numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (founder_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_founder_company_founder_id ON founder_company (founder_id);
CREATE INDEX IF NOT EXISTS idx_founder_company_company_id ON founder_company (company_id);

-- ============================================================================
-- Task 5: Funnel (design.md SS4.3)
-- ============================================================================

CREATE TABLE IF NOT EXISTS theses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     int NOT NULL DEFAULT 1,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sole-founder company subtrees are only ever removed via purge_founder's
  -- explicit ordered deletes (Task 9); RESTRICT keeps a bare `DELETE FROM
  -- companies` from silently orphaning/cascading an application chain.
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  -- Always system-known at ingest time (which track wrote this row) -- not
  -- part of the human-facing "minimal intake" surface, so NOT NULL with no
  -- default: the ingesting workflow must say which track it is.
  kind               text NOT NULL CHECK (kind IN ('inbound', 'radar_activated')),
  status             text NOT NULL DEFAULT 'sourced'
                       CHECK (status IN ('sourced', 'screening', 'diligence', 'decision', 'invest', 'pass')),
  -- Nullable: minimal intake must not depend on a seeded thesis (REQ-008); the
  -- thesis-gate step fills this in. SET NULL: losing a thesis reference must
  -- never block/delete the application it is attached to.
  thesis_id          uuid REFERENCES theses(id) ON DELETE SET NULL,
  thesis_gate        text CHECK (thesis_gate IN ('passed', 'failed', 'borderline')),
  -- Minimal intake floor (REQ-008): company_id above + deck_storage_path here
  -- are the only two things an applicant must supply.
  deck_storage_path  text NOT NULL,
  artifact_links     jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_company_id ON applications (company_id);
CREATE INDEX IF NOT EXISTS idx_applications_thesis_id ON applications (thesis_id) WHERE thesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);

-- (table groups appended below by Tasks 6-8; enforcement layer by Task 9)
