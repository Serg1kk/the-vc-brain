// lib/f03/gate.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Validation gate for feature 03 (Founder Score). Implements design.md §4.4 steps 1-8,
// in order: "the model proposes booleans, the backend decides the number." Every verdict
// the four sub-scorer LLM calls emit passes through here before it becomes a
// score_components row -- this file is what makes REQ-003 / I2 enforced rather than hoped
// for (a model cannot manufacture confidence-lowering absence into a scored `not_met`, and
// cannot launder a paraphrase as a verbatim quote).
//
// docs/backlog/03-founder-score/plan.md, task B2.
//
// Self-contained CommonJS, ZERO imports, no top-level side effects, deterministic
// (no Date.now(), no Math.random()). This file's body is pasted verbatim into an n8n Code
// node -- n8n's sandbox cannot require() from the repo (no bind-mount, see plan.md
// "Guiding decisions" #3) -- so any import here makes it unusable in production.
//
// applyGate(rawAgentOutputs, contextPacks, config) -> components[]
//
// Expected shapes (contract for task B4, the headless runner, and for C1, the n8n
// workflow's context-pack-building nodes). Both the A2 agent-spec shape (primary, authored
// after this file was first written -- docs/backlog/03-founder-score/agents/) and a legacy
// shape (kept so nothing regresses) are accepted:
//
//   rawAgentOutputs = {
//     "execution-signals":  { subscorer: "execution-signals", verdicts: [
//                               { criterion_id, reasoning, verdict, claim_ids, quote_verbatim,
//                                 rationale, what_would_close_it }
//                             ] }
//                            | { criteria: [ ... ] }             // legacy key, still accepted
//                            | { error: "<message>" }            // step 8 partial failure
//     "expertise-signals":  { subscorer: "expertise-signals", verdicts: [ ... ], pedigree: {...} }
//                            // pedigree passed through untouched by this gate -- see run.js
//     "leadership-sales-proxies": { subscorer: "leadership-sales-proxies", verdicts: [ ... ] }
//     "red-flags":          { subscorer: "red-flags", flags: [
//                               { flag_id, reasoning, severity, claim_ids, quote_verbatim,
//                                 contradiction }
//                             ] }
//                            | { red_flags: [ { id, ... } ] }    // legacy key, still accepted
//                            | { error: "<message>" }
//   }
//
//   `reasoning` (pre-verdict analysis) and `rationale` (interpretation stored alongside the
//   quote) are distinct fields in the A2 shape -- this gate stores `rationale` in the
//   component and does not fall back to `reasoning` when `rationale` is present. `id` is
//   accepted as a fallback for `criterion_id` / `flag_id` on malformed input.
//
//   contextPacks = {
//     "<subscorer-name>": {
//       claim_ids: ["<uuid>", ...],              // informational; membership is derived from
//                                                 // `claims` below regardless
//       claims: [
//         {
//           claim_id:      "<uuid>",
//           text_verbatim: "...",
//           topic:         "founder.execution.merged_pr",
//           source_kind:   "public" | "self_reported" | "derived" | "interview" | "voice",
//           evidence: [
//             {
//               tier:            "documented" | "discovered" | "inferred" | "missing",
//               quote_verbatim:  "..." | null,
//               source_url:      "..." | null,
//               raw_signal_id:   "<uuid>" | null,   // evidence.raw_signal_id is nullable
//               source:          "github_api" | ... | null   // raw_signals.source, PRE-JOINED
//                                                             // by the caller -- gate.js does
//                                                             // no DB access. null/absent when
//                                                             // raw_signal_id is null, in which
//                                                             // case step 5 uses the
//                                                             // source_kind fallback.
//             }, ...
//           ]
//         }, ...
//       ]
//     }, ...
//   }
//
//   config = {
//     credit: { met_documented: 1.0, met_discovered: 0.8, self_asserted: 0.3, not_met: 0.0 },
//     // criteria / red_flags: the LIVE db/seed.sql `formula_v1` row stores both as ARRAYS
//     // (jsonb_typeof = 'array'); an object keyed by id is also accepted (e.g. for hand-built
//     // test fixtures). Both forms are normalized to an internal by-id map before use.
//     criteria: [
//       { id: "<criterion_id>", subscorer: "<one of the four subscorer names>",
//         weight: 0.10000,                                     // numeric(6,5), stored not computed
//         neg_src: "github_api" | ["tavily_extract", "github_api"],  // array, or a "|"/","
//                                                                     // -delimited string
//         raw: 5, anchor: "..." }                               // carried through, unused here
//       , ...
//     ]  |  { "<criterion_id>": { subscorer, weight, neg_src }, ... },
//     red_flags: [
//       { id: "<flag_id>", contradicts: ["<criterion_id>", ...], demote_to: "not_met" | "self_asserted" }
//       , ...
//     ]  |  { "<flag_id>": { contradicts: [...], demote_to } }
//   }
//
// `config.criteria` is the design §3 registry transcribed into db/seed.sql (`formula_v1`,
// task B3a); `config.red_flags` is the design §3 D contradicts/demote_to map from the same
// row. Both arrive as plain jsonb -- gate.js treats every field defensively.

