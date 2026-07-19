// lib/f10/plan.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Stage 2 (first half) of feature 10's NL-search: validates the query plan
// emitted by the resolver LLM (docs/backlog/10-api-cli-skill/agents/
// nl-search-resolver/nl-search-resolver-agent-json-schema.json) and maps
// every attribute the plan keeps to a PostgREST query DESCRIPTOR -- data
// describing a read (resource + filters + order), never a fetch. Zero
// dependency, zero I/O, zero network -- matches lib/f07/rules.js's shape
// ("the model classifies, the backend decides", design.md §5.1) and
// lib/f02/normalize.js's zero-import convention.
//
// Authoritative source for every rule below: docs/backlog/10-api-cli-skill/
// design.md rev.4, sections cited inline. This file does not restate the
// resolver's own output contract -- see the JSON schema above for that.
//
// "The resolver is trusted to be helpful, never to be correct" (tbd-items.md
// D-07): every field this module receives is re-validated against the
// documented taxonomy (§5.3) and, when supplied, the live catalogue
// (nl-search-resolver-agent-input-spec.md) -- an attribute this module
// cannot place inside that taxonomy is REJECTED (`invalid_target`), never
// guessed into the nearest-looking descriptor.
//
// docs/backlog/10-api-cli-skill/plan.md, task B1.

'use strict';

const { WEIGHTS } = require('./constants');

// ============================================================================
// Small shared helpers (same shape as lib/f07/rules.js's isPlainObject/numOr)
// ============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const ATTRIBUTE_ID_RE = /^[a-z][a-z0-9_]{1,47}$/;
const ISO_ALPHA2_RE = /^[A-Za-z]{2}$/;

const KIND_VALUES = Object.freeze(['provenance', 'structural']);
const POLARITY_VALUES = Object.freeze(['positive', 'negative']);
const TARGET_TYPE_VALUES = Object.freeze(['claim_topic', 'metric', 'column', 'fts']);
const OP_VALUES = Object.freeze(['exists', 'eq', 'contains', 'gte', 'lte', 'not_exists']);
const BROADENING_VALUES = Object.freeze(['city→country', 'country→region', 'specific→family']);
const UNRESOLVABLE_REASON_VALUES = Object.freeze(['no_data_source', 'not_testable', 'out_of_scope']);
const VALUE_REQUIRED_OPS = Object.freeze(['eq', 'contains', 'gte', 'lte']);

// ============================================================================
// §5.3 -- the documented target taxonomy, kind by kind. THIS BUILD SUPPORTS
// TWO KINDS ONLY (constants.js). Table straight from §5.3's "resolves
// against" column:
//
//   provenance -> claims.topic under founder.expertise.* / founder.execution.*
//                 / founder.leadership.*
//   structural -> company.sector / company.geography_country claims +
//                 companies.stage column; NOT hq_country/location_*, which
//                 are empty (§4.0)
//
// `metric` (velocity's target type) and `fts` (text's) have NO descriptor
// branch in this build -- both attribute kinds that would have used them are
// cut (rev.4). A plan that emits `target.type: "metric"` or `"fts"` for a
// `provenance`/`structural` attribute is outside the documented taxonomy
// exactly as much as an unrecognised claim topic would be -- `invalid_target`,
// never a silent no-op descriptor.
// ============================================================================

const PROVENANCE_TOPIC_PREFIXES = Object.freeze([
  'founder.expertise.',
  'founder.execution.',
  'founder.leadership.',
]);

// The two structural claim topics the corpus actually carries (§4.0) --
// deliberately an exact allow-list, not a prefix: unlike provenance's three
// families, structural has no sub-topic fan-out to glob over.
const STRUCTURAL_TOPICS = Object.freeze(['company.sector', 'company.geography_country']);

