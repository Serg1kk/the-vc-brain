// SOURCE OF TRUTH: lib/f06/context.js
//
// Deterministic CONTEXT-PACK assembly for feature 06 (Investment Memo & $100K
// Decision) -- docs/backlog/06-memo-decision/plan.md task T2, design.md §3
// (the read table), §4.2 (the `gaps` shape). Zero-LLM: every field here is a
// straight read or a pure resolution rule, never a model call. This is the
// [A] node's logic (design §5) -- the section-writers ([B1]-[B4]), the
// decision node ([C], lib/f06/decision.js) and the assemble/write node ([D],
// lib/f06/assemble.js) all consume the pack this file returns, never re-read
// the DB themselves for the numbers.
//
// NO imports, NO requires -- this file's body is pasted verbatim into an n8n
// Code node (plan.md's zero-imports rule, same as lib/f04/f05's precedent).
// The ONE exception, per this task's own brief: `pg` arrives as a parameter,
// not a module-level helper -- the Code node supplies it (n8n/workflow_defs.py's
// `async function pg(method, path, body, prefer)` shape, called here with only
// `method`/`path`; this module never writes, so `body`/`prefer` never apply).
// `pg(method, path)` already resolves against `$env.SUPABASE_URL` (which
// itself already ends in `/rest/v1` -- CLAUDE.md > Commands) and returns the
// PARSED JSON body (an array for every `select` this file issues). Testable
// with a mock of that exact 2-arg shape -- see context.test.js.
//
// ============================================================================
// Design decisions this file had to resolve beyond design.md's literal text
// (flagged back to the team lead in the T2 report, not silently assumed)
// ============================================================================
//
// 1. `material_contradictions` / `fatal_contradictions` are COUNTS OF DISTINCT
//    CLAIMS, not a sum of (event + claim-derived-status) signals. design.md
//    §3.9 states the two conditions ("any derived_status='contradicted' OR any
//    event severity='material'" / "an event nature='factual' AND
//    severity='material'") without saying whether a claim satisfying BOTH
//    signals at once (the common case -- a f05/run.js `claim_contradicted`
//    event fires alongside the `contradicts` evidence row that then drives
//    claim_trust's own verdict to `contradicted`) counts once or twice.
//    Counting by distinct claim_id avoids double-counting one real-world
//    contradiction as two, which double-weighting would otherwise do to
//    decision.js's `> 0` gates (harmless there) and to `conditions.rationale`
//    prose (not harmless -- "2 material contradictions" reads worse than "1"
//    for the identical underlying fact).
// 2. `gaps.contradictions` (§4.2) is likewise deduped by claim_id, preferring
//    the EVENT's severity/nature (richer) over a claim-only entry when a claim
//    has both; a claim-only entry (documented/discovered contradiction with no
//    event, e.g. every live app today -- events are fixture-only per
//    data-contracts.md §13) gets `severity: null, nature: null` rather than a
//    fabricated guess -- honest-unknown beats invented, per I4.
// 3. `not_disclosed`'s fixed trigger set (design §4.2: "at minimum financials
//    and revenue; extended by any thesis_missing_fields / founder_score_gaps
//    topic that maps to a disclosure gap") names no canonical topic strings
//    beyond `round.cap_table` (docs/backlog/01-memory-data-model/design.md
//    §4.4's own worked example). No topic registry documents a canonical
//    "revenue" claim topic. Resolved conservatively: `financials` matches any
//    claim topic starting with `round.` (the one documented financial-topic
//    namespace) or `company.financials`; `revenue` matches any topic
//    containing the substring `revenue` (covers `traction.revenue*` without
//    inventing an exact slug this repo has not fixed). The thesis-missing-
//    fields extension is limited to the two gateable fields
//    (docs/backlog/09-investor-dashboard/data-contracts.md §7) that are
//    genuinely founder-DISCLOSURE gaps rather than derived/inferred fields --
//    `stage_evidence`, `business_model` -- deliberately NOT extended to
//    `geography_country`/`geography_region`/`stage` (those are read off the
//    company row, not a founder disclosure) or to founder_score_gaps
//    criteria (no confirmed criterion_id vocabulary to map safely without
//    fabricating a disclosure claim the founder was never asked to make).
// 4. `decision_inputs.founder_score` snapshots the FIRST row of `founders`
//    (i.e. `founders[0]`), not an average or a max computed here. This is
//    free, not a choice with a hidden tradeoff: `api_founders` is filtered by
//    `application_id=eq.<id>` with its OWN default order baked into the view
//    (`founder_score DESC NULLS LAST, full_name, founder_id` --
//    data-contracts.md §1), so `founders[0]` already IS the team's
//    highest-scored (or, if none assessed, first-alphabetically) founder,
//    with no re-sort needed here. `founder_score` is narrative/traceability
//    only (design §8) -- this snapshot never feeds the decision cascade.
// 5. `competitors` (§3.10) reads `value.name` for the competitor's display
//    name, confirmed against `per_competitor_record`
//    (docs/backlog/04-market-trend-competition/design.md §3.3) -- the design
//    table for THIS feature names only `value.company_mentioned →
//    named_by_founder` and leaves the name field unstated.
//
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// Small shared helpers (independent copy, no shared import across lib/f0*
// modules by this repo's own convention -- see lib/f05/trust.js's header).
// ----------------------------------------------------------------------------

