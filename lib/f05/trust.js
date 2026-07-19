// SOURCE OF TRUTH: lib/f05/trust.js
//
// Application-level Trust rollup math for feature 05 (Truth-Gap Check & Trust
// Score) -- docs/backlog/05-truth-gap-trust/plan.md task B1, design.md SS7-SS8.
// Pure functions only -- NO imports, NO requires, no I/O, no network, no
// Date.now()/Math.random(), no top-level side effects. This file's body is
// pasted verbatim into an n8n Code node with the header above (design.md
// SS11, plan.md's zero-imports rule for every Code-node-bound module): n8n's
// Code-node sandbox has no bind-mount of this repo and cannot `require()`
// from it.
//
// This module does NOT compute per-claim trust (that is the `claim_trust` SQL
// view, design SS7 -- built by a different terminal, concurrently, off the
// frozen column contract this file also reads). It only implements SS8: which
// claims belong to an application (SS8.1) and how their already-computed
// per-claim numbers roll up into one `scores(axis='trust')` row or one
// `trust_rollup_insufficient_evidence` event (SS8.2).
//
// ============================================================================
// Input claim-row contract this module expects
// ============================================================================
//
// design.md never spells out claim_trust's literal column list -- SS7.1-SS7.5
// describe the QUANTITIES the view computes, not a CREATE VIEW column order.
// The field names below are this module's own naming, chosen to match
// design.md's own formula variable names wherever one is given (`class`,
// `derived_status`, `trust`, `independence_factor`); flagged back to the team
// as an assumption a builder wiring the real query should confirm against.
//
//   {
//     claim_id:             uuid,    // claims.id
//     topic:                 string,  // claims.topic
//     class:                 'factual_static' | 'factual_dynamic' | 'qualitative' |
//                            'forecast' | 'unverifiable' | 'precomputed',
//                            // the router class materialised into the view
//                            // (SS7.1); named `class` to match the router
//                            // table's own key (SS4.1's prefix_map entries
//                            // are `{prefix, class, check}`).
//     derived_status:        'verified' | 'contradicted' | 'partially_supported' |
//                            'unverified' | 'missing',   // claim_trust.derived_status (SS7.4)
//     trust:                 number 0..1 | null,   // per-claim trust (SS7.2's own `trust`)
//     independence_factor:   number 0..1 | null,   // SS7.2/SS7.3, same name
//     n_supports:            integer,   // count of `supports` evidence rows on this
//                            // claim -- this module's own naming, SS8.2 does
//                            // not name a variable for it.
//     n_contradicts:         integer,   // count of `contradicts` evidence rows
//     card_application_id:   uuid | null,   // cards.application_id for this claim's card
//     card_company_id:       uuid | null,   // cards.company_id
//     card_founder_id:       uuid | null,   // cards.founder_id
//   }
//
// `ctx` shape (design SS8.1):
//   {
//     applicationId:  uuid,     // the application being rolled up
//     companyId:      uuid,     // applications.company_id for applicationId
//     founderIds:     uuid[],   // founder_company.founder_id for companyId --
//                               // route 3's join, resolved by the caller with
//                               // a single-table lookup, not re-derived here
//     runId:          uuid?,    // optional; echoed into the insufficient-
//                               // evidence event payload if provided
//   }
//
// `config` shape (SS7.5 / SS8.2 -- the `score_formulas('trust_v1','trust')`
// row, LEFT JOIN + literal fallback, same failure-mode discipline as the
// view's own SS7.5 fallback -- never a second hardcoded copy of the whole
// row, only the one constant this rollup itself needs):
//   { version: 'trust_v1', min_coverage: 0.25 }

'use strict';