// companies.stage is the one structural COLUMN target this build documents
// (§5.3's "resolves against" cell). hq_country / location_* are explicitly
// EXCLUDED even though they are syntactically columns too -- §4.0 measured
// them at 0 filled, and the JSON schema's own note ("column is permitted
// only when catalogue.structural_fields reports filled > 0") would reject
// them anyway once a catalogue is supplied; naming them here up front means
// the deny is documented, not merely incidental to a live measurement.
const STRUCTURAL_COLUMNS = Object.freeze(['companies.stage']);

// Closed-vocabulary claim topics whose `value` (on `eq`) must come from a
// fixed set (lib/f07/vocabulary.js, per the JSON schema's "eq on a
// closed-vocabulary target" note). `company.geography_country` is
// deliberately absent -- vocabulary.js documents it as open-ended
// (ISO-3166-1 alpha-2), checked by shape instead, below.
const CLOSED_VOCAB_TOPICS = Object.freeze({
  'company.sector': 'sector',
});

// ============================================================================
// Catalogue normalisation -- accepts the EXACT shape
// nl-search-resolver-agent-input-spec.md documents (arrays of
// `{topic, rows}` / `{field, filled, total}`), which is what the n8n
// workflow's "build resolver input" Code node actually produces and what
// this executor receives verbatim (the same catalogue object, not a
// re-derived one -- D-07: "executor re-validates every target against the
// SAME catalogue"). Catalogue is OPTIONAL here: when omitted, taxonomy
// checks (above) still run, but existence/zero-row checks that need live
// counts are skipped -- callers that omit it get the documented-taxonomy
// guarantee without the live-corpus guarantee, which is enough for a unit
// test fixture and not enough for production (the n8n workflow always
// supplies one).
// ============================================================================

function normalizeCatalogue(catalogue) {
  if (!isPlainObject(catalogue)) return null;

  const topics = new Map(); // topic string -> rows (number)
  if (Array.isArray(catalogue.claim_topics)) {
    for (const entry of catalogue.claim_topics) {
      if (isPlainObject(entry) && isNonEmptyString(entry.topic) && typeof entry.rows === 'number') {
        topics.set(entry.topic, entry.rows);
      }
    }
  }

  const fields = new Map(); // field string -> { filled, total }
  if (Array.isArray(catalogue.structural_fields)) {
    for (const entry of catalogue.structural_fields) {
      if (isPlainObject(entry) && isNonEmptyString(entry.field)) {
        fields.set(entry.field, {
          filled: typeof entry.filled === 'number' ? entry.filled : 0,
          total: typeof entry.total === 'number' ? entry.total : 0,
        });
      }
    }
  }

  const vocabularies = isPlainObject(catalogue.vocabularies) ? catalogue.vocabularies : {};

  return { topics, fields, vocabularies };
}

// rows in `topic family` -- exact topic: its own row count (0 if the
// catalogue does not carry it at all -- see `topicKnown` below for the
// separate "is this a recognised topic" question). Family glob (ends in
// `.*`): sum of every catalogue topic sharing the prefix.
function familyRowCount(cat, topicValue) {
  if (!cat) return null; // "unknown" -- caller must not treat this as zero
  if (topicValue.endsWith('.*')) {
    const prefix = topicValue.slice(0, -1); // keep the trailing dot
    let sum = 0;
    let sawAny = false;
    for (const [topic, rows] of cat.topics) {
      if (topic.startsWith(prefix)) {
        sum += rows;
        sawAny = true;
      }
    }
    return sawAny ? sum : 0;
  }
  return cat.topics.has(topicValue) ? cat.topics.get(topicValue) : 0;
}

// "Recognised" is deliberately SEPARATE from "has rows right now" (D-03 /
// §5.4 rule 3): a topic the catalogue lists with `rows: 0` is a KNOWN part
// of the taxonomy that currently has no data (-> the global short-circuit,
// `unresolvable`/`no_data_source`, handled by the caller of this function);
// a topic the catalogue never mentions at all is not part of the taxonomy
// this executor recognises (-> `invalid_target`). When no catalogue was
// supplied, every taxonomy-shaped topic is treated as recognised (permissive
// mode, documented at the top of this section).
function topicRecognised(cat, topicValue) {
  if (!cat) return true;
  if (topicValue.endsWith('.*')) {
    const prefix = topicValue.slice(0, -1);
    for (const topic of cat.topics.keys()) {
      if (topic.startsWith(prefix)) return true;
    }
    return false;
  }
  return cat.topics.has(topicValue);
}

