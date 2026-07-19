// lib/f07/run.test.js
//
// Tests for the PURE helpers in lib/f07/run.js (feature 07, Thesis Engine,
// Stage B, task B4): CLI parsing, the deterministic validator, attribute/
// claim-plan building, and the strict-schema stripper. Run with:
// node --test lib/f07/run.test.js
//
// What is NOT tested here, and why: `runGate()` itself (network -- Supabase
// PostgREST + optionally OpenAI), `makePg()`'s actual fetch behaviour, and
// `callExtractorLive()`. Those require live infrastructure/credits and are
// exercised manually against `--recorded` fixtures instead (see this file's
// report to the team lead for the manual run performed).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  loadRecordedExtraction,
  validateExtraction,
  buildAttributesFromExtraction,
  buildClaimPlan,
  stripUnsupportedSchemaKeywords,
} = require('./run');

// ============================================================================
// parseArgs
// ============================================================================

describe('parseArgs', () => {
  test('application_id alone with neither flag -> throws (live mode needs --gate-text; 07 has no deck parser)', () => {
    assert.throws(() => parseArgs(['node', 'run.js', 'app-1']), /--gate-text/);
  });
  test('--recorded <dir> alone is sufficient (--gate-text is optional in recorded mode)', () => {
    const parsed = parseArgs(['node', 'run.js', 'app-1', '--recorded', '/tmp/fixtures']);
    assert.equal(parsed.recordedDir, '/tmp/fixtures');
    assert.equal(parsed.gateTextFile, null);
  });
  test('--gate-text <file> alone is sufficient (live mode)', () => {
    const parsed = parseArgs(['node', 'run.js', 'app-1', '--gate-text', '/tmp/deck.txt']);
    assert.equal(parsed.gateTextFile, '/tmp/deck.txt');
    assert.equal(parsed.recordedDir, null);
  });
  test('--recorded and --gate-text together are ALLOWED, not mutually exclusive -- --recorded replaces only the LLM call; --gate-text is what makes quote-grounding and _text synthesis possible for a replayed fixture', () => {
    const parsed = parseArgs(['node', 'run.js', 'app-1', '--recorded', '/tmp/x', '--gate-text', '/tmp/y']);
    assert.equal(parsed.recordedDir, '/tmp/x');
    assert.equal(parsed.gateTextFile, '/tmp/y');
  });
  test('no application_id -> throws with a usage message', () => {
    assert.throws(() => parseArgs(['node', 'run.js']), /usage:/);
  });
  test('--recorded with no directory argument -> throws', () => {
    assert.throws(() => parseArgs(['node', 'run.js', 'app-1', '--recorded']));
  });
});

// ============================================================================
// loadRecordedExtraction -- fails loudly on a miss, never falls through.
// ============================================================================

describe('loadRecordedExtraction', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f07-run-test-'));

  test('reads and parses <dir>/<application_id>.json when present', () => {
    const appId = 'app-present';
    fs.writeFileSync(path.join(tmpDir, `${appId}.json`), JSON.stringify({ reasoning: 'x', sector: 'fintech' }));
    const loaded = loadRecordedExtraction(tmpDir, appId);
    assert.equal(loaded.sector, 'fintech');
  });

  test('a missing fixture file throws loudly rather than returning null/undefined', () => {
    assert.throws(() => loadRecordedExtraction(tmpDir, 'app-does-not-exist'), /no fixture at/);
  });
});

// ============================================================================
// validateExtraction -- the four checks from input-spec.md.
// ============================================================================

describe('validateExtraction -- check 1: value <=> quote <=> missing_fields biconditional', () => {
  test('a well-formed record with all fields grounded passes through unchanged', () => {
    const gateText = 'We build developer tools for backend teams. Built in Berlin, Germany. We have a working prototype.';
    const output = {
      reasoning: 'ok',
      sector: 'devtools', business_model: 'b2b', geography_country: 'DE', stage_evidence: 'prototype',
      what_is_built: 'A tool for backend teams.',
      quotes: {
        sector: 'developer tools for backend teams', business_model: 'developer tools for backend teams',
        geography_country: 'Built in Berlin, Germany', stage_evidence: 'working prototype',
        what_is_built: 'developer tools for backend teams',
      },
      missing_fields: [],
    };
    const result = validateExtraction(output, { gateText });
    assert.equal(result.sector, 'devtools');
    assert.equal(result.geography_country, 'DE');
    assert.deepEqual(result.missing_fields, []);
  });

  test('a value with no quote is demoted to null and added to missing_fields', () => {
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, { gateText: 'developer tools' });
    assert.equal(result.sector, null); // sector had no quote -- demoted despite a non-null value
    assert.ok(result.missing_fields.includes('sector'));
  });

  test('a field declared in missing_fields is nulled even if value+quote both looked fine (declaration wins)', () => {
    const gateText = 'developer tools for backend teams';
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: 'developer tools for backend teams', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, { gateText });
    assert.equal(result.sector, null);
  });

  test('the validator never repairs upward -- a missing_fields entry cannot be "cured" by later removing it from the array alone if value/quote are absent', () => {
    const output = {
      reasoning: 'ok', sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: [], // inconsistent input: nothing declared missing, but every value is null
    };
    const result = validateExtraction(output, {});
    // check 1 still catches it: null value + null quote -> forced into missing_fields regardless of the (wrong) input array.
    assert.deepEqual(result.missing_fields.sort(), ['business_model', 'geography_country', 'sector', 'stage_evidence', 'what_is_built']);
  });
});

