// lib/f07/rules.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Deterministic rule evaluator for feature 07 (Thesis Engine). Pure functions
// only -- no I/O, no database, no network. This is the module design.md calls
// "the backend evaluates the thesis's rules against those attributes in code"
// (D-02): a cheap LLM extracts attributes with no thesis in its context (§4,
// built separately in docs/backlog/07-thesis-engine/agents/), and everything
// past that point -- mandate compilation, three-valued rule evaluation, fit,
// coverage, the verdict procedure -- is deterministic and lives here, unit
// tested before it is pasted verbatim into an n8n Code node.
//
// Authoritative source for every rule below: docs/backlog/07-thesis-engine/
// design.md rev.3a, sections cited inline. This file does not restate the
// `theses.config` contract -- see design.md §1 for the shape it consumes.
//
// docs/backlog/07-thesis-engine/plan.md, task B2.

'use strict';

const vocabulary = require('./vocabulary');

// ============================================================================
// Small shared helpers
// ============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function numOr(value, fallback) {
  return isFiniteNumber(value) ? value : fallback;
}

function clamp(min, max, value) {
  return Math.min(max, Math.max(min, value));
}

// ============================================================================
// §1.2 -- mandate -> rule compilation (normative table)
//
// Lazy, at evaluation time. All compiled rules are `soft` by construction --
// a sector or geography mismatch is neither a legal constraint nor fraud, so
// compiling them `hard` would contradict D-01. Each row is emitted ONLY when
// its source array is non-empty (rev.2 compiled keyword rules unconditionally
// and an empty `positive_keywords` produced a permanently-`missed` rule that
// silently depressed every fit -- §1.2's own worked defect).
//
// `check_size_usd`, `ownership_target_pct`, `risk_appetite` and `geos`
// compile to nothing (§1.3: inert at pre-seed, or -- for `geos` -- consumed
// by feature 04, not by the gate).
//
// Rule ids for the geography/stage rows are not spelled out in §1.2's table
// (only "same shape, field: ..."); `M_geography` / `M_stage` are this file's
// choice, parallel to the table's own `M_sector` / `M_poskw` / `M_negkw`.
// ============================================================================

function compileMandateRules(config) {
  const cfg = isPlainObject(config) ? config : {};
  const mandate = isPlainObject(cfg.mandate) ? cfg.mandate : {};
  const fit = isPlainObject(cfg.fit) ? cfg.fit : {};
  const mandateWeight = numOr(fit.mandate_weight, 0);
  const compiled = [];

  if (Array.isArray(mandate.sectors) && mandate.sectors.length > 0) {
    compiled.push({
      id: 'M_sector', label: 'Mandate: sector', kind: 'focus', enforcement: 'soft',
      weight: mandateWeight, enabled: true,
      expr: { field: 'sector', op: 'in', value: mandate.sectors },
    });
  }

  if (Array.isArray(mandate.geographies) && mandate.geographies.length > 0) {
    compiled.push({
      id: 'M_geography', label: 'Mandate: geography', kind: 'focus', enforcement: 'soft',
      weight: mandateWeight, enabled: true,
      expr: { field: 'geography_region', op: 'in', value: mandate.geographies },
    });
  }

  if (Array.isArray(mandate.stages) && mandate.stages.length > 0) {
    compiled.push({
      id: 'M_stage', label: 'Mandate: stage', kind: 'focus', enforcement: 'soft',
      weight: mandateWeight, enabled: true,
      expr: { field: 'stage', op: 'in', value: mandate.stages },
    });
  }

  const positiveKeywords = cfg.positive_keywords;
  if (Array.isArray(positiveKeywords) && positiveKeywords.length > 0) {
    compiled.push({
      id: 'M_poskw', label: 'Mandate: positive keywords', kind: 'focus', enforcement: 'soft',
      weight: mandateWeight, enabled: true,
      expr: { field: '_text', op: 'contains', value: positiveKeywords },
    });
  }

  // `deal_breaker` weight is always 0 (D-04; enforced live by
  // validate_thesis_config() in §5.6) -- not `mandateWeight`.
  const negativeKeywords = cfg.negative_keywords;
  if (Array.isArray(negativeKeywords) && negativeKeywords.length > 0) {
    compiled.push({
      id: 'M_negkw', label: 'Mandate: negative keywords', kind: 'deal_breaker', enforcement: 'soft',
      weight: 0, enabled: true,
      expr: { field: '_text', op: 'contains', value: negativeKeywords },
    });
  }

  return compiled;
}