// ============================================================================
// Target-taxonomy validation. Returns `{ ok: true, family: bool }` or
// `{ ok: false, reason: '<human-readable, names the attribute>' }`. Never
// throws -- callers turn a `{ ok: false }` into the `invalid_target` error
// envelope.
// ============================================================================

function validateTarget(attr, cat) {
  const { kind, target } = attr;
  const type = target.type;
  const value = target.value;

  if (kind === 'provenance') {
    if (type !== 'claim_topic') {
      return { ok: false, reason: `attribute "${attr.id}": kind "provenance" only resolves against claim_topic targets in this build (got "${type}")` };
    }
    const isFamily = value.endsWith('.*');
    // Family form: base (the value with its trailing '*' stripped, dot kept,
    // e.g. "founder.expertise.") must EQUAL one of the declared prefixes
    // exactly -- "founder.expertise." IS the family root, there is nothing
    // "after" it to require. Exact form: value must extend PAST one of the
    // prefixes (a real sub-topic, e.g. "founder.execution.live_product"),
    // not equal the bare prefix itself.
    const base = isFamily ? value.slice(0, -1) : value;
    const prefixOk = isFamily
      ? PROVENANCE_TOPIC_PREFIXES.includes(base)
      : PROVENANCE_TOPIC_PREFIXES.some((p) => base.startsWith(p) && base.length > p.length);
    if (!prefixOk) {
      return { ok: false, reason: `attribute "${attr.id}": claim_topic "${value}" is not under founder.expertise.* / founder.execution.* / founder.leadership.*` };
    }
    if (!topicRecognised(cat, value)) {
      return { ok: false, reason: `attribute "${attr.id}": claim_topic "${value}" is not in the live catalogue` };
    }
    return { ok: true, family: isFamily };
  }

  // kind === 'structural'
  if (type === 'claim_topic') {
    if (!STRUCTURAL_TOPICS.includes(value)) {
      return { ok: false, reason: `attribute "${attr.id}": claim_topic "${value}" is not a documented structural topic (only ${STRUCTURAL_TOPICS.join(', ')})` };
    }
    if (!topicRecognised(cat, value)) {
      return { ok: false, reason: `attribute "${attr.id}": claim_topic "${value}" is not in the live catalogue` };
    }
    const vocabKey = CLOSED_VOCAB_TOPICS[value];
    if (vocabKey && attr.op === 'eq') {
      const allowed = cat && Array.isArray(cat.vocabularies[vocabKey]) ? cat.vocabularies[vocabKey] : null;
      if (allowed && !allowed.includes(attr.value)) {
        return { ok: false, reason: `attribute "${attr.id}": value "${attr.value}" is not in catalogue.vocabularies.${vocabKey}` };
      }
    }
    if (value === 'company.geography_country' && attr.op === 'eq' && !ISO_ALPHA2_RE.test(String(attr.value))) {
      return { ok: false, reason: `attribute "${attr.id}": geography_country value "${attr.value}" is not an ISO-3166-1 alpha-2 code` };
    }
    return { ok: true, family: false };
  }

  if (type === 'column') {
    if (!STRUCTURAL_COLUMNS.includes(value)) {
      return { ok: false, reason: `attribute "${attr.id}": column "${value}" is not a documented structural column (only ${STRUCTURAL_COLUMNS.join(', ')})` };
    }
    if (cat) {
      const field = cat.fields.get(value);
      const filled = field ? field.filled : 0;
      if (!(filled > 0)) {
        return { ok: false, reason: `attribute "${attr.id}": column "${value}" has 0 filled rows in the live catalogue -- not a viable target` };
      }
    }
    return { ok: true, family: false };
  }

  // type === 'metric' | 'fts' -- both cut from this build (§5.3 changelog:
  // "velocity and text kinds CUT"); metric/fts descriptors do not exist here.
  return { ok: false, reason: `attribute "${attr.id}": target.type "${type}" has no descriptor in this build (velocity/text kinds are cut)` };
}

