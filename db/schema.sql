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
  -- Minimal intake floor (REQ-008) for the INBOUND track only: company_id
  -- above + deck_storage_path here. Nullable at the column level -- the
  -- inbound-only requirement is enforced by the named CHECK constraint below
  -- (design.md SS4.3 addendum, 2026-07-19): radar_activated rows are deckless
  -- by definition -- cold-outreach funnel entries created before the founder
  -- ever applies.
  deck_storage_path  text,
  artifact_links     jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_company_id ON applications (company_id);
CREATE INDEX IF NOT EXISTS idx_applications_thesis_id ON applications (thesis_id) WHERE thesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);

-- Backward-compat guard for the pre-addendum live table (already created with
-- deck_storage_path NOT NULL by an earlier apply): idempotent regardless of
-- whether this run just created the table above or is fixing an existing one.
-- DROP NOT NULL on an already-nullable column is a safe no-op, not an error.
ALTER TABLE applications ALTER COLUMN deck_storage_path DROP NOT NULL;

-- No native "ADD CONSTRAINT IF NOT EXISTS" in Postgres -- guard via pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'applications_deck_required_for_inbound'
      AND conrelid = 'applications'::regclass
  ) THEN
    ALTER TABLE applications
      ADD CONSTRAINT applications_deck_required_for_inbound
      CHECK (kind <> 'inbound' OR deck_storage_path IS NOT NULL);
  END IF;
END $$;

-- ============================================================================
-- Task 6: Evidence ledger (design.md SS4.4)
-- ============================================================================

CREATE TABLE IF NOT EXISTS raw_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL REFERENCES signal_sources(slug) ON DELETE RESTRICT,
  source_url    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Dedup + idempotent n8n retries: a retried sourcing workflow re-posting the
  -- same observation must be a no-op, not a duplicate row.
  content_hash  text NOT NULL UNIQUE,
  founder_id    uuid REFERENCES founders(id) ON DELETE RESTRICT,
  company_id    uuid REFERENCES companies(id) ON DELETE RESTRICT,
  -- Business timestamp of the observation itself, distinct from created_at
  -- (ingestion time below) -- callers must supply it, no silent default.
  observed_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
  -- Append-only (Task 9 forbid_mutation target): no updated_at.
);

