// lib/f06/decision.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and
// re-paste. Deterministic $100K decision node for feature 06 (Investment
// Memo & Decision), docs/backlog/06-memo-decision/design.md §8, plan.md T1.
//
// Zero-import CommonJS -- pure function, NO require(), NO imports, no I/O, no
// Date.now()/Math.random(), no top-level side effects. Pasted verbatim into
// the [C] Decision Code node (§5's `[A]->...->Merge->[C]->[D]` chain); the
// n8n sandbox cannot `require()` from this repo (same rule as lib/f05/trust.js
// and lib/f07/rules.js -- see those files' headers for the identical
// precedent this module follows).
//
// I1 (never average axes) and I6 (deterministic recommendation, no LLM) are
// the two invariants this file exists to guarantee. `founder_score` is read
// only far enough to snapshot it into `decision_inputs` for traceability --
// it never gates the recommendation (design §8's "decision-inert" ruling,
// I2's cold-start posture: founder_score is assessed on 14/164 founders
// today, so gating on it would penalise unscored founders).
//
// ============================================================================
// `decide(inputs, configOverrides?)` -- the module's one entry point
// ============================================================================
//
// `inputs` shape (design §8, §3.2-§3.9):
//   {
//     thesis_verdict:       'passed' | 'borderline' | 'failed' |
//                            'insufficient_evidence' | null,
//     thesis_fit:           number | null,
//     thesis_fired_rules:   [ { id, label, kind, enforcement, outcome, ... } ],
//     axes: {
//       founder:            { value: number|null, assessed: boolean },
//       market:              { value: number|null, assessed: boolean },
//       idea_vs_market:      { value: number|null, assessed: boolean },
//     },
//     founder_score:        { value: number|null, assessed: boolean },
//     trust: {
//       value:               number|null, assessed: boolean,
//       coverage:            number|null,  // 0..1
//       confidence:          number|null,  // 0..1
//     },
//     material_contradictions: number,   // count, §3.9
//     fatal_contradictions:    number,   // count, §3.9 (subset of material)
//   }
//
// `configOverrides` -- optional, merged over DECISION_CONFIG (literal
// fallback discipline, same convention as lib/f05/trust.js's
// `computeTrustRollup(rows, config, ctx)`). Not part of the team-lead task
// brief's one-line signature, but required to make the D1b
// `ENABLE_FATAL_CONTRADICTION_PASS=false` acceptance case (plan.md T1)
// testable without mutating the exported `DECISION_CONFIG` -- and it is the
// literal mechanism design §8 calls "demo-tunable ... without reopening the
// design." decision.test.js documents this call shape at its D1b-disabled
// case.
//
// Returns `{ recommendation, conditions }`. `recommendation` is always one of
// the four I8 strings -- the cascade below is total (D6 is an unconditional
// catch-all), so this function never returns null/undefined for any input,
// including malformed/partial ones (defensive coercion throughout, exercised
// by the test file's fuzz case).

'use strict';

// ----------------------------------------------------------------------------
// Config -- named constants only, no threshold hardcoded inline below
// (design §8: "Thresholds are named constants (DECISION_CONFIG ...),
// demo-tuned -- the one editable place").
// ----------------------------------------------------------------------------

const DECISION_CONFIG = Object.freeze({
  TRUST_FLOOR: 40,
  STRONG_TRUST: 60,
  AXIS_HIGH: 60,
  AXIS_LOW: 40,
  CONF_FLOOR: 0.45,
  MIN_TRUST_COVERAGE: 0.25,
  ENABLE_FATAL_CONTRADICTION_PASS: true,
  thresholds_version: 'f06-2026.07',
});

// $100K figure has no schema column (design §F3/§4.4) -- it lives in
// `conditions.check_size_usd`, a fixed literal for this MVP (single-thesis,
// single-check-size fund posture; not read from `inputs` because no upstream
// stage exposes a per-application check size today).
const CHECK_SIZE_USD = 100000;

// The three screening axes, in their canonical order (I1 -- never averaged,
// but a stable order matters for reviewable, deterministic output).
const SCREENING_AXIS_KEYS = ['founder', 'market', 'idea_vs_market'];