// ----------------------------------------------------------------------------
// Small shared helpers (independent copies -- no shared import across lib/f05
// modules by design; see lib/f03/scoring.js and lib/f04/scoring.js for the
// identical precedent in this repo).
// ----------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Rounds to 2dp -- matches `scores.value numeric(5,2)` / `scores.confidence
// numeric(3,2)` (same rounding discipline as lib/f03/scoring.js's round2:
// a float-computed 100.005 would otherwise be rejected by the numeric column).
function round2(value) {
  return Number(value.toFixed(2));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Coerces a possibly-null/undefined per-claim number to 0 for summation --
// an absent trust/independence_factor on a claim the caller says is
// "assessed" is defensive-only (the view's own contract, SS7.2, always
// produces a number once a claim carries any evidence); this module does not
// re-validate that contract, only refuses to let a bad value corrupt a sum.
function numOr0(value) {
  return isFiniteNumber(value) ? value : 0;
}

// SS4, SS8.2 -- the six router classes partition into exactly these two sets.
// `precomputed` counts as verdict-eligible (SS8.2, SS4 table's "n/a" row,
// named explicitly so a builder does not go looking for a fifth branch).
const VERDICT_ELIGIBLE_CLASSES = new Set(['factual_static', 'factual_dynamic', 'precomputed']);
const NOT_ASSESSABLE_CLASSES = new Set(['qualitative', 'forecast', 'unverifiable']);

// SS8.2: "min_coverage starts at 0.25 (matching 03) but must be re-derived
// against live data before being locked" -- the literal fallback this module
// falls back to when `config.min_coverage` is absent, per this task's
// instruction to take constants from the passed config with literal
// fallbacks rather than hardcoding a second copy of the config row.
const DEFAULT_MIN_COVERAGE = 0.25;

const DEFAULT_FORMULA_VERSION = 'trust_v1';

// ----------------------------------------------------------------------------
// SS8.1 -- scope: which claims belong to an application
// ----------------------------------------------------------------------------
//
// design.md phrases SS8.1 as a SQL WHERE clause (three OR'd routes over
// `claims c JOIN cards k ON k.id = c.card_id`). This module implements the
// identical rule as a pure JS predicate over pre-joined rows, per this task's
// "pure functions, no DB access" constraint -- a production caller may
// additionally run the SQL directly for efficiency (fetching fewer rows over
// the wire), but THIS predicate is what the acceptance tests exercise and is
// the authoritative expression of the SS8.1 rule for anything that calls into
// this module.
//
// Route 1: the card is directly tagged with this application.
// Route 2: the card is tagged with the application's own company (company
//          cards, e.g. `company.*` claims, are not attached to any specific
//          application row).
// Route 3: the card belongs to a founder on this application's company --
//          RESTRICTED to that founder's person-scoped claims (card_company_id
//          IS NULL) or claims already scoped to this same company. Without
//          this restriction a founder's OTHER startup's claims would leak in
//          (SS8.1's load-bearing warning) -- feature 03's premise is that a
//          founder persists across companies, so an unrestricted founder join
//          is exactly the leak this route must not create.
function isClaimInScope(row, ctx) {
  if (row.card_application_id != null && row.card_application_id === ctx.applicationId) return true;
  if (row.card_company_id != null && row.card_company_id === ctx.companyId) return true;

  const founderIds = Array.isArray(ctx.founderIds) ? ctx.founderIds : [];
  if (row.card_founder_id != null && founderIds.includes(row.card_founder_id)) {
    if (row.card_company_id == null || row.card_company_id === ctx.companyId) return true;
  }

  return false;
}

function scopeClaimsToApplication(rows, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => isClaimInScope(row, ctx));
}

// ----------------------------------------------------------------------------
// SS8.2 -- missing_flags
// ----------------------------------------------------------------------------
//
// "missing_flags = [ VERDICT-ELIGIBLE topics with derived_status missing or
// unverified ] + { not_assessable_count: <count of qualitative/forecast/
// unverifiable claims> }". The gap list is scoped to VERDICT-ELIGIBLE claims
// only and deduplicated by topic (not one entry per claim) -- SS8.2's own
// warning: "Without that scoping it would sweep in every qualitative claim...
// producing a ~430-entry missing_flags array on every application... The
// count of not-assessable claims is honest; the LIST of them is noise."
// Deduplicating by topic keeps the gap list bounded by the ~49 distinct
// topics in the router table (SS4.1), never by claim count.
//
// `coverage` also lives here (team-lead ruling, 2026-07-19, on this task's
// own flag): `scores` has no `coverage` column, but SS14.1 makes coverage a
// DISPLAY requirement -- "wherever the rollup value appears, coverage must
// appear beside it". The `scores` row is a snapshot while `claim_trust` is
// live, so a consumer recomputing coverage from the view later would drift
// from the value it sits next to. Persisting it inside `missing_flags` keeps
// value/confidence/coverage as one atomic, non-drifting snapshot. Optional
// second argument so this function stays independently callable (e.g. in a
// test) without first computing a rollup-level coverage number.
function buildMissingFlags(scopedRows, coverage) {
  const gapTopics = new Set();
  let notAssessableCount = 0;

  for (const row of scopedRows) {
    if (VERDICT_ELIGIBLE_CLASSES.has(row.class)) {
      if ((row.derived_status === 'missing' || row.derived_status === 'unverified') && row.topic) {
        gapTopics.add(row.topic);
      }
    } else if (NOT_ASSESSABLE_CLASSES.has(row.class)) {
      notAssessableCount += 1;
    }
  }

  return {
    topics: Array.from(gapTopics),
    not_assessable_count: notAssessableCount,
    coverage: isFiniteNumber(coverage) ? round2(coverage) : null,
  };
}