describe('validateExtraction -- check 2: quote must be a grounded substring', () => {
  test('a fabricated quote (not present anywhere in gate_text or structured_hints) is demoted to null', () => {
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: 'this exact phrase never appeared', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, { gateText: 'we build developer tools for backend teams' });
    assert.equal(result.sector, null);
    assert.ok(result.missing_fields.includes('sector'));
  });

  test('a quote sourced from structured_hints (not present in gate_text) is accepted', () => {
    const output = {
      reasoning: 'ok', sector: null, business_model: null, geography_country: 'DE', stage_evidence: null, what_is_built: null,
      quotes: { sector: null, business_model: null, geography_country: 'DE', stage_evidence: null, what_is_built: null },
      missing_fields: ['sector', 'business_model', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, { gateText: 'no location mentioned here', structuredHints: { geography_country: 'DE' } });
    assert.equal(result.geography_country, 'DE');
  });

  test('a quote spanning a cosmetic line-break in gate_text is accepted (whitespace-normalized comparison)', () => {
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: 'developer tools for backend teams', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    // gate_text has the same span broken across a line + extra spaces.
    const result = validateExtraction(output, { gateText: 'we build developer  tools\nfor   backend teams' });
    assert.equal(result.sector, 'devtools');
  });

  test('with no gate_text and no structured_hints at all (recorded mode with no replayable input), grounding is a no-op -- values pass through untouched', () => {
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: 'b2b', geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: 'anything, unverifiable', business_model: 'anything else, unverifiable', geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['geography_country', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, {}); // no gateText, no structuredHints
    assert.equal(result.sector, 'devtools');
    assert.equal(result.business_model, 'b2b');
  });
});