// D4 gates only the two STRUCTURAL axes -- design §8 D4: "The founder axis
// is assessed=false on every app today (no value to gate on), so it never
// triggers D4". Kept as an explicit subset (not "all screening axes minus
// founder") so a future structural axis addition is a one-line change here,
// not an inferred exclusion.
const STRUCTURAL_AXIS_KEYS = ['market', 'idea_vs_market'];

// Human labels for rationale/condition text -- `idea_vs_market`'s prose label
// matches design §8/§4.4's own vocabulary ("idea-market fit"), not the raw
// column name.
const AXIS_LABELS = { founder: 'founder', market: 'market', idea_vs_market: 'idea-market fit' };

// ----------------------------------------------------------------------------
// Small shared helpers (independent copies, no shared import across lib/f06
// modules by design -- same precedent as lib/f05/trust.js's header note,
// itself citing lib/f03/scoring.js and lib/f04/scoring.js).
// ----------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function mergeConfig(overrides) {
  return Object.assign({}, DECISION_CONFIG, isPlainObject(overrides) ? overrides : {});
}

// Normalizes one axis entry to `{ assessed, value }`. `assessed` must be
// exactly `true` AND carry a finite `value` -- an axis marked assessed with a
// missing/non-numeric value is defensive-only (upstream's own contract
// always pairs assessed=true with a concrete value), never trusted to
// silently coerce toward 0 (I2: absent is never zero).
function axisView(axesInput, key) {
  const a = isPlainObject(axesInput) ? axesInput[key] : null;
  if (!isPlainObject(a) || a.assessed !== true || !isFiniteNumber(a.value)) {
    return { assessed: false, value: null };
  }
  return { assessed: true, value: a.value };
}

function scalarView(input) {
  const v = isPlainObject(input) ? input : {};
  const assessed = v.assessed === true && isFiniteNumber(v.value);
  return { assessed, value: assessed ? v.value : null };
}

function trustView(trustInput) {
  const t = isPlainObject(trustInput) ? trustInput : {};
  const assessed = t.assessed === true && isFiniteNumber(t.value);
  return {
    assessed,
    value: assessed ? t.value : null,
    coverage: isFiniteNumber(t.coverage) ? t.coverage : null,
    confidence: isFiniteNumber(t.confidence) ? t.confidence : null,
  };
}

// ----------------------------------------------------------------------------
// D3 -- decidability gate (design §8): all three conditions must hold.
// ----------------------------------------------------------------------------

function isDecidable(thesisVerdict, trust, assessedAxisCount, config) {
  if (thesisVerdict !== 'passed' && thesisVerdict !== 'borderline') return false;
  if (!trust.assessed) return false;
  if (!isFiniteNumber(trust.coverage) || trust.coverage < config.MIN_TRUST_COVERAGE) return false;
  if (!isFiniteNumber(trust.confidence) || trust.confidence < config.CONF_FLOOR) return false;
  if (assessedAxisCount < 2) return false;
  return true;
}

// ----------------------------------------------------------------------------
// conditions.items (design §4.4/§8 -- D6 only). Every other rule ships
// items=[] ("For pass/clean-proceed, items=[]" -- design §4.4's own example;
// extended here to D2/D3 watchlist too, since §8's item-construction recipe
// is written under the D6 heading exclusively and nowhere else in the design
// spells out a watchlist items shape. Flagged to the team lead as an
// ambiguity resolution -- see decision.test.js's file header.)
//
// `claim_ids` is always `[]` on every item this function builds: `decide()`'s
// input contract (design §8's own inputs list) carries only axis/trust/
// contradiction NUMBERS, never per-topic claim ids -- there is no claim-level
// data in scope here for a topic like "the two low-trust traction claims" to
// resolve against. If a future revision wants condition items cited to
// specific claims, that enrichment belongs to [D] Assemble (which does hold
// the claim corpus), not to this deterministic-numbers-only node.
// ----------------------------------------------------------------------------