'use strict';

var VALID_VERDICTS = ['met', 'self_asserted', 'not_met', 'cannot_assess'];

var TIER_RANK = { documented: 3, discovered: 2, inferred: 1, missing: 0 };

var WILDCARD_SOURCE = '*';

// design §4.4 step 5: fallback source resolution when evidence.raw_signal_id is not
// reachable. claims.source_kind -> permitted `neg_src` source. This is a DIFFERENT
// vocabulary from signal_sources.slug (which is what `neg_src` itself is expressed in) --
// see design §4.4's explicit warning. Fixed by design, not part of score_formulas.config.
var SOURCE_KIND_FALLBACK = {
  self_reported: 'deck_parse',
  derived: 'deck_parse',
  interview: 'interview_answer',
  voice: 'interview_answer',
  public: WILDCARD_SOURCE
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeWarn(msg) {
  // design step 3: "drop and log". console is a sandbox global, not an import -- guarded so
  // a sandbox without console never breaks the gate.
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[f03/gate] ' + msg);
    }
  } catch (_e) { /* logging must never break the gate */ }
}

function dedupe(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i];
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  }
  return out;
}

// config.criteria / config.red_flags arrive as either an array of {id, ...} elements (the
// live db/seed.sql `formula_v1` shape) or an object keyed by id (accepted for hand-built
// fixtures). Both are normalized to a plain by-id map before use.
function normalizeIdKeyedConfig(raw, fallbackIdField) {
  var out = {};
  if (Array.isArray(raw)) {
    raw.forEach(function (item) {
      if (!isPlainObject(item)) return;
      var rawId = item.id != null ? item.id : item[fallbackIdField];
      var id = rawId != null ? String(rawId).trim() : '';
      if (!id) return;
      out[id] = item;
    });
  } else if (isPlainObject(raw)) {
    Object.keys(raw).forEach(function (id) {
      if (isPlainObject(raw[id])) out[id] = raw[id];
    });
  }
  return out;
}

// Positive sub-scorers: A2 shape uses `verdicts`; legacy fixtures may use `criteria`.
function getVerdictsArray(raw) {
  if (!isPlainObject(raw)) return null;
  if (Array.isArray(raw.verdicts)) return raw.verdicts;
  if (Array.isArray(raw.criteria)) return raw.criteria;
  return null;
}

// red-flags sub-scorer: A2 shape uses `flags`; legacy fixtures may use `red_flags`.
function getFlagsArray(raw) {
  if (!isPlainObject(raw)) return null;
  if (Array.isArray(raw.flags)) return raw.flags;
  if (Array.isArray(raw.red_flags)) return raw.red_flags;
  return null;
}