// ============================================================================
// Descriptor construction. A descriptor is DATA -- { resource, select,
// filters, order } -- consumed by the n8n workflow's HTTP Request nodes
// (§5.1: "n8n Code nodes cannot require() from this repo"; the workflow
// itself does the fetching). This module never issues a request.
//
// `topic` filters ride PostgREST's `like` operator UNCHANGED for a family
// value: PostgREST's `like.<pattern>` already treats `*` as SQL `%`, and a
// family value already ends in literal `.*` (e.g. "founder.expertise.*"),
// so "founder.expertise.*" is *already* a valid `like` pattern with no
// translation needed -- documented here so a future reader does not "fix"
// it into a regex.
// ============================================================================

const CLAIM_SELECT = 'claim_id,card_id,founder_id,company_id,application_id,topic,axis,text_verbatim,value,source_kind,base_confidence,verification_status,created_at,evidence';

function buildDescriptor(attr, isFamily) {
  const { target } = attr;

  if (target.type === 'claim_topic') {
    return {
      resource: 'api_claims',
      select: CLAIM_SELECT,
      filters: [{ column: 'topic', op: isFamily ? 'like' : 'eq', value: target.value }],
      order: [{ column: 'founder_id', dir: 'asc' }],
    };
  }

  // target.type === 'column' (companies.stage today). The n8n workflow is
  // responsible for the founder_company join back to a founder-subject row
  // (§5.2: results are founder-subject) -- not fully specified by design.md
  // for this path (flagged in the B1 report: no worked example ever uses
  // target.type:'column', Q1/Q2 do not exercise it, so the founder-linkage
  // step has no measured shape to copy). The descriptor still names the
  // source table plainly rather than guessing a join.
  const [table, column] = target.value.split('.');
  return {
    resource: table, // 'companies' -- raw table, no api_* view carries a bare column-only read for this
    select: `id,${column}`,
    filters: [{ column, op: attr.op === 'eq' ? 'eq' : attr.op, value: attr.value }],
    order: [{ column: 'id', dir: 'asc' }],
  };
}

// ============================================================================
// Attribute shape validation -- the JSON schema's structural rules
// (nl-search-resolver-agent-json-schema.json `definitions.attribute`),
// re-checked here because "the resolver is trusted to be helpful, never to
// be correct" (D-07) covers shape, not only target semantics.
// ============================================================================