function buildConditionItems(ruleFired, axes, trust, thesisFiredRules, config) {
  if (ruleFired !== 'D6') return [];

  const items = [];

  // Each assessed screening axis below AXIS_HIGH -- design §8 D6 bullet 1.
  for (const key of SCREENING_AXIS_KEYS) {
    const axis = axes[key];
    if (axis.assessed && axis.value < config.AXIS_HIGH) {
      items.push({
        text: `Diligence ${AXIS_LABELS[key]}: currently ${axis.value}.`,
        closes: `${key} below strong threshold`,
        claim_ids: [],
      });
    }
  }

  // Each fired soft deal-breaker / borderline rule -- design §8 D6 bullet 2.
  // `thesis_fired_rules` follows lib/f07/rules.js's own `fired_rules[]` shape
  // (`{ id, label, kind, enforcement, outcome, ... }`); a hard-enforcement
  // rule never reaches here (thesis_verdict would already be 'failed' -> D1).
  const rules = Array.isArray(thesisFiredRules) ? thesisFiredRules : [];
  for (const rule of rules) {
    if (!isPlainObject(rule)) continue;
    if (rule.enforcement === 'soft' && (rule.outcome === 'missed' || rule.outcome === 'triggered')) {
      const label = rule.label != null ? rule.label : rule.id;
      items.push({
        text: `Review fired thesis rule "${label}" (${rule.outcome}).`,
        closes: `${rule.id} ${rule.outcome}`,
        claim_ids: [],
      });
    }
  }

  // Trust in [TRUST_FLOOR, STRONG_TRUST) -- design §8 D6 bullet 3.
  if (trust.assessed && trust.value >= config.TRUST_FLOOR && trust.value < config.STRONG_TRUST) {
    const coverageNote = isFiniteNumber(trust.coverage) ? ` (coverage ${trust.coverage})` : '';
    items.push({
      text: `Raise evidence coverage: trust currently ${trust.value}${coverageNote}.`,
      closes: `trust ${trust.value}${isFiniteNumber(trust.coverage) ? `, coverage ${trust.coverage}` : ''}`,
      claim_ids: [],
    });
  }

  return items;
}

// ----------------------------------------------------------------------------
// conditions.rationale -- the deterministic conflict-arbitration sentence
// (design §8, last section: "renders the RULE'S OWN reasoning; no LLM
// re-derives it", I6). One templated builder per rule_fired branch; D6 gets
// its own composer since it is the only branch that has to NAME disagreeing
// axes (design §4.4's worked example).
// ----------------------------------------------------------------------------

function buildD6Rationale(thesisVerdict, axes, trust, materialContradictions, config) {
  const strong = [];
  const thin = [];
  for (const key of SCREENING_AXIS_KEYS) {
    const axis = axes[key];
    if (!axis.assessed) continue;
    if (axis.value >= config.AXIS_HIGH) strong.push(`${AXIS_LABELS[key]} strong (${axis.value})`);
    else thin.push(`${AXIS_LABELS[key]} thin (${axis.value})`);
  }

  let axisClause;
  if (strong.length > 0 && thin.length > 0) {
    axisClause = `${strong.join(', ')} but ${thin.join(', ')}`;
  } else if (strong.length > 0 || thin.length > 0) {
    axisClause = strong.concat(thin).join(', ');
  } else {
    axisClause = 'no screening axis assessed';
  }

  const trustClause = !trust.assessed
    ? 'trust not assessed'
    : trust.value >= config.STRONG_TRUST
      ? `trust is strong (${trust.value})`
      : `trust (${trust.value}) is below the strong threshold of ${config.STRONG_TRUST}`;

  const contradictionClause =
    materialContradictions === 0
      ? 'no material contradiction stands'
      : `${materialContradictions} material contradiction(s) noted`;

  return (
    `Thesis ${thesisVerdict}; ${axisClause}, ${trustClause}, and ${contradictionClause} -- ` +
    `proceed, conditioned on closing what fell short.`
  );
}

