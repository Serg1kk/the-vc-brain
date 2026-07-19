// lib/f07/vocabulary.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Attribute vocabulary for feature 07 (Thesis Engine). Authoritative source:
// docs/backlog/07-thesis-engine/design.md rev.3a, §1.1. The key names here are
// identical across extractor output (§4) and `expr.field` (§1) -- nothing else
// is gateable.
//
// Self-contained CommonJS, zero imports, no npm dependencies, no top-level
// side effects, deterministic. Pasted verbatim into an n8n Code node -- n8n's
// sandbox cannot require() from the repo (no bind-mount, no
// NODE_FUNCTION_ALLOW_EXTERNAL) -- so this file carries no external state.
//
// docs/backlog/07-thesis-engine/plan.md, task B1.

'use strict';

// ============================================================================
// §1.1 -- attribute keys and closed value sets
// ============================================================================

const SECTOR_VALUES = Object.freeze([
  'b2b-software', 'ai-infra', 'devtools', 'fintech', 'healthtech',
  'consumer', 'marketplace', 'gambling', 'adtech', 'other',
]);

const BUSINESS_MODEL_VALUES = Object.freeze([
  'b2b', 'b2c', 'b2b2c', 'marketplace', 'open_source', 'unknown',
]);

const GEOGRAPHY_REGION_VALUES = Object.freeze(['EU', 'US', 'UK', 'APAC', 'LATAM', 'MEA', 'other']);

const STAGE_VALUES = Object.freeze(['pre_seed', 'seed']);

const STAGE_EVIDENCE_VALUES = Object.freeze(['idea', 'prototype', 'early_revenue', 'scaling']);

// The full attribute table (§1.1). `type` distinguishes closed-vocabulary
// categorical fields from free `text` fields for `contains`'s type dispatch
// (rules.js) -- `derived` fields are never present directly in extractor
// output; they are computed from a base field at evaluation time (below).
// `gateable: false` documents §1.1's "not gateable" note for `what_is_built`;
// nothing in this module enforces it (rules.js does not special-case it
// either -- an absent attribute already yields `unknown` under D-03, which is
// the only protection the design specifies).
const ATTRIBUTES = Object.freeze({
  sector: Object.freeze({ type: 'categorical', values: SECTOR_VALUES, gateable: true }),
  business_model: Object.freeze({ type: 'categorical', values: BUSINESS_MODEL_VALUES, gateable: true }),
  geography_country: Object.freeze({ type: 'categorical', values: null, gateable: true }), // ISO-3166-1 alpha-2, open-ended
  geography_region: Object.freeze({ type: 'derived', values: GEOGRAPHY_REGION_VALUES, gateable: true }),
  stage: Object.freeze({ type: 'derived', values: STAGE_VALUES, gateable: true }),
  stage_evidence: Object.freeze({ type: 'categorical', values: STAGE_EVIDENCE_VALUES, gateable: true }),
  what_is_built: Object.freeze({ type: 'text', values: null, gateable: false }),
  _text: Object.freeze({ type: 'text', values: null, gateable: true }),
});

// ============================================================================
// region_of(country) -- ISO-3166-1 alpha-2 -> EU | US | UK | APAC | LATAM |
// MEA | other. §1.1: "`region_of(country)`, applied before evaluation."
//
// Returns `null` (not 'other') for anything that isn't a well-formed 2-letter
// code -- absent/invalid input means "we don't know the region", which is a
// different thing from 'other' ("we know the country, it just isn't in any
// named block"). Only the latter is a legal `geography_region` value; the
// former must resolve to `unknown` in rules.js, never to a literal 'other'.
// ============================================================================

// The 27 EU member states (post-Brexit; GB is deliberately excluded -- it is
// its own region, below).
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

// Starter set, not exhaustive -- populated well enough for the demo cohort
// (§7's mandate is "EU+US"); MEA/APAC/LATAM breadth can grow post-MVP without
// touching this function's contract.
const APAC_COUNTRIES = new Set([
  'CN', 'JP', 'KR', 'IN', 'SG', 'AU', 'NZ', 'HK', 'TW',
  'ID', 'MY', 'PH', 'TH', 'VN', 'PK', 'BD',
]);

const LATAM_COUNTRIES = new Set([
  'BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'UY', 'EC', 'VE', 'BO', 'PY', 'CR', 'PA', 'GT', 'DO',
]);

const MEA_COUNTRIES = new Set([
  'AE', 'SA', 'IL', 'EG', 'ZA', 'NG', 'KE', 'QA', 'TR',
  'MA', 'GH', 'TN', 'JO', 'KW', 'BH', 'OM', 'LB',
]);