// Hand-authored `config.rules[]`, normalized (D-01: `enforcement` defaults to
// `soft` when absent; `enabled` defaults to true when absent), concatenated
// with the compiled mandate rules. Order is hand-authored first, mandate
// rules appended -- fired_rules[] display order only, nothing depends on it.
function normalizeHandAuthoredRule(rule) {
  return {
    ...rule,
    enabled: rule.enabled !== false,
    enforcement: rule.enforcement === 'hard' ? 'hard' : 'soft',
  };
}

function compileRules(config) {
  const cfg = isPlainObject(config) ? config : {};
  const handAuthored = Array.isArray(cfg.rules)
    ? cfg.rules.filter(isPlainObject).map(normalizeHandAuthoredRule)
    : [];
  return handAuthored.concat(compileMandateRules(cfg));
}

// ============================================================================
// Field resolution -- base fields read straight from `attributes`; derived
// fields (`geography_region`, `stage`, §1.1) computed from their base field.
// `missingFields` carries BOTH genuinely-absent fields and fields backed only
// by a claim with verification_status='contradicted' (D-03: folding a
// contradicted claim's field into this array is the CALLER's job -- this
// module has no DB access and cannot resolve claims itself).
//
// Returns `{ value, unknown }`. `unknown: true` is the single condition
// evalExpr needs to short-circuit a rule to `unknown` under D-03.
// ============================================================================

function resolveField(field, attributes, missingFields) {
  const attrs = isPlainObject(attributes) ? attributes : {};
  const missing = Array.isArray(missingFields) ? missingFields : [];
  const isMissing = (key) => missing.includes(key);

  // geography_region and stage are `derived` (§1.1: "region_of(country),
  // applied before evaluation"). The extractor never emits either one
  // directly (thesis-attribute-extractor-agent-json-schema.json forbids it),
  // so the normal path is deriving from the base field below. A caller that
  // has ALREADY applied the derivation (§1.1's own phrasing -- "applied
  // BEFORE evaluation" -- reads naturally as a pre-processing step the
  // caller may perform itself) may instead supply `geography_region`/`stage`
  // directly in `attributes`; when present and not itself listed missing,
  // that value wins over re-deriving from the base field, so the two
  // calling conventions agree rather than silently disagreeing.
  if (field === 'geography_region') {
    if (isMissing('geography_region')) return { value: null, unknown: true };
    if (Object.prototype.hasOwnProperty.call(attrs, 'geography_region') && attrs.geography_region !== undefined) {
      const direct = attrs.geography_region;
      if (direct === null) return { value: null, unknown: true };
      return { value: direct, unknown: false };
    }
    if (isMissing('geography_country')) return { value: null, unknown: true };
    const country = attrs.geography_country;
    if (country === null || country === undefined) return { value: null, unknown: true };
    const region = vocabulary.region_of(country);
    if (region === null) return { value: null, unknown: true }; // not a well-formed code
    return { value: region, unknown: false };
  }

  if (field === 'stage') {
    if (isMissing('stage')) return { value: null, unknown: true };
    if (Object.prototype.hasOwnProperty.call(attrs, 'stage') && attrs.stage !== undefined) {
      const direct = attrs.stage;
      if (direct === null) return { value: null, unknown: true };
      return { value: direct, unknown: false };
    }
    if (isMissing('stage_evidence')) return { value: null, unknown: true };
    const evidence = attrs.stage_evidence;
    if (evidence === null || evidence === undefined) return { value: null, unknown: true };
    const stage = vocabulary.stage_of(evidence);
    // `scaling` maps to nothing (vocabulary.js §1.1) -- unknown here, never a
    // rejection, exactly per this task's acceptance criterion.
    if (stage === null) return { value: null, unknown: true };
    return { value: stage, unknown: false };
  }

  if (isMissing(field)) return { value: null, unknown: true };
  const value = attrs[field];
  if (value === null || value === undefined) return { value: null, unknown: true };
  // A sentinel value (vocabulary.js: currently only business_model:'unknown')
  // means "the extractor could not tell", not a real observation -- treat it
  // exactly like an absent field. `sector:'other'` is deliberately NOT a
  // sentinel and falls through to the normal known-value return below.
  if (vocabulary.isSentinel(field, value)) return { value: null, unknown: true };
  return { value, unknown: false };
}