describe('validateExtraction -- checks 3 & 4: illegal missing_fields entries and out-of-schema keys are dropped', () => {
  test('an illegal/duplicate missing_fields entry is filtered, not propagated', () => {
    const output = {
      reasoning: 'ok', sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['sector', 'sector', 'geography_region', 'not_a_real_field', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    const result = validateExtraction(output, {});
    assert.deepEqual(result.missing_fields.sort(), ['business_model', 'geography_country', 'sector', 'stage_evidence', 'what_is_built']);
  });

  test('an out-of-schema key (e.g. a stray confidence field, or geography_region/stage) is never propagated', () => {
    const output = {
      reasoning: 'ok', sector: 'devtools', business_model: 'b2b', geography_country: 'DE', stage_evidence: 'prototype', what_is_built: 'a tool',
      geography_region: 'EU', stage: 'pre_seed', confidence: 0.9, // all forbidden per input-spec.md
      quotes: { sector: 'devtools text', business_model: 'devtools text', geography_country: 'DE text', stage_evidence: 'prototype text', what_is_built: 'devtools text' },
      missing_fields: [],
    };
    const result = validateExtraction(output, { gateText: 'devtools text DE text prototype text' });
    assert.equal(result.geography_region, undefined);
    assert.equal(result.stage, undefined);
    assert.equal(result.confidence, undefined);
  });
});

// ============================================================================
// buildAttributesFromExtraction -- _text synthesis wired through, missing_
// fields passed through verbatim for rules.js's D-03 contract.
// ============================================================================

describe('buildAttributesFromExtraction', () => {
  test('gate text present -> _text is exactly the gate text', () => {
    const validated = { sector: 'devtools', business_model: 'b2b', geography_country: 'DE', stage_evidence: 'prototype', what_is_built: 'a tool', missing_fields: [] };
    const { attributes } = buildAttributesFromExtraction(validated, { gateText: 'we build developer tools' });
    assert.equal(attributes._text, 'we build developer tools');
    assert.equal(attributes.sector, 'devtools');
  });
  test('no gate text -> _text is absent (null), NEVER reconstructed from what_is_built or any other claim (team-lead correction, 2026-07-19)', () => {
    const validated = { sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: 'a real-money casino platform', missing_fields: ['sector', 'business_model', 'geography_country', 'stage_evidence'] };
    const { attributes, missingFields } = buildAttributesFromExtraction(validated, { gateText: '' });
    assert.equal(attributes._text, null);
    assert.deepEqual(missingFields, ['sector', 'business_model', 'geography_country', 'stage_evidence']);
  });
  test('missing_fields is passed through as a fresh array (not the same reference), so callers cannot mutate the source object by mistake', () => {
    const validated = { sector: 'devtools', business_model: null, geography_country: null, stage_evidence: null, what_is_built: null, missing_fields: ['business_model'] };
    const { missingFields } = buildAttributesFromExtraction(validated, { gateText: 'x' });
    missingFields.push('geography_country');
    assert.deepEqual(validated.missing_fields, ['business_model']); // source untouched
  });
});

// ============================================================================
// buildClaimPlan -- one row per present attribute, one gap row per missing
// one (§5.4.1). Gap rows use the BASE topic, not a `.gap` suffix --
// db/fixtures/07-thesis-engine.sql's actual convention, which the
// orchestrator ruled to follow over design.md §5.4.1's stated (but
// unimplemented) `.gap` suffix (tracker.md, B4).
// ============================================================================

describe('buildClaimPlan', () => {
  test('present fields become company.<field> claims with their quote as text_verbatim', () => {
    const validated = {
      sector: 'devtools', business_model: 'b2b', geography_country: 'DE', stage_evidence: 'prototype', what_is_built: 'a tool',
      quotes: { sector: 'q-sector', business_model: 'q-bm', geography_country: 'q-geo', stage_evidence: 'q-stage', what_is_built: 'q-built' },
      missing_fields: [],
    };
    const { present, gaps } = buildClaimPlan(validated);
    assert.equal(present.length, 5);
    assert.equal(gaps.length, 0);
    const sectorRow = present.find((r) => r.field === 'sector');
    assert.equal(sectorRow.topic, 'company.sector');
    assert.equal(sectorRow.text_verbatim, 'q-sector');
    assert.equal(sectorRow.value, 'devtools');
  });

  test('missing fields become company.<field> gap rows (base topic, no suffix) with a non-null text_verbatim (claims.text_verbatim is NOT NULL)', () => {
    const validated = {
      sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null,
      quotes: { sector: null, business_model: null, geography_country: null, stage_evidence: null, what_is_built: null },
      missing_fields: ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'],
    };
    const { present, gaps } = buildClaimPlan(validated);
    assert.equal(present.length, 0);
    assert.equal(gaps.length, 5);
    for (const gap of gaps) {
      assert.equal(gap.topic, `company.${gap.field}`); // base topic, matching db/fixtures/07-thesis-engine.sql
      assert.ok(typeof gap.text_verbatim === 'string' && gap.text_verbatim.length > 0);
    }
  });

  test('a mixed record splits correctly between present and gap', () => {
    const validated = {
      sector: 'devtools', business_model: null, geography_country: 'DE', stage_evidence: null, what_is_built: null,
      quotes: { sector: 'q-sector', business_model: null, geography_country: 'q-geo', stage_evidence: null, what_is_built: null },
      missing_fields: ['business_model', 'stage_evidence', 'what_is_built'],
    };
    const { present, gaps } = buildClaimPlan(validated);
    assert.deepEqual(present.map((r) => r.field).sort(), ['geography_country', 'sector']);
    assert.deepEqual(gaps.map((r) => r.field).sort(), ['business_model', 'stage_evidence', 'what_is_built']);
  });
});

// ============================================================================
// stripUnsupportedSchemaKeywords -- model-recommendations.md's "Strict-mode
// schema caveat" table, applied preemptively before a live call.
// ============================================================================

describe('stripUnsupportedSchemaKeywords', () => {
  test('removes minLength/maxLength/pattern/uniqueItems/maxItems at any depth', () => {
    const schema = {
      type: 'object',
      properties: {
        geography_country: { type: 'string', pattern: '^[A-Z]{2}$' },
        missing_fields: { type: 'array', uniqueItems: true, maxItems: 5, items: { type: 'string' } },
        reasoning: { type: 'string', minLength: 1, maxLength: 1200 },
      },
    };
    const stripped = stripUnsupportedSchemaKeywords(schema);
    assert.equal(stripped.properties.geography_country.pattern, undefined);
    assert.equal(stripped.properties.missing_fields.uniqueItems, undefined);
    assert.equal(stripped.properties.missing_fields.maxItems, undefined);
    assert.equal(stripped.properties.reasoning.minLength, undefined);
    assert.equal(stripped.properties.reasoning.maxLength, undefined);
    // everything else survives, e.g. `type`.
    assert.equal(stripped.properties.reasoning.type, 'string');
  });

  test('does not mutate the input object', () => {
    const schema = { type: 'string', minLength: 1 };
    stripUnsupportedSchemaKeywords(schema);
    assert.equal(schema.minLength, 1); // unchanged
  });
});