function asArray(rows) {
  return Array.isArray(rows) ? rows : [];
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// PostgREST `in.(...)` filter value -- comma-joined, no quoting (every id
// here is a uuid, which contains no comma/paren to escape). Callers must
// still guard the empty-list case themselves: `in.()` is invalid PostgREST
// syntax, so an empty id set means "skip the read, the answer is []", never
// "issue the request anyway."
function inFilter(ids) {
  return ids.join(',');
}

// design.md §7's "resolvable router_class" -- qualitative/forecast/
// unverifiable are PINNED to `unverified` forever by claim_trust's own verdict
// CASE (data-contracts.md §4, step 2: "pinned forever"), so a claim in one of
// those three classes can never become an "ambiguous, worth a deep-dive
// question" ask -- asking about it would never resolve. Only the three
// classes that actually transition through later CASE branches are
// resolvable.
const RESOLVABLE_ROUTER_CLASSES = new Set(['factual_static', 'factual_dynamic', 'precomputed']);

function isResolvableRouterClass(routerClass) {
  return RESOLVABLE_ROUTER_CLASSES.has(routerClass);
}

// §3.10's three competition topics.
const COMPETITION_TOPICS = Object.freeze([
  'competition.competitor',
  'competition.status_quo_alternative',
  'competition.founder_claim_mismatch',
]);

// §4.2's fixed not-disclosed trigger set -- see header note 3. `matches` is a
// predicate over one claim's topic string; a trigger fires (emits its line)
// when NO claim in the pack's corpus matches it at all.
const NOT_DISCLOSED_TRIGGERS = Object.freeze([
  {
    topic: 'financials',
    text: 'Cap table: not disclosed.',
    matches: (topic) => topic.startsWith('round.') || topic.startsWith('company.financials'),
  },
  {
    topic: 'revenue',
    text: 'Revenue: not disclosed.',
    matches: (topic) => topic.indexOf('revenue') !== -1,
  },
]);

// §4.2's `thesis_missing_fields` extension -- see header note 3. Keyed by the
// exact gateable-field string thesis_missing_fields carries
// (data-contracts.md §7).
const DISCLOSURE_FIELD_MAP = Object.freeze({
  stage_evidence: { topic: 'stage_evidence', text: 'Company stage evidence: not disclosed.' },
  business_model: { topic: 'business_model', text: 'Business model: not disclosed.' },
});

// ----------------------------------------------------------------------------
// §3.2 -- three screening axes. `assessed` is read VERBATIM off the jsonb the
// view already built; this function never coerces `value` to 0 and never
// derives `assessed` from `value`'s presence (I2 -- absent ≠ zero).
// ----------------------------------------------------------------------------

function normalizeAxis(raw) {
  const axis = asPlainObject(raw);
  return {
    value: 'value' in axis ? axis.value : null,
    trend: 'trend' in axis ? axis.trend : null,
    confidence: 'confidence' in axis ? axis.confidence : null,
    missing: Array.isArray(axis.missing) ? axis.missing : [],
    assessed: axis.assessed === true,
  };
}

// ----------------------------------------------------------------------------
// §3.4 -- trust axis. No row ⇒ not assessed (never a 0 trust value). The
// documented one exception to "never parse missing_flags raw" (design §3.4) --
// only `.coverage` is read off the raw object, nothing `_`-prefixed.
// ----------------------------------------------------------------------------

function buildTrustAxis(rows) {
  const list = asArray(rows);
  if (list.length === 0) {
    return { value: null, confidence: null, coverage: null, assessed: false };
  }
  const row = list[0];
  const missingFlags = asPlainObject(row.missing_flags);
  return {
    value: row.value ?? null,
    confidence: row.confidence ?? null,
    coverage: typeof missingFlags.coverage === 'number' ? missingFlags.coverage : null,
    assessed: true,
  };
}

// ----------------------------------------------------------------------------
// §3.10 -- competition. Only `competition.competitor` claims become
// structured competitor rows (`per_competitor_record`,
// docs/backlog/04-market-trend-competition/design.md §3.3); the other two
// topics stay in `competition_claims` for [B3]'s prose.
// ----------------------------------------------------------------------------

function buildCompetitors(claims) {
  return claims
    .filter((c) => c.topic === 'competition.competitor')
    .map((c) => {
      const value = asPlainObject(c.value);
      return {
        name: typeof value.name === 'string' ? value.name : null,
        named_by_founder: value.company_mentioned === true,
        claim_ids: [c.claim_id],
      };
    });
}

// ----------------------------------------------------------------------------
// §3.9 -- contradictions. `events` (§3.9a) and claim-derived-status (§3.9b)
// are two INDEPENDENT signals over the same claim_id space; both helpers
// below dedupe to "one entry per claim" (header note 1/2).
// ----------------------------------------------------------------------------

function eventClaimId(event) {
  const payload = asPlainObject(event && event.payload);
  return payload.claim_id || null;
}

function countMaterialAndFatal(contradictionEvents, claims) {
  const materialIds = new Set();
  const fatalIds = new Set();

  for (const event of contradictionEvents) {
    const payload = asPlainObject(event.payload);
    const claimId = eventClaimId(event);
    if (!claimId) continue;
    if (payload.severity === 'material') materialIds.add(claimId);
    if (payload.nature === 'factual' && payload.severity === 'material') fatalIds.add(claimId);
  }
  // §3.9: "material = any derived_status='contradicted' ... documented-tier
  // by construction" -- source (b) has no severity/nature, so it can only
  // ever add to `material`, never to `fatal` (the conservative default).
  for (const claim of claims) {
    if (claim.derived_status === 'contradicted') materialIds.add(claim.claim_id);
  }

  return { material_contradictions: materialIds.size, fatal_contradictions: fatalIds.size };
}

// §4.2 `gaps.contradictions` -- singular `claim_id` key per entry (design §9
// step 1 calls this out explicitly: the citation gate reads this exact key).
function buildGapContradictions(contradictionEvents, claims) {
  const byClaim = new Map();
  const topicByClaimId = new Map(claims.map((c) => [c.claim_id, c.topic]));

  for (const event of contradictionEvents) {
    const claimId = eventClaimId(event);
    if (!claimId || byClaim.has(claimId)) continue;
    const payload = asPlainObject(event.payload);
    byClaim.set(claimId, {
      claim_id: claimId,
      severity: payload.severity ?? null,
      nature: payload.nature ?? null,
      topic: topicByClaimId.get(claimId) ?? null,
    });
  }

  for (const claim of claims) {
    if (claim.derived_status !== 'contradicted' && claim.derived_status !== 'partially_supported') continue;
    if (byClaim.has(claim.claim_id)) continue; // the event entry above is richer -- keep it
    byClaim.set(claim.claim_id, {
      claim_id: claim.claim_id,
      severity: null,
      nature: null,
      topic: claim.topic ?? null,
    });
  }

  return Array.from(byClaim.values());
}

// §7's "weakest assessed screening axis" -- only the three SCREENING axes
// (never trust, never founder_score -- both a different subject, §3.3/§3.4).
// null when nothing is assessed (never fabricate a weakest-of-nothing).
function weakestAssessedAxis(axes) {
  let weakest = null;
  for (const name of ['founder', 'market', 'idea_vs_market']) {
    const axis = axes[name];
    if (!axis.assessed || typeof axis.value !== 'number') continue;
    if (weakest === null || axis.value < weakest.value) weakest = { axis: name, value: axis.value };
  }
  return weakest;
}

// ----------------------------------------------------------------------------
// §4.2 -- gaps. Pure function of an already-built pack; kept separate from
// buildPack per this task's own exported-surface, and ALSO attached onto the
// pack buildPack returns (`pack.gaps`) so [D]/[B]-nodes reading the pack as
// one object see it without a second call -- design §5's [A] node
// "assembles the pack + allowed_claim_ids + gaps" as one unit.
// ----------------------------------------------------------------------------

function buildGaps(pack) {
  const claimTopics = pack.claims.map((c) => (typeof c.topic === 'string' ? c.topic : ''));

  const not_disclosed = [];
  for (const trigger of NOT_DISCLOSED_TRIGGERS) {
    if (!claimTopics.some((topic) => trigger.matches(topic))) {
      not_disclosed.push({ topic: trigger.topic, text: trigger.text });
    }
  }
  const thesisMissingSet = new Set(pack.thesis.thesis_missing_fields);
  for (const field of Object.keys(DISCLOSURE_FIELD_MAP)) {
    const entry = DISCLOSURE_FIELD_MAP[field];
    if (thesisMissingSet.has(field) && !not_disclosed.some((n) => n.topic === entry.topic)) {
      not_disclosed.push(entry);
    }
  }

  const missing_axes = [];
  if (!pack.axes.founder.assessed) missing_axes.push('founder');
  if (!pack.axes.market.assessed) missing_axes.push('market');
  if (!pack.axes.idea_vs_market.assessed) missing_axes.push('idea_vs_market');
  if (!pack.trust.assessed) missing_axes.push('trust');

  const missingFieldsSet = new Set(pack.thesis.thesis_missing_fields);
  for (const founder of pack.founders) {
    for (const gap of founder.founder_score_gaps) {
      if (gap && typeof gap.criterion_id === 'string') missingFieldsSet.add(gap.criterion_id);
    }
  }

  const low_coverage = {
    trust: typeof pack.trust.coverage === 'number' ? pack.trust.coverage : null,
    thesis: typeof pack.thesis.thesis_coverage === 'number' ? pack.thesis.thesis_coverage : null,
  };

  return {
    not_disclosed,
    missing_axes,
    missing_fields: Array.from(missingFieldsSet),
    low_coverage,
    contradictions: buildGapContradictions(pack.contradiction_events, pack.claims),
  };
}

// ============================================================================
// buildPack -- the [A] node's full body, design.md §3.1-§3.10.
// ============================================================================

async function buildPack(pg, application_id) {
  // §3.1 -- application + company. The ONLY hard error in this file; every
  // other empty-select branch below is a normal path (design §3's own framing).
  const appRows = asArray(await pg('GET', 'api_applications?application_id=eq.' + application_id));
  if (appRows.length === 0) {
    throw new Error('lib/f06/context.js: application not found: ' + application_id);
  }
  const app = appRows[0];

  // §3.2 -- three screening axes, already embedded in the api_applications row.
  const axes = {
    founder: normalizeAxis(app.score_founder),
    market: normalizeAxis(app.score_market),
    idea_vs_market: normalizeAxis(app.score_idea_vs_market),
  };

  // §3.3 -- person founder score(s). Teams have several rows for one
  // application -- ALL are kept (used again at §3.9's founder-scoped queries).
  const founderRows = asArray(await pg('GET', 'api_founders?application_id=eq.' + application_id));
  const founders = founderRows.map((f) => ({
    founder_id: f.founder_id,
    full_name: f.full_name ?? null,
    founder_score: f.founder_score ?? null,
    founder_score_trend: f.founder_score_trend ?? null,
    founder_score_confidence: f.founder_score_confidence ?? null,
    score_assessed: f.score_assessed === true,
    founder_score_gaps: Array.isArray(f.founder_score_gaps) ? f.founder_score_gaps : [],
  }));
  const founder_ids = founders.map((f) => f.founder_id).filter(Boolean);

  // §3.4 -- trust axis. `scores` has no api_* view; read the raw table directly.
  const trustRows = await pg(
    'GET',
    'scores?application_id=eq.' + application_id + '&axis=eq.trust&order=computed_at.desc,id.desc&limit=1'
  );
  const trust = buildTrustAxis(trustRows);

  // §3.5 -- thesis fit. api_applications already resolves the stale-thesis
  // trap (latest eval; score_id IS NULL / insufficient_evidence ⇒ NULL fit) --
  // used verbatim, never re-derived from `scores` (data-contracts.md §6).
  const thesis = {
    thesis_id: app.thesis_id ?? null,
    thesis_name: app.thesis_name ?? null,
    thesis_verdict: app.thesis_verdict ?? null,
    thesis_fit: app.thesis_fit ?? null,
    thesis_coverage: app.thesis_coverage ?? null,
    thesis_missing_fields: Array.isArray(app.thesis_missing_fields) ? app.thesis_missing_fields : [],
    thesis_fired_rules: Array.isArray(app.thesis_fired_rules) ? app.thesis_fired_rules : [],
  };

  // §3.6 -- claims: application-scoped UNION founder-scoped, deduped by
  // claim_id. The founder-scoped union is load-bearing (design §3.6): a
  // founder-provenance claim's card can have application_id NULL, so without
  // this union a founder-scoped contradiction (§3.9) would cite an id outside
  // `allowed_claim_ids` and the §9 citation gate would reject the whole memo.
  const appClaimRows = asArray(
    await pg('GET', 'api_claims?application_id=eq.' + application_id + '&order=created_at.desc')
  );
  const founderClaimRows = founder_ids.length
    ? asArray(await pg('GET', 'api_claims?founder_id=in.(' + inFilter(founder_ids) + ')&order=created_at.desc'))
    : [];

  const claimRowById = new Map();
  for (const row of appClaimRows.concat(founderClaimRows)) {
    if (row && row.claim_id && !claimRowById.has(row.claim_id)) claimRowById.set(row.claim_id, row);
  }
  const claimIds = Array.from(claimRowById.keys());

  // §3.7 -- per-claim trust, joined by claim_id. `derived_status` is
  // authoritative (never `claims.verification_status` -- that column is
  // stored and stale, data-contracts.md §3/§4).
  const claimTrustRows = claimIds.length
    ? asArray(await pg('GET', 'claim_trust?claim_id=in.(' + inFilter(claimIds) + ')'))
    : [];
  const trustByClaimId = new Map(claimTrustRows.map((row) => [row.claim_id, row]));

  const claims = claimIds.map((claimId) => {
    const claimRow = claimRowById.get(claimId);
    const trustRow = trustByClaimId.get(claimId) || null;
    return {
      claim_id: claimId,
      founder_id: claimRow.founder_id ?? null,
      company_id: claimRow.company_id ?? null,
      application_id: claimRow.application_id ?? null,
      topic: claimRow.topic,
      axis: claimRow.axis ?? null,
      text_verbatim: claimRow.text_verbatim,
      value: claimRow.value ?? null,
      source_kind: claimRow.source_kind,
      evidence: Array.isArray(claimRow.evidence) ? claimRow.evidence : [],
      derived_status: trustRow ? trustRow.derived_status : null,
      router_class: trustRow ? trustRow.router_class : null,
      trust: trustRow ? trustRow.trust : null,
      n_contradicts: trustRow ? trustRow.n_contradicts : null,
      n_independent: trustRow ? trustRow.n_independent : null,
    };
  });
  // §3.6: allowed_claim_ids is the SUPERSET -- everything §3.9/§8/deep-dive
  // questions can ever cite, independent of whichever subset a section-writer
  // actually used.
  const allowed_claim_ids = claimIds.slice();

  // §3.9 -- contradictions. Query BOTH entity shapes (company claims are
  // written under entity_type='founder' too -- data-contracts.md §8's own
  // warning), covering all co-founders.
  const eventsFounderScoped = founder_ids.length
    ? asArray(
        await pg(
          'GET',
          'events?event_type=eq.claim_contradicted&entity_type=eq.founder&entity_id=in.(' + inFilter(founder_ids) + ')'
        )
      )
    : [];
  const eventsApplicationScoped = asArray(
    await pg(
      'GET',
      'events?event_type=eq.claim_contradicted&entity_type=eq.application&entity_id=eq.' + application_id
    )
  );
  const eventIds = new Set();
  const contradiction_events = [];
  for (const event of eventsFounderScoped.concat(eventsApplicationScoped)) {
    if (!event || (event.id && eventIds.has(event.id))) continue;
    if (event.id) eventIds.add(event.id);
    contradiction_events.push(event);
  }

  const { material_contradictions, fatal_contradictions } = countMaterialAndFatal(contradiction_events, claims);

  // §3.10 -- competition.
  const competition_claims = claims.filter((c) => COMPETITION_TOPICS.indexOf(c.topic) !== -1);
  const competitors = buildCompetitors(competition_claims);

  // §7's per-agent slices -- ambiguous claims (deep-dive candidates) and the
  // weakest assessed screening axis.
  const ambiguous_claims = claims.filter(
    (c) =>
      (c.derived_status === 'unverified' || c.derived_status === 'partially_supported') &&
      isResolvableRouterClass(c.router_class)
  );
  const weakest_assessed_axis = weakestAssessedAxis(axes);

  // Trimmed slice for the LLM section-writers (design §6's input list) --
  // token-budget-conscious, never carries `evidence`/founder_id/company_id.
  const claims_for_writers = claims.map((c) => ({
    claim_id: c.claim_id,
    topic: c.topic,
    text_verbatim: c.text_verbatim,
    value: c.value,
    source_kind: c.source_kind,
    derived_status: c.derived_status,
    router_class: c.router_class,
  }));

  // §8's decision-node input shape -- snapshotted here so [C] can read it off
  // `$('Context pack')` without re-deriving anything (design §5.1).
  const decision_inputs = {
    thesis_verdict: thesis.thesis_verdict,
    thesis_fit: thesis.thesis_fit,
    thesis_fired_rules: thesis.thesis_fired_rules,
    axes: {
      founder: { value: axes.founder.value, assessed: axes.founder.assessed },
      market: { value: axes.market.value, assessed: axes.market.assessed },
      idea_vs_market: { value: axes.idea_vs_market.value, assessed: axes.idea_vs_market.assessed },
    },
    trust: { value: trust.value, assessed: trust.assessed, coverage: trust.coverage, confidence: trust.confidence },
    // Decision-inert, narrative/traceability only (design §8) -- see header
    // note 4 for why `founders[0]` alone is the correct snapshot.
    founder_score: {
      value: founders.length ? founders[0].founder_score : null,
      assessed: founders.length ? founders[0].score_assessed : false,
    },
    material_contradictions,
    fatal_contradictions,
  };

  const pack = {
    application_id,
    company_id: app.company_id ?? null,
    company_name: app.company_name ?? null,
    company_domain: app.company_domain ?? null,
    stage: app.stage ?? null,
    category: app.category ?? null,
    kind: app.kind ?? null,
    status: app.status ?? null,
    submitted_at: app.submitted_at ?? null,
    artifact_links: app.artifact_links && typeof app.artifact_links === 'object' ? app.artifact_links : {},
    is_synthetic: app.is_synthetic === true,
    memo_version: app.memo_version ?? null,
    memo_available: app.memo_available === true,

    axes,
    founders,
    founder_ids,
    trust,
    thesis,

    claims,
    allowed_claim_ids,
    claims_for_writers,

    contradiction_events,
    material_contradictions,
    fatal_contradictions,

    competitors,
    competition_claims,

    ambiguous_claims,
    weakest_assessed_axis,

    decision_inputs,
  };

  // gaps is a pure function of the pack -- computed last, attached here so a
  // caller reading `pack` whole (design §5's [A] node contract) sees it
  // without a second call, while buildGaps() stays independently callable
  // (this task's own exported-surface requirement) and independently testable.
  pack.gaps = buildGaps(pack);

  return pack;
}

module.exports = {
  buildPack,
  buildGaps,
  normalizeAxis,
  buildTrustAxis,
  buildCompetitors,
  countMaterialAndFatal,
  buildGapContradictions,
  weakestAssessedAxis,
  isResolvableRouterClass,
  RESOLVABLE_ROUTER_CLASSES,
  COMPETITION_TOPICS,
  NOT_DISCLOSED_TRIGGERS,
  DISCLOSURE_FIELD_MAP,
};