function validateAttributeShape(attr, seenIds) {
  if (!isPlainObject(attr)) return 'attribute is not an object';
  if (!ATTRIBUTE_ID_RE.test(attr.id)) return `attribute id "${attr.id}" does not match ^[a-z][a-z0-9_]{1,47}$`;
  if (seenIds.has(attr.id)) return `attribute id "${attr.id}" is duplicated -- ids must be unique within the plan`;
  if (!isNonEmptyString(attr.label) || attr.label.length > 120) return `attribute "${attr.id}": label must be 1-120 chars`;
  if (!KIND_VALUES.includes(attr.kind)) return `attribute "${attr.id}": kind "${attr.kind}" is not one of ${KIND_VALUES.join(', ')}`;
  if (!POLARITY_VALUES.includes(attr.polarity)) return `attribute "${attr.id}": polarity "${attr.polarity}" is not one of ${POLARITY_VALUES.join(', ')}`;
  if (!isPlainObject(attr.target) || !TARGET_TYPE_VALUES.includes(attr.target.type) || !isNonEmptyString(attr.target.value) || attr.target.value.length > 120) {
    return `attribute "${attr.id}": target is malformed`;
  }
  if (!OP_VALUES.includes(attr.op)) return `attribute "${attr.id}": op "${attr.op}" is not one of ${OP_VALUES.join(', ')}`;
  if (attr.polarity === 'negative' && attr.op !== 'not_exists') {
    return `attribute "${attr.id}": polarity "negative" requires op "not_exists" (got "${attr.op}")`;
  }
  if (VALUE_REQUIRED_OPS.includes(attr.op) && (attr.value === undefined || attr.value === null)) {
    return `attribute "${attr.id}": op "${attr.op}" requires a value`;
  }
  if (attr.value !== undefined && !['string', 'number'].includes(typeof attr.value)) {
    return `attribute "${attr.id}": value must be a string or number`;
  }
  if (attr.broadening !== undefined) {
    if (!BROADENING_VALUES.includes(attr.broadening)) {
      return `attribute "${attr.id}": broadening "${attr.broadening}" is not one of the documented widenings`;
    }
    if (!isNonEmptyString(attr.resolved_as)) {
      return `attribute "${attr.id}": broadening is set but resolved_as is missing (required whenever broadening is present)`;
    }
  }
  if (attr.resolved_as !== undefined && (typeof attr.resolved_as !== 'string' || attr.resolved_as.length > 160)) {
    return `attribute "${attr.id}": resolved_as must be a string of at most 160 chars`;
  }
  // target.type === 'fts' is never valid for a negative attribute (JSON
  // schema note, restated in D-03/§5.4 rule 2 -- negatives never touch FTS).
  // NOT re-checked here: `fts` has no descriptor at ALL in this build,
  // positive or negative (velocity/text kinds are cut, §5.3), so
  // validateTarget() below rejects every fts target uniformly with
  // `invalid_target` -- a single rejection path is a stronger guarantee
  // than a shape-only special case for the negative subset, and this is
  // the literal test case §9 asks for ("negative never reaches FTS").
  return null; // shape OK
}

function validateUnresolvableShape(item) {
  if (!isPlainObject(item)) return 'unresolvable item is not an object';
  if (!isNonEmptyString(item.label) || item.label.length > 120) return 'unresolvable item: label must be 1-120 chars';
  if (!UNRESOLVABLE_REASON_VALUES.includes(item.reason)) return `unresolvable item "${item.label}": reason "${item.reason}" is not one of ${UNRESOLVABLE_REASON_VALUES.join(', ')}`;
  return null;
}

// ============================================================================
// Error envelope -- §5.7's shape, reused here rather than invented fresh
// (the webhook, the CLI and this module all speak the same envelope).
// ============================================================================

function errorEnvelope(kind, message, opts) {
  const o = opts || {};
  return {
    ok: false,
    error: {
      kind,
      message,
      hint: o.hint || null,
      retryable: o.retryable === true,
    },
  };
}

// ============================================================================
// validatePlan(rawPlan, catalogue) -- the module's one entry point.
//
// Returns EITHER:
//   { ok: true, plan: { attributes: [...compiled...], unresolvable: [...] } }
// OR:
//   { ok: false, error: { kind, message, hint, retryable } }
//
// Design note on granularity (flagged in the B1 report as an interpretation
// call design.md leaves implicit): `invalid_target` and the other structural
// error kinds are WHOLE-PLAN rejections, not a per-attribute soft-degrade.
// §5.7 defines the error envelope at the webhook/request level
// (`{ "error": { "kind", ... } }`), and `unresolvable[]` is the plan's OWN,
// separate, always-succeeding channel for "the resolver correctly declined
// to map this fragment" (D-04). An attribute the resolver DID try to map,
// but to something outside the taxonomy, is a stronger signal that the
// resolver mis-fired -- rejecting the whole plan (retryable: true is NOT set
// for invalid_target -- §5.7's table marks it non-retryable, since retrying
// without changing the prompt/catalogue would reproduce the same mistake)
// surfaces that rather than silently dropping one attribute and returning a
// plan the caller never asked for.
// ============================================================================

