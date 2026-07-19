// lib/f05/router.js
// SOURCE OF TRUTH: lib/f05/router.js -- do not edit inside the n8n Code node, edit here and
// re-paste.
//
// Claim router for feature 05 (Truth-Gap Check & Trust Score). Implements design.md §4 /
// §4.1: "every claim is assigned exactly one class before any verdict model runs" -- the
// decision "this claim cannot honestly bear a verdict" is made by an auditable table, not by
// a model's softmax. This file is the table lookup; §5's four verification branches and §7.1's
// view-level gate are what actually act on the class it returns.
//
// docs/backlog/05-truth-gap-trust/plan.md, task A2.
//
// Self-contained CommonJS, ZERO imports, no top-level side effects, deterministic (no
// Date.now(), no Math.random()). This file's body is pasted verbatim into an n8n Code node --
// n8n's sandbox cannot require() from the repo (no bind-mount, design §11) -- so any import
// here would make it unusable in production.
//
// ============================================================================
// The module exports NO built-in prefix map. Design §4.1: the authoritative copy lives in the
// score_formulas('trust_v1','trust') seed row's config.router, so a second hardcoded copy here
// would silently drift from it. The caller (the headless runner, or the n8n ROUTE Code node)
// reads that row and passes it in as `routerConfig` below.
//
// routerConfig shape -- verbatim db/seed.sql `score_formulas.config.router` (design §4.1):
//
//   {
//     prefix_map: [
//       { prefix: "founder.execution.provenance", class: "factual_static", check: "gh_provenance" },
//       { prefix: "founder.execution.",           class: "factual_static" },   // no check hint
//       ...
//     ],
//     default_class: "unverifiable"
//   }
//
// `check` is optional per entry -- absent on catch-all rows and on classes design §4 marks
// "n/a" (e.g. precomputed). `default_class` is read from routerConfig, not hardcoded, so a
// future revision of the seed row governs the fail-safe path too; the literal 'unverifiable'
// below is only the same-shape fallback design §7.5 uses elsewhere for a missing config row
// (LEFT JOIN + literal fallback, not a second source of truth).
// ============================================================================

'use strict';

// design §4: "Six class names, one vocabulary". This is the fixed OUTPUT enum the design
// itself defines (not routing data, so it does not carry the drift risk §4.1 warns about --
// unlike the prefix map, it cannot be re-seeded independently of a design revision). Used only
// to reject a malformed prefix_map entry's `class`; matches lib/f03/gate.js's VALID_VERDICTS
// pattern of validating against a design-fixed enum.
var VALID_CLASSES = [
  'factual_static',
  'factual_dynamic',
  'qualitative',
  'forecast',
  'unverifiable',
  'precomputed'
];

var FALLBACK_DEFAULT_CLASS = 'unverifiable';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeWarn(msg) {
  // Malformed prefix_map entries are dropped and logged, never allowed to silently misroute --
  // console is a sandbox global, not an import (same guard as lib/f03/gate.js).
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[f05/router] ' + msg);
    }
  } catch (_e) { /* logging must never break the router */ }
}

// Longest-prefix match of `topic` against `routerConfig.prefix_map`. Ties (two entries of
// equal, maximal prefix length) resolve to whichever appears first in the array -- the design's
// table has no duplicate-length collisions among its own rows, so this only matters for a
// malformed or hand-edited map.
function findLongestMatch(topic, prefixMap) {
  var best = null;
  for (var i = 0; i < prefixMap.length; i++) {
    var entry = prefixMap[i];
    if (!isPlainObject(entry)) continue;
    if (typeof entry.prefix !== 'string' || entry.prefix.length === 0) continue;
    if (VALID_CLASSES.indexOf(entry.class) === -1) {
      safeWarn('prefix_map entry "' + entry.prefix + '" has unknown class "' + entry.class + '"; skipped');
      continue;
    }
    if (topic.indexOf(entry.prefix) !== 0) continue; // topic does not start with this prefix
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best;
}

// routeClaimTopic(topic, routerConfig) -> {
//   class:          one of VALID_CLASSES,
//   check:          the matched entry's check hint, or null,
//   matched_prefix: the winning prefix string, or null when nothing matched,
//   unmatched_topic: true when `topic` matched no prefix_map entry and default_class was used
// }
//
// `unmatched_topic` is the fail-safe-not-fail-silent signal design §4.1 requires: the router
// itself does not write events (pure function, no I/O), but this flag is what the caller
// (design §9) uses to emit a `router_unmatched_topic` event -- without it an unrecognised
// factual topic degrades into a permanent silent gap with no signal that the router simply
// did not know it (design §4.1's `founder.execution.tech` near-miss is exactly this failure
// mode, one layer up: a topic that DOES match, but only via a catch-all, must not be confused
// with one that matches nothing at all).
function routeClaimTopic(topic, routerConfig) {
  var topicStr = typeof topic === 'string' ? topic : '';
  var cfg = isPlainObject(routerConfig) ? routerConfig : {};
  var prefixMap = Array.isArray(cfg.prefix_map) ? cfg.prefix_map : [];
  var defaultClass = (typeof cfg.default_class === 'string' && cfg.default_class)
    ? cfg.default_class
    : FALLBACK_DEFAULT_CLASS;

  var match = topicStr ? findLongestMatch(topicStr, prefixMap) : null;

  if (match) {
    return {
      class: match.class,
      check: match.check != null ? match.check : null,
      matched_prefix: match.prefix,
      unmatched_topic: false
    };
  }

  return {
    class: defaultClass,
    check: null,
    matched_prefix: null,
    unmatched_topic: true
  };
}

// routeClaims(claims, routerConfig) -> [ { claim_id, topic, class, check, matched_prefix,
//   unmatched_topic }, ... ]
//
// Convenience batch wrapper over routeClaimTopic for the n8n ROUTE Code node (design §11:
// "card's claims -> ROUTE (Code node, deterministic table) -> 4 branches"), which routes every
// claim on a card in one pass. `claims` elements need only a `topic` field; `claim_id` is
// echoed through when present so the caller can re-attach the routing decision without a
// second join. Order is preserved; claims failing to normalize a topic still get a row (routed
// via `unmatched_topic`), matching the "fail-safe, not fail-silent" rule -- no claim is ever
// silently dropped from the routing pass.
function routeClaims(claims, routerConfig) {
  var list = Array.isArray(claims) ? claims : [];
  return list.map(function (claim) {
    var topic = (isPlainObject(claim) && typeof claim.topic === 'string') ? claim.topic : '';
    var routed = routeClaimTopic(topic, routerConfig);
    return {
      claim_id: isPlainObject(claim) && claim.claim_id != null ? claim.claim_id : null,
      topic: topic,
      class: routed.class,
      check: routed.check,
      matched_prefix: routed.matched_prefix,
      unmatched_topic: routed.unmatched_topic
    };
  });
}

module.exports = {
  routeClaimTopic: routeClaimTopic,
  routeClaims: routeClaims
};