CREATE INDEX IF NOT EXISTS idx_raw_signals_founder_id ON raw_signals (founder_id) WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_signals_company_id ON raw_signals (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_signals_source ON raw_signals (source);

CREATE TABLE IF NOT EXISTS cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_type       text NOT NULL REFERENCES card_types(slug) ON DELETE RESTRICT,
  founder_id      uuid REFERENCES founders(id) ON DELETE RESTRICT,
  company_id      uuid REFERENCES companies(id) ON DELETE RESTRICT,
  application_id  uuid REFERENCES applications(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'prefilled', 'confirmed')),
  completeness    numeric(3,2) CHECK (completeness BETWEEN 0 AND 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cards_founder_id ON cards (founder_id) WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_company_id ON cards (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_application_id ON cards (application_id) WHERE application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS claims (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id              uuid NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  -- Dotted slug vocabulary, free-form (design.md SS11 open item): e.g.
  -- traction.users, founder.domain_expertise, market.competitors.
  topic                text NOT NULL,
  -- Word-for-word source text -- the verbatim layer against LLM echo-chamber
  -- re-centering (RSK-003).
  text_verbatim        text NOT NULL,
  value                jsonb,
  axis                 text REFERENCES score_axes(slug) ON DELETE RESTRICT,
  source_kind          text NOT NULL CHECK (source_kind IN ('self_reported', 'public', 'interview', 'voice', 'derived')),
  base_confidence      numeric(3,2) CHECK (base_confidence BETWEEN 0 AND 1),
  verification_status  text NOT NULL DEFAULT 'unverified'
                         CHECK (verification_status IN ('unverified', 'partially_supported', 'verified', 'contradicted', 'missing')),
  -- Idempotency; nullable -- a synthesized/derived "missing" marker claim has
  -- no underlying raw content to hash.
  content_hash         text UNIQUE,
  -- Corrections are new rows; history never erased (koi/actual-news pattern).
  supersedes_claim_id  uuid REFERENCES claims(id) ON DELETE RESTRICT,
  -- M1 addendum (absent from design.md SS4.4's column list, required by SS7):
  -- feeds NL-search over topic + verbatim text.
  search_tsv           tsvector GENERATED ALWAYS AS (
                          to_tsvector('english', coalesce(topic, '') || ' ' || coalesce(text_verbatim, ''))
                        ) STORED,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Mutable table (SS5.3): only verification_status is meant to change post-
  -- insert (recomputed from evidence); text/value corrections go through
  -- supersedes_claim_id instead. touch_updated_at trigger attached in Task 9.
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_card_id ON claims (card_id);
CREATE INDEX IF NOT EXISTS idx_claims_axis ON claims (axis) WHERE axis IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_verification_status ON claims (verification_status);
CREATE INDEX IF NOT EXISTS idx_claims_supersedes ON claims (supersedes_claim_id) WHERE supersedes_claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_search_tsv ON claims USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  relation        text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'context')),
  strength        numeric(3,2) CHECK (strength BETWEEN 0 AND 1),
  -- sieve-mcp vocabulary; same vocabulary as signal_sources.base_tier (Task 3).
  tier            text NOT NULL CHECK (tier IN ('documented', 'discovered', 'inferred', 'missing')),
  quote_verbatim  text,
  source_url      text,
  raw_signal_id   uuid REFERENCES raw_signals(id) ON DELETE RESTRICT,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  -- Writer computes over claim_id+relation+source_url+quote -- a retried
  -- truth-gap workflow cannot double-insert and skew per-claim trust.
  content_hash    text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
  -- Append-only (Task 9 forbid_mutation target): no updated_at.
);

CREATE INDEX IF NOT EXISTS idx_evidence_claim_id ON evidence (claim_id);
CREATE INDEX IF NOT EXISTS idx_evidence_raw_signal_id ON evidence (raw_signal_id) WHERE raw_signal_id IS NOT NULL;

-- ============================================================================
-- Task 7: Intelligence (design.md SS4.5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Subject is founder_id XOR application_id (design.md SS4.5) -- exactly one
  -- of the two must be set. The sum-equals-1 form rejects BOTH set and
  -- NEITHER set with the same CHECK (two-sided XOR, m1).
  founder_id        uuid REFERENCES founders(id) ON DELETE RESTRICT,
  application_id    uuid REFERENCES applications(id) ON DELETE RESTRICT,
  axis              text NOT NULL REFERENCES score_axes(slug) ON DELETE RESTRICT,
  value             numeric(5,2) NOT NULL CHECK (value BETWEEN 0 AND 100),
  trend             text CHECK (trend IN ('improving', 'stable', 'declining')),
  confidence        numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  -- What was absent when this was computed -- feeds REQ-003 (missing data
  -- lowers confidence, never the score itself).
  missing_flags     jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_claim_ids   uuid[] NOT NULL DEFAULT '{}',
  formula_version   text,
  prompt_version    text,
  model             text,
  thesis_id         uuid REFERENCES theses(id) ON DELETE SET NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Append-only (Task 9 forbid_mutation target): "never reset" is a grant, not
  -- a convention -- no updated_at, UPDATE/DELETE revoked at the DB level.
  CONSTRAINT scores_subject_xor CHECK (
    ((founder_id IS NOT NULL)::int + (application_id IS NOT NULL)::int) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_scores_founder_axis ON scores (founder_id, axis, computed_at)
  WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scores_application_axis ON scores (application_id, axis, computed_at)
  WHERE application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Free text on purpose (extraction, scoring, memo, interview_turn,
  -- truth_gap, ... -- design.md SS4.5): new task types must not need a
  -- migration, same extensibility stance as founder_identities.kind.
  task_type         text NOT NULL,
  founder_id        uuid REFERENCES founders(id) ON DELETE RESTRICT,
  company_id        uuid REFERENCES companies(id) ON DELETE RESTRICT,
  application_id    uuid REFERENCES applications(id) ON DELETE RESTRICT,
  model             text NOT NULL,
  prompt_version    text,
  input_hash        text,
  output_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  -- Multi-model/panel divergence preserved, never erased.
  disagreement      jsonb,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
  -- Append-only (Task 9 forbid_mutation target): no updated_at.
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_founder_id ON ai_runs (founder_id) WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_runs_company_id ON ai_runs (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_runs_application_id ON ai_runs (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_runs_task_type ON ai_runs (task_type);

-- ============================================================================
-- Task 8: Interview, experience & ops (design.md SS4.6-SS4.7)
-- ============================================================================

CREATE TABLE IF NOT EXISTS interviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  card_id         uuid REFERENCES cards(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('first', 'follow_up')),
  -- VC-requested second-interview link; email delivery mocked in MVP.
  share_token     text UNIQUE,
  -- Mid-interview abandonment is itself a founder signal.
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'abandoned')),
  -- AI-disclosure guardrail timestamp.
  disclosed_at    timestamptz,
  transcript      jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Mutable table (SS5.3): status/completed_at lifecycle.
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interviews_application_id ON interviews (application_id);
CREATE INDEX IF NOT EXISTS idx_interviews_card_id ON interviews (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews (status);

CREATE TABLE IF NOT EXISTS voice_artifacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id     uuid NOT NULL REFERENCES interviews(id) ON DELETE RESTRICT,
  question_ref     text,
  -- Supabase Storage path -- a spoken original is a provenance artifact,
  -- harder to fake than pasted text.
  storage_path     text NOT NULL,
  duration_sec     int CHECK (duration_sec >= 0),
  transcript_text  text,
  created_at       timestamptz NOT NULL DEFAULT now()
  -- SS5.3 bucket 3 (mutable-rarely): no updated_at.
);

CREATE INDEX IF NOT EXISTS idx_voice_artifacts_interview_id ON voice_artifacts (interview_id);

CREATE TABLE IF NOT EXISTS memos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  version               int NOT NULL,
  -- Required-section gate (invariant #9): padding control stays a prompt
  -- concern, this only enforces the keys exist.
  sections              jsonb NOT NULL
                          CHECK (sections ?& array['snapshot', 'hypotheses', 'swot', 'problem_product', 'traction']),
  gaps                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- memo -> claim -> evidence -> raw_signal chain (Agentic Traceability).
  cited_claim_ids       uuid[] NOT NULL DEFAULT '{}',
  recommendation        text CHECK (recommendation IN ('invest', 'pass', 'watch')),
  conditions            jsonb,
  deep_dive_questions   jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- No status column by design: a memo row is immutable, regeneration = a new
  -- (application_id, version) row, current memo = highest version. Append-
  -- only (Task 9 forbid_mutation target): no updated_at.
  UNIQUE (application_id, version)
);

CREATE INDEX IF NOT EXISTS idx_memos_application_id ON memos (application_id);

CREATE TABLE IF NOT EXISTS watchlist (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id                  uuid REFERENCES founders(id) ON DELETE RESTRICT,
  company_id                  uuid REFERENCES companies(id) ON DELETE RESTRICT,
  reason                      text,
  -- Alert rule, e.g. {"metric":"gh_commit_weeks","delta":">2x","window_days":30}.
  condition                   jsonb,
  added_from_application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
  last_scored_at              timestamptz,
  next_check_at               timestamptz,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_founder_id ON watchlist (founder_id) WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchlist_company_id ON watchlist (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchlist_active ON watchlist (active) WHERE active;

CREATE TABLE IF NOT EXISTS metric_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id   uuid REFERENCES founders(id) ON DELETE RESTRICT,
  company_id   uuid REFERENCES companies(id) ON DELETE RESTRICT,
  metric       text NOT NULL REFERENCES metric_kinds(slug) ON DELETE RESTRICT,
  value        numeric NOT NULL,
  observed_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: retried sourcing workflows cannot double-insert and distort
  -- velocity. NULLS NOT DISTINCT needs PG15+ (we run 17.6).
  UNIQUE NULLS NOT DISTINCT (metric, founder_id, company_id, observed_at)
  -- SS5.3 bucket 3 (mutable-rarely): no updated_at.
);

CREATE INDEX IF NOT EXISTS idx_metric_observations_founder ON metric_observations (metric, founder_id, observed_at)
  WHERE founder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_metric_observations_company ON metric_observations (metric, company_id, observed_at)
  WHERE company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,
  -- Free text, same extensibility stance as founder_identities.kind /
  -- ai_runs.task_type -- e.g. 'founder', 'company', 'application'.
  entity_type  text,
  entity_id    uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- n8n workflow/execution id or a user identifier.
  actor        text,
  created_at   timestamptz NOT NULL DEFAULT now()
  -- Append-only (Task 9 forbid_mutation target): no updated_at.
);

-- Task 9's purge_founder queries "entity_type='founder' AND entity_id=<id>"
-- directly -- this composite index is for that lookup.
CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);

-- ============================================================================
-- Task 9: Enforcement layer (design.md SS5 items 2-4)
-- ============================================================================

-- Prerequisite: make the two self-referencing RESTRICT FKs deferrable.
--
-- A single bulk DELETE that removes both ends of a self-referencing chain at
-- once (e.g. `DELETE FROM claims WHERE id = ANY(...)` covering a claim AND
-- the claim that supersedes it) can raise a SPURIOUS 23503: Postgres checks
-- the RESTRICT trigger per physical row as it processes the statement, in an
-- unspecified order -- if it reaches the superseded (older) row before the
-- superseding (newer) one, it sees the newer row "still there" and blocks,
-- even though that row is being removed by the very same statement. This is
-- non-deterministic (depends on heap/index scan order) and purge_founder()
-- below does exactly this kind of bulk delete. DEFERRABLE INITIALLY DEFERRED
-- moves the check to COMMIT (after every row in the transaction is already
-- gone), which is a no-op behavior change for all normal application code.
--
-- Smoke-testing implication (read before adding a negative case against
-- either column): db/tests/smoke.sql's outer transaction always ROLLBACKs,
-- so a deferred violation NEVER fires inside it -- a naive
-- BEGIN...EXCEPTION sub-block testing "supersedes_claim_id / merged_into_
-- founder_id pointing at a nonexistent row -> 23503" would silently pass
-- without ever raising. To test it, call `SET CONSTRAINTS ALL IMMEDIATE;`
-- right after the offending INSERT, inside the same sub-block, before the
-- expected-failure RAISE EXCEPTION -- that forces the check to fire there
-- instead of waiting for a COMMIT this suite never performs.
ALTER TABLE claims
  ALTER CONSTRAINT claims_supersedes_claim_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE founders
  ALTER CONSTRAINT founders_merged_into_founder_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- ---- Step 1: append-only enforcement ---------------------------------------

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Purge bypass, two predicates (R1): the GUC alone is USERSET -- any
  -- session, including one holding only the anon/service_role PostgREST key,
  -- can `SET vcbrain.purging = 'on'`. The current_user check makes that
  -- attack inert: purge_founder() is SECURITY DEFINER, so its cascade runs
  -- AS the function's owner (postgres, set explicitly below) regardless of
  -- who called it -- a hostile session can forge the GUC but cannot also
  -- become current_user = 'postgres' (no ordinary session can SET ROLE to a
  -- superuser it wasn't authenticated as). Both predicates must hold.
  IF current_setting('vcbrain.purging', true) = 'on' AND current_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'append-only invariant violated: % on %.% is not permitted (id=%) -- use purge_founder() for GDPR erasure',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id);
END;
$$;

CREATE OR REPLACE TRIGGER trg_scores_forbid_mutation
  BEFORE UPDATE OR DELETE ON scores
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE TRIGGER trg_raw_signals_forbid_mutation
  BEFORE UPDATE OR DELETE ON raw_signals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE TRIGGER trg_evidence_forbid_mutation
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE TRIGGER trg_ai_runs_forbid_mutation
  BEFORE UPDATE OR DELETE ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE TRIGGER trg_events_forbid_mutation
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE TRIGGER trg_memos_forbid_mutation
  BEFORE UPDATE OR DELETE ON memos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- TRUNCATE bypass fix (QA gate Task 12 finding, fed back into Task 9 per
-- plan.md's acceptance criteria). BEFORE UPDATE OR DELETE triggers never fire
-- on TRUNCATE -- a Postgres-level fact, not a gap in forbid_mutation()'s own
-- logic -- and this database's ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- (Supabase's own self-hosted provisioning, confirmed via pg_default_acl, not
-- something this project's DDL added) grants TRUNCATE to anon/authenticated/
-- service_role on every table at CREATE TABLE time, including these six. A
-- caller running raw SQL as service_role (a future n8n "Execute Query" node,
-- a custom RPC, a leaked key used outside PostgREST -- PostgREST itself
-- exposes no TRUNCATE verb, so this was not reachable over REST) could wipe
-- an entire append-only table in one statement: no P0001, no audit trail, no
-- recovery but backups. Revoking the privilege is the correct fix -- Postgres
-- rejects the statement with 42501 before any trigger would even run.
--
-- NOT revoked from `postgres`: it owns these tables, and table owners retain
-- full privileges regardless of explicit GRANT/REVOKE (an owner-targeted
-- REVOKE would be a silent no-op). purge_founder() runs SECURITY DEFINER as
-- postgres and uses DELETE, never TRUNCATE, so this doesn't touch it.
--
-- Belt-and-suspenders BEFORE TRUNCATE trigger considered and skipped
-- (documented choice, per QA's own conclusion): the REVOKE alone is
-- sufficient for the current role set, and Postgres blocks the statement
-- before any trigger logic would fire anyway -- a statement-level trigger
-- would only add value against a role nobody currently holds, at the cost of
-- a second enforcement mechanism to keep in sync. Reconsider only if a future
-- elevated role needs blocking too.
--
-- IMPORTANT for later features: this REVOKE is per-table on purpose, NOT a
-- change to the schema-wide default privileges (those also cover SELECT/
-- INSERT/UPDATE, which anon/authenticated/service_role legitimately need for
-- normal CRUD via PostgREST -- narrowing them globally would break far more
-- than TRUNCATE). Because the default-privileges mechanism is schema-wide and
-- still active, ANY new append-only table added in a later feature is born
-- with TRUNCATE already granted to all three roles -- copy this REVOKE for
-- that table too. See db/README.md > "Append-only tables".
REVOKE TRUNCATE ON scores, raw_signals, evidence, ai_runs, events, memos
  FROM anon, authenticated, service_role;

-- ---- Step 2: updated_at on the mutable set (design.md SS5.3) --------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_founders_touch_updated_at
  BEFORE UPDATE ON founders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_companies_touch_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_cards_touch_updated_at
  BEFORE UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_claims_touch_updated_at
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_applications_touch_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_watchlist_touch_updated_at
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_interviews_touch_updated_at
  BEFORE UPDATE ON interviews
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER trg_theses_touch_updated_at
  BEFORE UPDATE ON theses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---- Step 3: purge_founder() -- the ONLY deletion door (design.md SS5.4) --

CREATE OR REPLACE FUNCTION purge_founder(p_founder_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person_ids          uuid[];  -- p_founder_id + every merged-duplicate tombstone (R3)
  v_sole_company_ids     uuid[];
  v_sole_app_ids         uuid[];
  v_sole_interview_ids   uuid[];
  v_all_card_ids         uuid[];
  v_all_claim_ids        uuid[];
BEGIN
  -- Purge bypass for this transaction only (SET LOCAL semantics via the
  -- `is_local` arg); forbid_mutation() also requires current_user = the
  -- owner set below, so a forged GUC from any other session stays inert.
  PERFORM set_config('vcbrain.purging', 'on', true);

  -- R3: same-person tombstones (merged_into_founder_id = this founder) are
  -- folded into ONE erasure, not a separate purge per duplicate -- they are
  -- the same human, so this whole call produces exactly one anonymized audit
  -- row at the end, not one per tombstone.
  SELECT array_agg(id) INTO v_person_ids
  FROM founders WHERE merged_into_founder_id = p_founder_id;
  v_person_ids := array_append(COALESCE(v_person_ids, '{}'), p_founder_id);

  -- Sole-founder companies (R2, one consistent rule) for ANY id in this
  -- person's identity set: this founder (or one of their tombstones) is the
  -- ONLY founder_company row for that company -- the company is entirely
  -- this person's data shadow (design.md SS5 item 4 rationale). Multi-founder
  -- companies keep their company-level artifacts; only this person's
  -- founder-scoped rows are removed below.
  SELECT array_agg(DISTINCT fc.company_id) INTO v_sole_company_ids
  FROM founder_company fc
  WHERE fc.founder_id = ANY (v_person_ids)
    AND NOT EXISTS (
      SELECT 1 FROM founder_company fc2
      WHERE fc2.company_id = fc.company_id AND fc2.founder_id <> ALL (v_person_ids)
    );
  v_sole_company_ids := COALESCE(v_sole_company_ids, '{}');

  SELECT array_agg(id) INTO v_sole_app_ids
  FROM applications WHERE company_id = ANY (v_sole_company_ids);
  v_sole_app_ids := COALESCE(v_sole_app_ids, '{}');

  SELECT array_agg(id) INTO v_sole_interview_ids
  FROM interviews WHERE application_id = ANY (v_sole_app_ids);
  v_sole_interview_ids := COALESCE(v_sole_interview_ids, '{}');

  -- Card sweep set: founder-subject cards for ANY person id, UNION
  -- company-linked cards from the sole-founder subtree. founder_id /
  -- company_id / application_id on cards are three independent nullable
  -- columns with no XOR -- a card can carry more than one at once, so this
  -- is OR/UNION, never an assumption that the sets are disjoint.
  SELECT array_agg(DISTINCT id) INTO v_all_card_ids
  FROM cards
  WHERE founder_id = ANY (v_person_ids)
     OR company_id = ANY (v_sole_company_ids)
     OR application_id = ANY (v_sole_app_ids);
  v_all_card_ids := COALESCE(v_all_card_ids, '{}');

  SELECT array_agg(id) INTO v_all_claim_ids
  FROM claims WHERE card_id = ANY (v_all_card_ids);
  v_all_claim_ids := COALESCE(v_all_claim_ids, '{}');

  -- Delete-order hazard (plan.md Task 9, binding): evidence.raw_signal_id can
  -- cross subtrees (founder-scoped evidence referencing a company-scoped
  -- raw_signal). Sweep ALL evidence -> claims -> cards in the ENTIRE purge
  -- set (both the founder-direct and the sole-founder-company subtrees)
  -- BEFORE deleting ANY raw_signals below.
  DELETE FROM evidence WHERE claim_id = ANY (v_all_claim_ids);
  DELETE FROM claims WHERE id = ANY (v_all_claim_ids);
  DELETE FROM cards WHERE id = ANY (v_all_card_ids);

  -- founder_company for every id in this person's identity set MUST go
  -- before the companies delete below: by construction every founder_company
  -- row for a sole-founder company belongs to this person's identity set
  -- (that is what "sole" means here), so this single statement clears every
  -- founder_company edge into v_sole_company_ids as a side effect, and also
  -- covers the founder-direct (non-sole) companies this person is linked to
  -- elsewhere -- pulled forward from the tail of this function on purpose.
  DELETE FROM founder_company WHERE founder_id = ANY (v_person_ids);

  -- Sole-founder company subtree: voice_artifacts -> interviews -> memos ->
  -- applications, scores (via those applications), then the company-scoped
  -- raw_signals/metric_observations/watchlist, then the companies row itself.
  DELETE FROM voice_artifacts WHERE interview_id = ANY (v_sole_interview_ids);
  DELETE FROM interviews WHERE id = ANY (v_sole_interview_ids);
  DELETE FROM memos WHERE application_id = ANY (v_sole_app_ids);
  DELETE FROM scores WHERE application_id = ANY (v_sole_app_ids);

  -- Application/company-scoped AI receipts: ai_runs.application_id and
  -- .company_id are ON DELETE RESTRICT, so these must go before the
  -- applications/companies deletes below. The founder_id sweep further down
  -- does not cover rows written with founder_id NULL (feature 04 onwards).
  DELETE FROM ai_runs
   WHERE application_id = ANY (v_sole_app_ids)
      OR company_id     = ANY (v_sole_company_ids);

  DELETE FROM applications WHERE id = ANY (v_sole_app_ids);
  DELETE FROM raw_signals WHERE company_id = ANY (v_sole_company_ids);
  DELETE FROM metric_observations WHERE company_id = ANY (v_sole_company_ids);
  DELETE FROM watchlist WHERE company_id = ANY (v_sole_company_ids);
  DELETE FROM companies WHERE id = ANY (v_sole_company_ids);

  -- Founder-direct rows, for every id in this person's identity set.
  DELETE FROM scores WHERE founder_id = ANY (v_person_ids);
  DELETE FROM metric_observations WHERE founder_id = ANY (v_person_ids);
  DELETE FROM raw_signals WHERE founder_id = ANY (v_person_ids);
  DELETE FROM ai_runs WHERE founder_id = ANY (v_person_ids);
  DELETE FROM watchlist WHERE founder_id = ANY (v_person_ids);

  -- Prior audit history for every id in the set -- GDPR beats audit
  -- (design.md SS5.4); the one anonymized row this function writes at the
  -- end is what survives.
  DELETE FROM events WHERE entity_type = 'founder' AND entity_id = ANY (v_person_ids);

  -- founder_identities for every id, then the tombstones (two separate
  -- statements, tombstones-first -- they reference the canonical row via
  -- merged_into_founder_id, so this ordering alone is correct without
  -- relying on the DEFERRABLE change above), then the canonical founders
  -- row itself. Hard DELETE, no tombstone of the erasure.
  DELETE FROM founder_identities WHERE founder_id = ANY (v_person_ids);
  DELETE FROM founders WHERE merged_into_founder_id = p_founder_id;
  DELETE FROM founders WHERE id = p_founder_id;

  -- Exactly one anonymized audit row survives -- no PII in the payload.
  INSERT INTO events (event_type, entity_type, entity_id, payload, actor)
  VALUES ('founder_purged', 'founder', p_founder_id, '{}'::jsonb, 'purge_founder');
END;
$$;

-- forbid_mutation()'s current_user check above is hardcoded to 'postgres' and
-- must stay in sync with this function's actual owner (SECURITY DEFINER runs
-- the cascade AS the owner) -- pin it explicitly rather than relying on
-- whichever role happened to run schema.sql.
ALTER FUNCTION purge_founder(uuid) OWNER TO postgres;

-- (Task 9 Step 4 smoke assertions appended in db/tests/smoke.sql)