function normalizeNegSrcList(negSrc) {
  if (Array.isArray(negSrc)) {
    return negSrc.map(function (s) { return String(s).trim(); }).filter(Boolean);
  }
  if (typeof negSrc === 'string') {
    return negSrc.split(/[|,]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return [];
}

// Primary path: evidence.raw_signal_id -> raw_signals.source (pre-joined into `ev.source`
// by the caller). Fallback: evidence.raw_signal_id is nullable (schema.sql) -- when it, or
// the pre-joined source, is absent, resolve via claims.source_kind instead.
function resolveEvidenceSource(claim, ev) {
  if (ev && ev.raw_signal_id && ev.source) return ev.source;
  var fallback = SOURCE_KIND_FALLBACK[claim && claim.source_kind];
  return fallback || null;
}

function sourceMatchesNegSrc(resolvedSource, negSrc) {
  if (!resolvedSource) return false;
  if (resolvedSource === WILDCARD_SOURCE) return true;
  return normalizeNegSrcList(negSrc).indexOf(resolvedSource) !== -1;
}

function buildClaimMap(pack) {
  var map = {};
  var claims = pack && Array.isArray(pack.claims) ? pack.claims : [];
  for (var i = 0; i < claims.length; i++) {
    var claim = claims[i];
    if (claim && claim.claim_id) map[claim.claim_id] = claim;
  }
  return map;
}

// Step 5 (and its re-application after step 6): does this agent's pack contain ANY claim
// whose resolved source matches criterion.neg_src? Search is pack-wide, not limited to the
// verdict's own citations -- design §4.4 step 5 says "the pack contains a claim", and step 6a
// needs "the neg_src-matching claim found in step 5" independent of what the model cited.
// Returns the BEST (highest-tier) match, or null.
function findNegSrcMatch(pack, negSrc) {
  var claims = pack && Array.isArray(pack.claims) ? pack.claims : [];
  var best = null;
  for (var i = 0; i < claims.length; i++) {
    var claim = claims[i];
    if (!claim || !claim.claim_id) continue;
    var evidenceList = Array.isArray(claim.evidence) ? claim.evidence : [];
    for (var j = 0; j < evidenceList.length; j++) {
      var ev = evidenceList[j];
      var resolved = resolveEvidenceSource(claim, ev);
      if (!sourceMatchesNegSrc(resolved, negSrc)) continue;
      var tier = (ev && typeof ev.tier === 'string' && (ev.tier in TIER_RANK)) ? ev.tier : 'missing';
      var rank = TIER_RANK[tier];
      if (!best || rank > best.rank) best = { claimId: claim.claim_id, tier: tier, rank: rank };
    }
  }
  return best ? { claimId: best.claimId, tier: best.tier } : null;
}

// Step 6a `met` branch: best evidence.tier among the criterion's cited claims.
// null means "no usable evidence tier found at all" (e.g. a cited claim with zero evidence
// rows), which step 6a treats the same as 'missing'.
function bestTierAmongClaims(claimMap, claimIds) {
  var best = null;
  for (var i = 0; i < claimIds.length; i++) {
    var claim = claimMap[claimIds[i]];
    if (!claim) continue;
    var evidenceList = Array.isArray(claim.evidence) ? claim.evidence : [];
    for (var j = 0; j < evidenceList.length; j++) {
      var ev = evidenceList[j];
      var tier = (ev && typeof ev.tier === 'string' && (ev.tier in TIER_RANK)) ? ev.tier : null;
      if (!tier) continue;
      var rank = TIER_RANK[tier];
      if (best === null || rank > best.rank) best = { tier: tier, rank: rank };
    }
  }
  return best ? best.tier : null;
}

// Step 7: exact-substring check against the cited claims' text_verbatim / evidence quotes.
function quoteIsVerbatim(quote, claimMap, claimIds) {
  if (!quote) return false;
  for (var i = 0; i < claimIds.length; i++) {
    var claim = claimMap[claimIds[i]];
    if (!claim) continue;
    if (typeof claim.text_verbatim === 'string' && claim.text_verbatim.indexOf(quote) !== -1) {
      return true;
    }
    var evidenceList = Array.isArray(claim.evidence) ? claim.evidence : [];
    for (var j = 0; j < evidenceList.length; j++) {
      var ev = evidenceList[j];
      if (ev && typeof ev.quote_verbatim === 'string' && ev.quote_verbatim.indexOf(quote) !== -1) {
        return true;
      }
    }
  }
  return false;
}

// Step 8: did this sub-scorer error / throw / time out / return something unusable?
function subscorerFailed(raw) {
  if (!isPlainObject(raw)) return true;
  if (raw.error) return true;
  if (getVerdictsArray(raw) === null) return true;
  return false;
}

// Steps 5 and its re-application after step 6: coerce `not_met` -> `cannot_assess` unless
// the pack carries a neg_src-matching claim. Mutates `componentsById` in place; called once
// right after steps 1-4 (before red-flag demotion) and once again after (design §4.4 step 6
// explicitly requires the re-application -- R1 demotes *to* `not_met`, the very verdict this
// function polices, so a demotion must not bypass it).
function applyNegativeCapability(componentsById, contextPacks, criteriaRegistry) {
  Object.keys(componentsById).forEach(function (critId) {
    var comp = componentsById[critId];
    if (comp.verdict !== 'not_met') return;
    var def = criteriaRegistry[critId];
    var pack = contextPacks[comp.subscorer] || { claims: [] };
    var match = findNegSrcMatch(pack, def.neg_src);
    if (!match) {
      comp.verdict = 'cannot_assess';
      comp.what_would_close_it = 'criterion ' + critId + ': not_met requires a claim sourced from ' +
        (Array.isArray(def.neg_src) ? def.neg_src.join('/') : def.neg_src) + '; none found in pack';
      comp._negMatch = null;
    } else {
      comp._negMatch = match;
    }
  });
}

function applyGate(rawAgentOutputs, contextPacks, config) {
  rawAgentOutputs = isPlainObject(rawAgentOutputs) ? rawAgentOutputs : {};
  contextPacks = isPlainObject(contextPacks) ? contextPacks : {};
  config = isPlainObject(config) ? config : {};

  var creditMap = isPlainObject(config.credit) ? config.credit : {};
  var criteriaRegistry = normalizeIdKeyedConfig(config.criteria, 'criterion_id');
  var redFlagMap = normalizeIdKeyedConfig(config.red_flags, 'flag_id');

  // Group registry criteria by their owning sub-scorer.
  var criteriaBySubscorer = {};
  Object.keys(criteriaRegistry).forEach(function (critId) {
    var def = criteriaRegistry[critId];
    if (!def || !def.subscorer) return;
    if (!criteriaBySubscorer[def.subscorer]) criteriaBySubscorer[def.subscorer] = [];
    criteriaBySubscorer[def.subscorer].push(critId);
  });

  var componentsById = {};

  // ---- Steps 1-4, plus step 8's short-circuit, per sub-scorer ----
  Object.keys(criteriaBySubscorer).forEach(function (subscorerName) {
    var criterionIds = criteriaBySubscorer[subscorerName];
    var raw = rawAgentOutputs[subscorerName];
    var pack = contextPacks[subscorerName] || { claims: [] };
    var claimMap = buildClaimMap(pack);
    var failed = subscorerFailed(raw);

    // Model-emitted criteria for this sub-scorer, keyed by validated criterion_id.
    // Step 3: unknown ids, and ids belonging to a different sub-scorer, are dropped + logged.
    var emittedById = {};
    if (!failed) {
      getVerdictsArray(raw).forEach(function (item) {
        if (!isPlainObject(item)) return;
        var rawId = item.criterion_id != null ? item.criterion_id : item.id;
        var critId = String(rawId != null ? rawId : '').trim();
        if (!critId) return;
        var def = criteriaRegistry[critId];
        if (!def || def.subscorer !== subscorerName) {
          safeWarn('unknown or misrouted criterion_id "' + critId + '" from ' + subscorerName + '; dropped');
          return;
        }
        if (emittedById[critId]) return; // duplicate emission in one response; keep the first
        emittedById[critId] = item;
      });
    }

    criterionIds.forEach(function (critId) {
      var def = criteriaRegistry[critId];
      var comp;

      if (failed) {
        // Step 8: partial failure -> every criterion of this sub-scorer is cannot_assess.
        // The other sub-scorers are untouched and still aggregate normally.
        comp = {
          subscorer: subscorerName,
          criterion_id: critId,
          verdict: 'cannot_assess',
          weight: def.weight,
          credit: null,
          evidence_tier: null,
          claim_ids: [],
          quote_verbatim: null,
          rationale: null,
          what_would_close_it: 'sub-scorer ' + subscorerName + ' failed; rerun',
          demoted_by: null
        };
      } else if (!emittedById[critId]) {
        // Step 3: criterion is in the registry but the response is silent on it. Absence is
        // always recorded explicitly, never silently missing.
        comp = {
          subscorer: subscorerName,
          criterion_id: critId,
          verdict: 'cannot_assess',
          weight: def.weight,
          credit: null,
          evidence_tier: null,
          claim_ids: [],
          quote_verbatim: null,
          rationale: null,
          what_would_close_it: 'criterion ' + critId + ' not addressed by ' + subscorerName,
          demoted_by: null
        };
      } else {
        var item = emittedById[critId];

        // Step 1: normalize.
        var verdict = String(item.verdict != null ? item.verdict : '').toLowerCase().trim();

        // Step 2: enum.
        if (VALID_VERDICTS.indexOf(verdict) === -1) verdict = 'cannot_assess';

        // Step 4: citation. Drop hallucinated ids FIRST, then coerce met/self_asserted to
        // cannot_assess only if nothing survived -- one bad id must not nullify an otherwise
        // well-evidenced verdict.
        var citedIds = Array.isArray(item.claim_ids) ? item.claim_ids : [];
        citedIds = dedupe(citedIds.filter(function (id) { return !!claimMap[id]; }));

        // `reasoning` (pre-verdict analysis) and `rationale` (interpretation stored beside
        // the quote) are distinct A2 fields -- only `rationale` is stored; never collapse
        // `reasoning` into it.
        var modelWhatWouldCloseIt = item.what_would_close_it != null ? item.what_would_close_it : null;
        var whatWouldCloseIt = null;
        if ((verdict === 'met' || verdict === 'self_asserted') && citedIds.length === 0) {
          whatWouldCloseIt = 'criterion ' + critId + ': verdict "' + verdict + '" cited no valid claim in the pack';
          verdict = 'cannot_assess';
        }
        if (verdict === 'cannot_assess' && !whatWouldCloseIt) {
          // No backend-specific coercion fired above (e.g. the model emitted cannot_assess
          // directly, or step 2's enum check coerced it) -- prefer the model's own
          // explanation over the generic fallback the final normalization pass would add.
          whatWouldCloseIt = modelWhatWouldCloseIt;
        }

        comp = {
          subscorer: subscorerName,
          criterion_id: critId,
          verdict: verdict,
          weight: def.weight,
          credit: null,
          evidence_tier: null,
          claim_ids: citedIds,
          quote_verbatim: item.quote_verbatim != null ? item.quote_verbatim : null,
          rationale: item.rationale != null ? item.rationale : null,
          what_would_close_it: whatWouldCloseIt,
          demoted_by: null
        };
      }

      componentsById[critId] = comp;
    });
  });

  // ---- Step 5, first application (governs verdicts the models emitted directly) ----
  applyNegativeCapability(componentsById, contextPacks, criteriaRegistry);

  // ---- Step 6: red-flag demotion. Applies the red-flags agent's fired flags to the OTHER
  // agents' verdicts, per config.red_flags' contradicts/demote_to map. Demotion overwrites
  // verdict unconditionally, regardless of the criterion's current state (including
  // cannot_assess from a failed sub-scorer -- a strong red flag can still speak for a
  // criterion whose own agent errored). ----
  var redFlagsRaw = rawAgentOutputs['red-flags'];
  var flagsArray = getFlagsArray(redFlagsRaw);
  if (flagsArray) {
    var firedFlagIds = dedupe(
      flagsArray
        .filter(function (f) { return isPlainObject(f) && (f.flag_id != null || f.id != null); })
        .map(function (f) { return String(f.flag_id != null ? f.flag_id : f.id).trim(); })
    );
    firedFlagIds.forEach(function (flagId) {
      var rule = redFlagMap[flagId];
      if (!rule || !Array.isArray(rule.contradicts)) return;
      rule.contradicts.forEach(function (targetCritId) {
        var comp = componentsById[targetCritId];
        if (!comp) return;
        comp.verdict = rule.demote_to;
        comp.demoted_by = flagId;
      });
    });
  }

  // ---- Step 5, re-application (post-demotion). A demotion to `not_met` (R1's demote_to) is
  // the very verdict step 5 exists to police -- without this second pass, a red flag would be
  // able to write an unsupported `not_met` straight past REQ-003. ----
  applyNegativeCapability(componentsById, contextPacks, criteriaRegistry);

  // ---- Step 6a: backend-assigned evidence_tier + credit (never the model). ----
  Object.keys(componentsById).forEach(function (critId) {
    var comp = componentsById[critId];
    var pack = contextPacks[comp.subscorer] || { claims: [] };
    var claimMap = buildClaimMap(pack);

    if (comp.verdict === 'met') {
      var bestTier = bestTierAmongClaims(claimMap, comp.claim_ids);
      if (bestTier === 'inferred' || bestTier === 'missing' || bestTier === null) {
        // A claim we only inferred is not corroboration -- and this is what keeps the
        // credit map total (design §2.3 has no met_inferred / met_missing entry).
        comp.verdict = 'self_asserted';
        comp.evidence_tier = 'missing';
        comp.credit = creditMap.self_asserted;
      } else {
        comp.evidence_tier = bestTier;
        comp.credit = bestTier === 'documented' ? creditMap.met_documented : creditMap.met_discovered;
      }
    } else if (comp.verdict === 'self_asserted') {
      comp.evidence_tier = 'missing';
      comp.credit = creditMap.self_asserted;
    } else if (comp.verdict === 'not_met') {
      var negMatch = comp._negMatch;
      comp.evidence_tier = negMatch ? negMatch.tier : null;
      comp.credit = creditMap.not_met;
      // Ensure the claim that actually licenses the negative is traceable, alongside
      // whatever the model itself cited (kept, not cleared -- see task report for why).
      if (negMatch && comp.claim_ids.indexOf(negMatch.claimId) === -1) {
        comp.claim_ids = comp.claim_ids.concat([negMatch.claimId]);
      }
    } else {
      comp.evidence_tier = null;
      comp.credit = null;
    }
    delete comp._negMatch;
  });

  // ---- Step 7: verbatim integrity (I6 / RSK-003). Runs last among the mutating steps so it
  // validates the FINAL claim_ids, whatever step 6/6a left them as. ----
  Object.keys(componentsById).forEach(function (critId) {
    var comp = componentsById[critId];
    if (!comp.quote_verbatim) return;
    var pack = contextPacks[comp.subscorer] || { claims: [] };
    var claimMap = buildClaimMap(pack);
    if (!quoteIsVerbatim(comp.quote_verbatim, claimMap, comp.claim_ids)) {
      comp.quote_verbatim = null;
    }
  });

  // ---- Final normalization: enforce the cannot_assess <-> {credit, evidence_tier,
  // what_would_close_it} invariants regardless of which step last touched a component (a
  // demotion, or the step-5 re-application, may move a criterion into or out of
  // cannot_assess after an earlier step already set one of these fields). ----
  return Object.keys(componentsById).map(function (critId) {
    var comp = componentsById[critId];
    if (comp.verdict === 'cannot_assess') {
      comp.credit = null;
      comp.evidence_tier = null;
      if (!comp.what_would_close_it) {
        comp.what_would_close_it = 'criterion ' + critId + ': cannot be assessed';
      }
    } else {
      comp.what_would_close_it = null;
    }
    return {
      subscorer: comp.subscorer,
      criterion_id: comp.criterion_id,
      verdict: comp.verdict,
      weight: comp.weight,
      credit: comp.credit,
      evidence_tier: comp.evidence_tier,
      claim_ids: comp.claim_ids,
      quote_verbatim: comp.quote_verbatim,
      rationale: comp.rationale,
      what_would_close_it: comp.what_would_close_it,
      demoted_by: comp.demoted_by
    };
  });
}

module.exports = { applyGate: applyGate };