function validatePlan(rawPlan, catalogue) {
  if (!isPlainObject(rawPlan)) {
    return errorEnvelope('resolver_failed', 'resolver output is not a JSON object', { retryable: true });
  }

  // The resolver's error-shape branch (JSON schema `definitions.error`).
  if (rawPlan.error_code !== undefined) {
    if (rawPlan.error_code === 'empty_query') {
      return errorEnvelope('empty_query', rawPlan.message || 'query was empty or whitespace only', { retryable: false });
    }
    // 'no_catalogue' is the schema's other declared error_code. §5.7's table
    // has no dedicated kind for it (a documented gap -- flagged in the B1
    // report); 'resolver_failed' is the closest existing kind and is
    // retryable (a fresh catalogue build on the next call may succeed).
    return errorEnvelope('resolver_failed', rawPlan.message || `resolver reported error_code "${rawPlan.error_code}"`, { retryable: true });
  }

  if (!Array.isArray(rawPlan.attributes) || !Array.isArray(rawPlan.unresolvable)) {
    return errorEnvelope('resolver_failed', 'plan is missing attributes[] or unresolvable[]', { retryable: true });
  }
  if (rawPlan.attributes.length > 12 || rawPlan.unresolvable.length > 12) {
    return errorEnvelope('resolver_failed', 'plan exceeds the 12-item cap on attributes[] or unresolvable[]', { retryable: true });
  }

  const cat = normalizeCatalogue(catalogue);
  const seenIds = new Set();
  const compiledAttributes = [];
  const unresolvable = [];

  for (const item of rawPlan.unresolvable) {
    const shapeError = validateUnresolvableShape(item);
    if (shapeError) return errorEnvelope('resolver_failed', shapeError, { retryable: true });
    unresolvable.push({ label: item.label, reason: item.reason });
  }

  for (const attr of rawPlan.attributes) {
    const shapeError = validateAttributeShape(attr, seenIds);
    if (shapeError) return errorEnvelope('resolver_failed', shapeError, { retryable: true });
    seenIds.add(attr.id);

    const targetCheck = validateTarget(attr, cat);
    if (!targetCheck.ok) {
      return errorEnvelope('invalid_target', targetCheck.reason, { retryable: false });
    }

    // §5.4 rule 3, global short-circuit -- negative-only, catalogue-only
    // (permissive/skipped when no catalogue was supplied, documented above
    // normalizeCatalogue()). A topic the catalogue KNOWS about but that
    // currently has zero rows anywhere in the corpus can never produce a
    // trustworthy NOT EXISTS -- promote to unresolvable instead of
    // fabricating a match for every candidate (D-03; the exact defect this
    // build exists to avoid).
    if (attr.polarity === 'negative' && cat) {
      const rows = familyRowCount(cat, attr.target.value);
      if (rows === 0) {
        unresolvable.push({ label: attr.label, reason: 'no_data_source' });
        continue; // NOT added to compiledAttributes -- promoted, not kept
      }
    }

    const descriptor = buildDescriptor(attr, targetCheck.family);
    compiledAttributes.push({
      id: attr.id,
      label: attr.label,
      kind: attr.kind,
      polarity: attr.polarity,
      target: { type: attr.target.type, value: attr.target.value },
      op: attr.op,
      value: attr.value !== undefined ? attr.value : null,
      broadening: attr.broadening || null,
      resolved_as: attr.resolved_as || null,
      weight: WEIGHTS[attr.kind],
      descriptor,
    });
  }

  return { ok: true, plan: { attributes: compiledAttributes, unresolvable } };
}

module.exports = {
  ATTRIBUTE_ID_RE,
  KIND_VALUES,
  POLARITY_VALUES,
  TARGET_TYPE_VALUES,
  OP_VALUES,
  PROVENANCE_TOPIC_PREFIXES,
  STRUCTURAL_TOPICS,
  STRUCTURAL_COLUMNS,
  normalizeCatalogue,
  familyRowCount,
  topicRecognised,
  validateTarget,
  buildDescriptor,
  validatePlan,
};