// ----------------------------------------------------------------------------
// SS8.2 -- the rollup itself
// ----------------------------------------------------------------------------
//
// computeTrustRollup(rows, config, ctx) -> {
//   status: 'scored' | 'insufficient_evidence',
//   coverage, verdictEligibleCount, assessedCount, missingFlags,  // always present, for logging/diagnostics
//   scoresRow: {...} | null,   // the ready-to-insert `scores` row, only on 'scored'
//   event: {...} | null,       // the `trust_rollup_insufficient_evidence` event, only on 'insufficient_evidence'
// }
//
// `rows` -- the FULL unscoped candidate set (every claim reachable by any of
//   SS8.1's three routes before the company_id restriction is applied); this
//   function does the scoping itself (calls scopeClaimsToApplication), so a
//   caller may pass a superset and rely on this module for the restriction --
//   this is what acceptance criterion 5 (a same-founder, different-company
//   claim must be excluded) exercises directly.
// `config` -- { version, min_coverage } from the active `score_formulas`
//   row for axis='trust', with literal fallbacks applied here when either is
//   absent (SS7.5's failure-mode discipline, restated for this rollup's own
//   one constant).
// `ctx` -- { applicationId, companyId, founderIds, runId? }, see the file
//   header for the full shape.
function computeTrustRollup(rows, config, ctx) {
  const cfg = config || {};
  const minCoverage = isFiniteNumber(cfg.min_coverage) ? cfg.min_coverage : DEFAULT_MIN_COVERAGE;
  const formulaVersion = cfg.version || DEFAULT_FORMULA_VERSION;

  const inScope = scopeClaimsToApplication(rows, ctx);

  // verdict_eligible = claims whose router class in {factual_static,
  // factual_dynamic, precomputed} -- SS8.2's denominator, NOT all in-scope claims.
  const verdictEligible = inScope.filter((row) => VERDICT_ELIGIBLE_CLASSES.has(row.class));

  // assessed = verdict-eligible claims carrying >=1 supports OR contradicts row.
  const assessed = verdictEligible.filter((row) => numOr0(row.n_supports) + numOr0(row.n_contradicts) >= 1);

  // coverage = assessed / verdict_eligible -- SS8.2, explicitly NOT / all
  // in-scope claims (qualitative/forecast/unverifiable claims can never carry
  // supports/contradicts by design, SS4.3/SS7.1, so counting them would make
  // coverage structurally low for reasons that are not knowledge gaps).
  const coverage = verdictEligible.length > 0 ? assessed.length / verdictEligible.length : 0;

  const missingFlags = buildMissingFlags(inScope, coverage);

  // ---- guard FIRST, before any division by assessed.length (SS8.2/SS2.3 pattern) ----
  if (assessed.length === 0 || coverage < minCoverage) {
    const event = {
      event_type: 'trust_rollup_insufficient_evidence',
      entity_type: 'application',
      entity_id: ctx.applicationId,
      payload: Object.assign(
        {
          application_id: ctx.applicationId,
          coverage: round2(coverage),
          min_coverage: minCoverage,
          verdict_eligible_count: verdictEligible.length,
          assessed_count: assessed.length,
          missing_flags: missingFlags,
        },
        ctx.runId ? { run_id: ctx.runId } : {}
      ),
    };

    return {
      status: 'insufficient_evidence',
      coverage,
      verdictEligibleCount: verdictEligible.length,
      assessedCount: assessed.length,
      missingFlags,
      scoresRow: null,
      event,
    };
  }

  // value = 100 x mean(trust) over ASSESSED claims only -- SS8.2: "gaps never
  // drag the value down". A gap (unassessed, verdict-eligible) claim never
  // enters this mean at all -- REQ-003's core invariant, enforced structurally
  // by the denominator being `assessed.length`, not `verdictEligible.length`.
  let trustSum = 0;
  for (const row of assessed) trustSum += numOr0(row.trust);
  const value = clamp(round2((trustSum / assessed.length) * 100), 0, 100);

  // confidence = clamp(coverage x mean(independence_factor over assessed), 0, 1).
  // `coverage` is what a gap actually lowers here -- adding unassessed
  // verdict-eligible claims shrinks this ratio without touching `value` above.
  let independenceSum = 0;
  for (const row of assessed) independenceSum += numOr0(row.independence_factor);
  const meanIndependence = independenceSum / assessed.length;
  const confidence = clamp(round2(coverage * meanIndependence), 0, 1);

  const scoresRow = {
    axis: 'trust',
    application_id: ctx.applicationId,
    founder_id: null,
    value,
    confidence,
    missing_flags: missingFlags,
    input_claim_ids: assessed.map((row) => row.claim_id),
    formula_version: formulaVersion,
    model: null, // SS8.2: "model NULL on the deterministic path" -- no LLM in this rollup (SS6.0b)
  };

  return {
    status: 'scored',
    coverage,
    verdictEligibleCount: verdictEligible.length,
    assessedCount: assessed.length,
    missingFlags,
    scoresRow,
    event: null,
  };
}

module.exports = {
  VERDICT_ELIGIBLE_CLASSES,
  NOT_ASSESSABLE_CLASSES,
  DEFAULT_MIN_COVERAGE,
  DEFAULT_FORMULA_VERSION,
  clamp,
  round2,
  isClaimInScope,
  scopeClaimsToApplication,
  buildMissingFlags,
  computeTrustRollup,
};