function buildRationale(ruleFired, ctx, config) {
  const { thesisVerdict, axes, trust, materialContradictions, fatalContradictions, assessedScreeningAxes } = ctx;

  if (ruleFired === 'D1') {
    return (
      `Thesis verdict is 'failed' -- a hard mandate deal-breaker fired. Not conditionable and not ` +
      `rescued by any score; the thesis already rejected this deal.`
    );
  }

  if (ruleFired === 'D1b') {
    return (
      `${fatalContradictions} objectively-confirmed material factual contradiction(s) stand -- a ` +
      `proven false claim is a known no, not a dig-deeper.`
    );
  }

  if (ruleFired === 'D2') {
    const reasons = [];
    if (materialContradictions > 0) reasons.push(`${materialContradictions} material contradiction(s) unresolved`);
    if (trust.assessed && trust.value < config.TRUST_FLOOR) {
      reasons.push(`trust at ${trust.value}, below the floor of ${config.TRUST_FLOOR}`);
    }
    const why = reasons.length > 0 ? reasons.join(' and ') : 'a documented contradiction or floor-level trust';
    return `${why} -- dig first before any check moves; not a pass, not a proceed.`;
  }

  if (ruleFired === 'D3') {
    const reasons = [];
    if (thesisVerdict !== 'passed' && thesisVerdict !== 'borderline') {
      reasons.push(`thesis verdict is ${thesisVerdict == null ? 'unresolved' : `'${thesisVerdict}'`}`);
    }
    if (!trust.assessed) {
      reasons.push('trust not assessed');
    } else {
      if (!isFiniteNumber(trust.coverage) || trust.coverage < config.MIN_TRUST_COVERAGE) {
        reasons.push(
          `trust coverage ${trust.coverage == null ? 'unknown' : trust.coverage} below the ${config.MIN_TRUST_COVERAGE} floor`
        );
      }
      if (!isFiniteNumber(trust.confidence) || trust.confidence < config.CONF_FLOOR) {
        reasons.push(
          `trust confidence ${trust.confidence == null ? 'unknown' : trust.confidence} below the ${config.CONF_FLOOR} floor`
        );
      }
    }
    if (assessedScreeningAxes.length < 2) {
      reasons.push(`only ${assessedScreeningAxes.length} of 3 screening axes assessed`);
    }
    const why = reasons.length > 0 ? reasons.join('; ') : 'insufficient signal to decide responsibly';
    return `Not enough is known to decide responsibly in 24h (${why}) -- an honest unknown, not a silent pass.`;
  }

  if (ruleFired === 'D4') {
    const weak = STRUCTURAL_AXIS_KEYS.filter((k) => axes[k].assessed && axes[k].value < config.AXIS_LOW);
    const parts = weak.map((k) => `${AXIS_LABELS[k]} measured at ${axes[k].value}`);
    return (
      `${parts.join(' and ')} -- below the structural floor of ${config.AXIS_LOW}. A measured ` +
      `collapse, not thin data: a known no.`
    );
  }

  if (ruleFired === 'D5') {
    const parts = assessedScreeningAxes.map((k) => `${AXIS_LABELS[k]} strong (${axes[k].value})`);
    return (
      `Thesis passed and every assessed screening axis is strong (${parts.join(', ')}) with trust at ` +
      `${trust.value}, at or above the ${config.STRONG_TRUST} strong-trust threshold, and no material ` +
      `contradiction -- proceed.`
    );
  }

  // D6
  return buildD6Rationale(thesisVerdict, axes, trust, materialContradictions, config);
}

// ----------------------------------------------------------------------------
// decide -- the cascade, design §8, first match wins.
// ----------------------------------------------------------------------------