// `contains`'s type dispatch (§1.1): on a text field with an array operand,
// substring-match-on-any-element (OR); on a text field with a string
// operand, substring match; on a multi-valued field (none currently declared
// in the vocabulary, but the semantics are defined for one), array
// membership. The empty-array-operand -> `unknown` case is handled by the
// caller (evalExpr), before the field is even resolved -- it is a property
// of the rule, not of the data.
function evalContains(fieldValue, operand) {
  if (Array.isArray(fieldValue)) {
    if (Array.isArray(operand)) return operand.some((v) => fieldValue.includes(v));
    return fieldValue.includes(operand);
  }
  if (typeof fieldValue === 'string') {
    if (Array.isArray(operand)) {
      return operand.some((v) => typeof v === 'string' && fieldValue.includes(v));
    }
    if (typeof operand === 'string') return fieldValue.includes(operand);
  }
  return false;
}

// ============================================================================
// D-03 -- three-valued rule evaluation: 'match' | 'no_match' | 'unknown'.
// A rule is `unknown` whenever any field its expr references is absent, null,
// in `missingFields`, or (folded into `missingFields` by the caller) backed
// only by a contradicted claim.
// ============================================================================

function evalExpr(expr, attributes, missingFields) {
  if (!isPlainObject(expr)) throw new Error('rules.js: evalExpr requires an expr object');
  const { field, op, negate } = expr;
  const operand = expr.value;

  // An empty array operand on `contains` expresses no opinion and must not
  // be readable as a miss (§1.1) -- checked before field resolution, since
  // it is a property of the RULE regardless of what was extracted.
  if (op === 'contains' && Array.isArray(operand) && operand.length === 0) {
    return 'unknown';
  }

  const resolved = resolveField(field, attributes, missingFields);
  if (resolved.unknown) return 'unknown';

  const { value } = resolved;
  let matched;

  switch (op) {
    case 'eq':
      matched = value === operand;
      break;
    case 'in':
      matched = Array.isArray(operand) && operand.includes(value);
      break;
    case 'gte':
      matched = isFiniteNumber(value) && isFiniteNumber(operand) && value >= operand;
      break;
    case 'lte':
      matched = isFiniteNumber(value) && isFiniteNumber(operand) && value <= operand;
      break;
    case 'exists':
      // Reached only when the field resolved to a known value (the unknown
      // branch above already returned) -- so a known field always satisfies
      // "exists". `negate: true` therefore reads as "field is absent", which
      // -- consistently with D-03 -- can never be observed as a `no_match`:
      // an absent field is `unknown`, not a confirmed absence.
      matched = true;
      break;
    case 'contains':
      matched = evalContains(value, operand);
      break;
    default:
      throw new Error(`rules.js: unsupported op "${op}"`);
  }

  if (negate === true) matched = !matched;
  return matched ? 'match' : 'no_match';
}

// ============================================================================
// D-04 -- outcome vocabulary, derived from (kind, expr result). One table,
// no parallel truth table to drift out of sync with it.
// ============================================================================

function deriveOutcome(kind, exprResult) {
  if (exprResult === 'unknown') return 'unknown';
  if (kind === 'deal_breaker') return exprResult === 'match' ? 'triggered' : 'satisfied';
  return exprResult === 'match' ? 'satisfied' : 'missed'; // must_have | focus
}

// ============================================================================
// §2 -- ordered verdict procedure. First match wins.
//
//   1.  any rule outcome=triggered|missed, enforcement=hard        -> failed
//   2.  coverage < fit.min_coverage                (full mode only) -> insufficient_evidence
//   2b. any soft deal_breaker with outcome=triggered                -> borderline
//   3.  fit >= fit.strong_threshold                 (full mode only) -> passed
//   4.  otherwise                                                    -> borderline
//
// Step 3's "(full mode only)" gate is not written into §2's own table (only
// step 2 carries that annotation there) -- it is stated in §6.1's prose
// instead ("Keyword mode never returns passed... a cheap negative filter,
// not an endorsement"). Both are honored here: keyword mode can still reach
// `failed` (a hard rule fired on `_text`/structured_hints) or `borderline`,
// never `insufficient_evidence` (no coverage to be short of) and never
// `passed`.
// ============================================================================

function computeVerdict({ firedRules, fit, coverage, minCoverage, strongThreshold, mode }) {
  const rules = Array.isArray(firedRules) ? firedRules : [];
  const evalMode = mode === 'keyword' ? 'keyword' : 'full';

  const hardFailure = rules.some(
    (r) => r.enforcement === 'hard' && (r.outcome === 'triggered' || r.outcome === 'missed')
  );
  if (hardFailure) return 'failed';

  if (evalMode === 'full' && coverage !== null && coverage < minCoverage) return 'insufficient_evidence';

  const softDealBreakerTriggered = rules.some(
    (r) => r.kind === 'deal_breaker' && r.enforcement === 'soft' && r.outcome === 'triggered'
  );
  if (softDealBreakerTriggered) return 'borderline';

  if (evalMode === 'full' && fit >= strongThreshold) return 'passed';

  return 'borderline';
}