function region_of(country) {
  if (typeof country !== 'string') return null;
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;

  if (code === 'US') return 'US';
  if (code === 'GB') return 'UK';
  if (EU_COUNTRIES.has(code)) return 'EU';
  if (APAC_COUNTRIES.has(code)) return 'APAC';
  if (LATAM_COUNTRIES.has(code)) return 'LATAM';
  if (MEA_COUNTRIES.has(code)) return 'MEA';
  return 'other'; // a known, well-formed code, just outside every named block
}

// ============================================================================
// stage_evidence -> stage (§1.1): `idea | prototype -> pre_seed`;
// `early_revenue -> seed`; `scaling` deliberately has NO mapping -- it must
// yield `unknown` on stage rules, never a rejection.
// ============================================================================

const STAGE_BY_EVIDENCE = Object.freeze({
  idea: 'pre_seed',
  prototype: 'pre_seed',
  early_revenue: 'seed',
  // scaling: intentionally absent.
});

function stage_of(stageEvidence) {
  if (typeof stageEvidence !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(STAGE_BY_EVIDENCE, stageEvidence)
    ? STAGE_BY_EVIDENCE[stageEvidence]
    : null;
}

// ============================================================================
// Sentinel values -- live defect found by stage-C (the extractor's own JSON
// schema comment on `business_model` names this exact trap): `'unknown'` is a
// LEGAL value in business_model's closed set (§1.1), but compared as a VALUE
// against a rule's expr it reads as a real, negative observation ('missed'),
// which is exactly the REQ-003 shape D-03 exists to prevent -- the model
// could not tell the business model, and that absence of information must
// not lower fit. `resolveField` (rules.js) treats a sentinel-valued field
// identically to an absent one: `unknown`, contributing to `total` but never
// to `earned`.
//
// This is a DIFFERENT mechanism from `scaling`'s "no stage mapping" above,
// even though both end up `unknown`: `scaling` is a real, legal, gateable
// value of `stage_evidence` itself (a rule written directly against
// `stage_evidence` sees it and evaluates normally) that simply has no
// corresponding `stage` -- the derived field is what goes unknown, not the
// base one. A sentinel is unknown AT THE FIELD ITSELF, for any rule that
// references it directly. Keep the two mechanisms conceptually separate --
// they are next to each other here because both protect the same guarantee,
// not because they work the same way.
//
// `sector: 'other'` is deliberately NOT a sentinel (the extractor's schema
// comment is explicit about this too): 'other' is a real determination that
// carries a quote -- the company genuinely is not in the mandate's sectors --
// and must produce `no_match` against a focus rule, same as any other named
// sector. Conflating `other` with a sentinel would let a thin deck auto-pass
// every sector rule as `unknown`; keep this distinction sharp.
const SENTINEL_VALUES = Object.freeze({
  business_model: Object.freeze(['unknown']),
});

function isSentinel(field, value) {
  const sentinels = SENTINEL_VALUES[field];
  return Array.isArray(sentinels) && sentinels.includes(value);
}

// ============================================================================
// `_text` synthesis (§1.1: "synthetic -- the concatenated gate input.
// Present whenever the gate has any text.").
//
// `_text` IS the workflow's `gate_text` parameter, verbatim (thesis-
// attribute-extractor-agent-input-spec.md §"Input variables": "Also the
// value of `_text` in §1.1"). On re-evaluation (`f07-thesis-reevaluate`,
// §6.1 -- no fresh gate call, no `gate_text` parameter at all), the same raw
// text is recovered from the ORIGINAL run's `raw_signals.payload.text`
// (db/fixtures/07-thesis-engine.sql, "team-lead correction, 2026-07-19":
// "`_text` must resolve from THIS stored payload -- NOT from
// company.what_is_built or any other claim"). An earlier draft of this
// function also folded in `what_is_built` as a fallback -- that reading
// matched a STALE top-of-file comment in the same fixture file that the
// later, dated, inline correction supersedes. Do not resurrect the
// what_is_built fallback; a claim is not the gate's raw input, and `_text`
// is defined as exactly that input, nothing derived from it.
//
// Consequently this function takes exactly one text source: whichever raw
// text the caller has in hand for THIS call (a fresh `gate_text` parameter,
// or a re-evaluation's recovered `raw_signals.payload.text`). When neither
// exists, `_text` is genuinely absent -- honest per D-03 (unknown, not
// invented from claims).
function synthesize_text(gateText) {
  if (typeof gateText !== 'string') return null;
  const trimmed = gateText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = {
  ATTRIBUTES,
  SECTOR_VALUES,
  BUSINESS_MODEL_VALUES,
  GEOGRAPHY_REGION_VALUES,
  STAGE_VALUES,
  STAGE_EVIDENCE_VALUES,
  STAGE_BY_EVIDENCE,
  SENTINEL_VALUES,
  region_of,
  stage_of,
  isSentinel,
  synthesize_text,
};