function decide(inputs, configOverrides) {
  const config = mergeConfig(configOverrides);
  const input = isPlainObject(inputs) ? inputs : {};

  const thesisVerdict = input.thesis_verdict != null ? input.thesis_verdict : null;
  const thesisFit = isFiniteNumber(input.thesis_fit) ? input.thesis_fit : null;
  const thesisFiredRules = Array.isArray(input.thesis_fired_rules) ? input.thesis_fired_rules : [];

  const axesInput = isPlainObject(input.axes) ? input.axes : {};
  const axes = {
    founder: axisView(axesInput, 'founder'),
    market: axisView(axesInput, 'market'),
    idea_vs_market: axisView(axesInput, 'idea_vs_market'),
  };

  const founderScore = scalarView(input.founder_score);
  const trust = trustView(input.trust);

  const materialContradictions = isFiniteNumber(input.material_contradictions) ? input.material_contradictions : 0;
  const fatalContradictions = isFiniteNumber(input.fatal_contradictions) ? input.fatal_contradictions : 0;

  const assessedScreeningAxes = SCREENING_AXIS_KEYS.filter((k) => axes[k].assessed);
  const assessedAxisCount = assessedScreeningAxes.length;

  let ruleFired;
  let recommendation;

  // D1 -- hard mandate-fatal deal-breaker; thesis already rejected the deal.
  if (thesisVerdict === 'failed') {
    ruleFired = 'D1';
    recommendation = 'pass';

    // D1b -- proven material factual fabrication; a known no, not a dig-deeper.
    // Config-gated (default on); conservative on live data (events
    // fixture-only today, design §8 D1b).
  } else if (config.ENABLE_FATAL_CONTRADICTION_PASS && fatalContradictions > 0) {
    ruleFired = 'D1b';
    recommendation = 'pass';

    // D2 -- a live documented contradiction or floor-level trust is "dig
    // first", never a pass and never a proceed.
  } else if (materialContradictions > 0 || (trust.assessed && trust.value < config.TRUST_FLOOR)) {
    ruleFired = 'D2';
    recommendation = 'watchlist';

    // D3 -- not decidable in 24h; the honest cold-start answer (I2), not a
    // silent pass.
  } else if (!isDecidable(thesisVerdict, trust, assessedAxisCount, config)) {
    ruleFired = 'D3';
    recommendation = 'watchlist';

    // D4 -- a genuinely MEASURED structural collapse (market or idea-market
    // fit only -- never founder) is a known no. Reached only when decidable,
    // so this never pass-rejects on thin data.
  } else if (STRUCTURAL_AXIS_KEYS.some((k) => axes[k].assessed && axes[k].value < config.AXIS_LOW)) {
    ruleFired = 'D4';
    recommendation = 'pass';

    // D5 -- every signal strong; clean proceed.
  } else if (
    thesisVerdict === 'passed' &&
    assessedScreeningAxes.every((k) => axes[k].value >= config.AXIS_HIGH) &&
    trust.value >= config.STRONG_TRUST &&
    materialContradictions === 0
  ) {
    ruleFired = 'D5';
    recommendation = 'proceed';

    // D6 -- decidable, mixed signal; proceed-with-conditions, catch-all so
    // this cascade is total and never returns null (I8).
  } else {
    ruleFired = 'D6';
    recommendation = 'proceed-with-conditions';
  }

  const items = buildConditionItems(ruleFired, axes, trust, thesisFiredRules, config);
  const rationale = buildRationale(
    ruleFired,
    { thesisVerdict, axes, trust, materialContradictions, fatalContradictions, assessedScreeningAxes },
    config
  );

  const conditions = {
    check_size_usd: CHECK_SIZE_USD,
    rationale,
    items,
    // Traceability snapshot -- the exact numbers the RULE saw (design §4.4).
    // `axes`/`founder_score`/`trust` here are raw VALUES (null when not
    // assessed), not the {value,assessed} objects `decide()` was given --
    // matches design §4.4's own worked example verbatim
    // (`"axes": {"founder": null, "market": 68.0, ...}`).
    decision_inputs: {
      thesis_verdict: thesisVerdict,
      thesis_fit: thesisFit,
      thesis_fired_rules: thesisFiredRules,
      axes: {
        founder: axes.founder.value,
        market: axes.market.value,
        idea_vs_market: axes.idea_vs_market.value,
      },
      founder_score: founderScore.value,
      trust: trust.value,
      trust_coverage: trust.coverage,
      trust_confidence: trust.confidence,
      material_contradictions: materialContradictions,
      fatal_contradictions: fatalContradictions,
      rule_fired: ruleFired,
    },
    thresholds_version: config.thresholds_version,
  };

  return { recommendation, conditions };
}

module.exports = {
  DECISION_CONFIG,
  CHECK_SIZE_USD,
  SCREENING_AXIS_KEYS,
  STRUCTURAL_AXIS_KEYS,
  decide,
};