// ============================================================================
// §3.1 / §3.2 -- fit and coverage, plus §2's verdict, combined into a single
// evaluation pass over a compiled thesis. This is the module's one entry
// point; everything above is exported mainly so it can be unit tested in
// isolation.
//
//   total    = Σ weight(enabled must_have + focus rules)          -- incl. unknown
//   earned   = Σ weight(enabled must_have + focus rules, outcome=satisfied)
//   penalty  = fit.soft_deal_breaker_penalty × count(enabled soft deal_breakers, outcome=triggered)
//   fit      = total > 0 ? clamp(100 × earned / total − penalty, 0, 100) : fit.base
//   evaluated = Σ weight(enabled must_have + focus rules, outcome != unknown)
//   coverage  = mode='keyword' ? null : (total > 0 ? evaluated / total : 1.0)
//
// `deal_breaker` weight never enters `total`/`earned`/`evaluated` (D-04);
// disabled rules (`enabled: false`) are excluded from evaluation entirely --
// dropping a disabled rule from BOTH sides is what keeps `evaluated <= total`
// and therefore `coverage` at or below 1 (§3.2).
// ============================================================================

function evaluateThesis({ config, attributes, missingFields, mode } = {}) {
  const cfg = isPlainObject(config) ? config : {};
  const attrs = isPlainObject(attributes) ? attributes : {};
  const missing = Array.isArray(missingFields) ? missingFields : [];
  const evalMode = mode === 'keyword' ? 'keyword' : 'full';

  const fitConfig = isPlainObject(cfg.fit) ? cfg.fit : {};
  const base = numOr(fitConfig.base, 50);
  const softDealBreakerPenalty = numOr(fitConfig.soft_deal_breaker_penalty, 0);
  const strongThreshold = numOr(fitConfig.strong_threshold, 70);
  const minCoverage = numOr(fitConfig.min_coverage, 0);

  const activeRules = compileRules(cfg).filter((r) => r.enabled !== false);

  let total = 0;
  let earned = 0;
  let evaluated = 0;
  let softDealBreakerTriggerCount = 0;

  const firedRules = activeRules.map((rule) => {
    const { kind } = rule;
    const enforcement = rule.enforcement === 'hard' ? 'hard' : 'soft';
    const weight = numOr(rule.weight, 0);
    const field = rule.expr && rule.expr.field;

    const exprResult = evalExpr(rule.expr, attrs, missing);
    const outcome = deriveOutcome(kind, exprResult);

    const isCountable = kind === 'must_have' || kind === 'focus';
    if (isCountable) {
      total += weight;
      if (outcome !== 'unknown') evaluated += weight;
      if (outcome === 'satisfied') earned += weight;
    } else if (kind === 'deal_breaker' && enforcement === 'soft' && outcome === 'triggered') {
      softDealBreakerTriggerCount += 1;
    }

    const resolved = resolveField(field, attrs, missing);
    const weightApplied = isCountable && outcome === 'satisfied' ? weight : 0;

    return {
      id: rule.id,
      label: rule.label != null ? rule.label : null,
      kind,
      enforcement,
      outcome,
      field,
      expected: rule.expr && rule.expr.value,
      observed: outcome === 'unknown' ? null : resolved.value,
      weight_applied: weightApplied,
    };
  });

  const penalty = softDealBreakerPenalty * softDealBreakerTriggerCount;
  const fit = total > 0 ? clamp(0, 100, (100 * earned) / total - penalty) : base;
  const coverage = evalMode === 'keyword' ? null : total > 0 ? evaluated / total : 1.0;

  const verdict = computeVerdict({
    firedRules,
    fit,
    coverage,
    minCoverage,
    strongThreshold,
    mode: evalMode,
  });

  return {
    mode: evalMode,
    fired_rules: firedRules,
    total,
    earned,
    penalty,
    fit,
    coverage,
    verdict,
  };
}

module.exports = {
  clamp,
  compileMandateRules,
  compileRules,
  resolveField,
  evalContains,
  evalExpr,
  deriveOutcome,
  computeVerdict,
  evaluateThesis,
};
