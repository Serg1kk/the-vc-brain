// lib/f06/assemble.test.js
//
// Acceptance tests for lib/f06/assemble.js, per docs/backlog/
// 06-memo-decision/design.md §9 and plan.md task T3's acceptance list. Run
// with: node --test lib/f06/assemble.test.js -- ONLY this file (T1/T2 are
// concurrently building sibling lib/f06 modules in the same new directory).
//
// This file MAY require() -- only lib/f06/assemble.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  SWOT_ARRAYS,
  mergeSectionsParts,
  collectAllClaimIds,
  checkCitationGate,
  statementHasNumericFigure,
  checkTypedExceptionGuard,
  backfillRequiredSections,
  computeVersion,
  buildMemoGeneratedEvent,
  assembleMemo,
} = require('./assemble.js');

// ============================================================================
// Shared fixtures -- a self-consistent, valid memo built from the same
// claim-id vocabulary the citation gate checks against. Claim ids are plain
// strings here (the module never validates uuid shape), matching this
// repo's lib/f05/trust.test.js convention of short synthetic ids.
// ============================================================================

const APP_ID = 'app-0001';
const ALLOWED_CLAIM_IDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

function statement(overrides) {
  return Object.assign({ text: 'Statement text.', claim_ids: [], kind: 'structural' }, overrides);
}

function validPack(overrides) {
  return Object.assign(
    {
      application_id: APP_ID,
      allowed_claim_ids: ALLOWED_CLAIM_IDS.slice(),
      gaps: {
        not_disclosed: [{ topic: 'financials', text: 'Cap table: not disclosed.' }],
        missing_axes: ['founder'],
        missing_fields: [],
        low_coverage: { trust: 0.5, thesis: null },
        contradictions: [{ claim_id: 'c7', severity: 'material', nature: 'temporal', topic: 'founder.execution.provenance' }],
      },
    },
    overrides
  );
}

function partDescriptive(overrides) {
  return Object.assign(
    {
      snapshot: { statements: [statement({ text: 'Acme builds developer tooling.', claim_ids: ['c1'], kind: 'fact' })] },
      problem_product: {
        statements: [statement({ text: 'Live product at acme.dev.', claim_ids: ['c4'], kind: 'fact' })],
      },
      traction: { statements: [statement({ text: 'Cap table: not disclosed.', claim_ids: [], kind: 'not_disclosed' })] },
    },
    overrides
  );
}

function partAnalytical(overrides) {
  return Object.assign(
    {
      hypotheses: { statements: [statement({ text: 'Value mechanism: dev-first wedge.', claim_ids: ['c1'], kind: 'fact' })] },
      swot: {
        strengths: [statement({ text: 'Strong technical founder.', claim_ids: ['c2'], kind: 'fact' })],
        weaknesses: [statement({ text: 'Thin GTM evidence.', claim_ids: ['c3'], kind: 'fact' })],
        opportunities: [statement({ text: 'Market opening for dev tooling.', kind: 'structural' })],
        threats: [statement({ text: 'Competitive pressure from incumbents.', kind: 'structural' })],
      },
    },
    overrides
  );
}

function partOptionalSentinel() {
  return { _sentinel: true, risk_matrix: null, competition: null, financials_lite: null };
}

function partQuestions(overrides) {
  const base = {
    deep_dive_questions: [
      { question: 'Q1?', closes_gap: 'Resolves the provenance contradiction.', gap_kind: 'contradiction', claim_ids: ['c7'] },
      { question: 'Q2?', closes_gap: 'Missing stage evidence.', gap_kind: 'missing', claim_ids: [] },
      { question: 'Q3?', closes_gap: 'Ambiguous claim.', gap_kind: 'ambiguous', claim_ids: [] },
      { question: 'Q4?', closes_gap: 'Weakest axis.', gap_kind: 'missing', claim_ids: [] },
      { question: 'Q5?', closes_gap: 'Verification follow-up.', gap_kind: 'missing', claim_ids: [] },
    ],
  };
  return Object.assign(base, overrides);
}

function validSectionsParts() {
  // Deliberately scrambled order -- proves merge is content-based, not
  // index-based (plan.md T3's own risk note).
  return [partQuestions(), partOptionalSentinel(), partDescriptive(), partAnalytical()];
}

function validDecision(overrides) {
  return Object.assign(
    {
      recommendation: 'proceed-with-conditions',
      conditions: {
        check_size_usd: 100000,
        rationale: 'Market strong, idea-market fit thin -- proceed once the wedge is validated.',
        items: [{ text: 'Diligence idea-market fit.', closes: 'idea_vs_market below strong threshold', claim_ids: ['c5'] }],
        decision_inputs: { rule_fired: 'D6' },
        thresholds_version: 'f06-2026.07',
      },
    },
    overrides
  );
}

function validInputs() {
  return { pack: validPack(), sections_parts: validSectionsParts(), decision: validDecision() };
}

// ============================================================================
// Happy path
// ============================================================================

describe('assembleMemo -- happy path', () => {
  test('produces a row with all 5 required keys, no optional keys, and no error', () => {
    const { row, error } = assembleMemo(validInputs());
    assert.equal(error, undefined);
    assert.ok(row);
    assert.equal(row.application_id, APP_ID);
    assert.equal(row.version, null); // placeholder -- n8n node computes the real one
    assert.equal(row.recommendation, 'proceed-with-conditions');
    for (const key of ['snapshot', 'hypotheses', 'swot', 'problem_product', 'traction']) {
      assert.ok(row.sections[key], `expected sections.${key} to be present`);
    }
    for (const key of ['risk_matrix', 'competition', 'financials_lite']) {
      assert.ok(!(key in row.sections), `expected sections.${key} to be ABSENT (sentinel), got ${JSON.stringify(row.sections[key])}`);
    }
    assert.equal(row.deep_dive_questions.length, 5);
  });

  test('cited_claim_ids is a deduped union spanning sections + questions + conditions + gaps.contradictions', () => {
    const { row } = assembleMemo(validInputs());
    // c1 appears twice (snapshot + hypotheses) -- must be deduped.
    const expected = ['c1', 'c2', 'c3', 'c4', 'c7', 'c5'].sort();
    assert.deepEqual(row.cited_claim_ids.slice().sort(), expected);
    assert.equal(new Set(row.cited_claim_ids).size, row.cited_claim_ids.length, 'no duplicates');
  });
});

// ============================================================================
// mergeSectionsParts -- content-based merge, sentinel handling
// ============================================================================

describe('mergeSectionsParts', () => {
  test('merges by key/content regardless of array order', () => {
    const scrambled = [partAnalytical(), partDescriptive(), partOptionalSentinel(), partQuestions()];
    const { sections, deep_dive_questions } = mergeSectionsParts(scrambled);
    assert.ok(sections.snapshot);
    assert.ok(sections.hypotheses);
    assert.ok(sections.swot);
    assert.equal(deep_dive_questions.length, 5);
  });

  test('[B3] all-null sentinel contributes NO optional keys (no empty shells)', () => {
    const { sections } = mergeSectionsParts([partDescriptive(), partAnalytical(), partOptionalSentinel(), partQuestions()]);
    assert.equal('risk_matrix' in sections, false);
    assert.equal('competition' in sections, false);
    assert.equal('financials_lite' in sections, false);
  });

  test('a live (non-sentinel) optional section IS kept', () => {
    const optional = {
      _sentinel: false,
      risk_matrix: { risks: [{ text: 'Key-person risk.', severity: 'moderate', likelihood: 'medium', claim_ids: [] }] },
      competition: null,
      financials_lite: null,
    };
    const { sections } = mergeSectionsParts([partDescriptive(), partAnalytical(), optional, partQuestions()]);
    assert.ok(sections.risk_matrix);
    assert.equal(sections.risk_matrix.risks.length, 1);
    assert.equal('competition' in sections, false);
  });
});

// ============================================================================
// Citation gate (step 2) -- hallucinated claim ids anywhere reject the WHOLE
// memo, no partial row.
// ============================================================================

describe('assembleMemo -- citation gate', () => {
  test('hallucinated id in a section statement -> rejection', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({ snapshot: { statements: [statement({ text: 'Bad.', claim_ids: ['HALLUCINATED'], kind: 'fact' })] } }),
      partAnalytical(),
    ];
    const { row, error } = assembleMemo(inputs);
    assert.equal(row, undefined);
    assert.equal(error.code, 'uncited_claim_id');
    assert.match(error.message, /HALLUCINATED/);
  });

  test('hallucinated id in deep_dive_questions[].claim_ids -> rejection', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions({
        deep_dive_questions: [
          { question: 'Q1?', closes_gap: 'x', gap_kind: 'missing', claim_ids: ['HALLUCINATED'] },
          ...partQuestions().deep_dive_questions.slice(1),
        ],
      }),
      partOptionalSentinel(),
      partDescriptive(),
      partAnalytical(),
    ];
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'uncited_claim_id');
    assert.match(error.message, /HALLUCINATED/);
  });

  test('hallucinated id in conditions.items[].claim_ids -> rejection', () => {
    const inputs = validInputs();
    inputs.decision = validDecision({
      conditions: Object.assign({}, validDecision().conditions, {
        items: [{ text: 'x', closes: 'y', claim_ids: ['HALLUCINATED'] }],
      }),
    });
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'uncited_claim_id');
    assert.match(error.message, /HALLUCINATED/);
  });

  test('hallucinated id in gaps.contradictions[].claim_id (singular key) -> rejection', () => {
    const inputs = validInputs();
    inputs.pack = validPack({
      gaps: Object.assign({}, validPack().gaps, {
        contradictions: [{ claim_id: 'HALLUCINATED', severity: 'material', nature: 'temporal', topic: 'x' }],
      }),
    });
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'uncited_claim_id');
    assert.match(error.message, /HALLUCINATED/);
  });

  test('a founder-scoped pack id (allowed_claim_ids superset) passes cleanly', () => {
    // c7 is referenced by gaps.contradictions and a deep-dive question, never
    // by a section -- proves the superset makes pack-sourced ids safe.
    const { error } = assembleMemo(validInputs());
    assert.equal(error, undefined);
  });
});

// ============================================================================
// Typed-exception guard (step 3)
// ============================================================================

describe('assembleMemo / checkTypedExceptionGuard -- numeric smuggling', () => {
  test('statementHasNumericFigure detects $ and digit+unit, not a bare year', () => {
    assert.equal(statementHasNumericFigure('Raised $50K to date.'), true);
    assert.equal(statementHasNumericFigure('18 months of runway remaining.'), true);
    assert.equal(statementHasNumericFigure('Cap table: not disclosed.'), false);
    assert.equal(statementHasNumericFigure('No revenue disclosed as of 2026.'), false);
  });

  test('$ inside a not_disclosed statement -> rejection', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({
        traction: { statements: [statement({ text: 'Raised $50K, not disclosed further.', claim_ids: [], kind: 'not_disclosed' })] },
      }),
      partAnalytical(),
    ];
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'typed_exception_numeric_smuggling');
  });

  test('digit+unit inside a structural statement -> rejection', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive(),
      partAnalytical({
        swot: Object.assign({}, partAnalytical().swot, {
          opportunities: [statement({ text: 'Grew 40 users in the last month.', kind: 'structural' })],
        }),
      }),
    ];
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'typed_exception_numeric_smuggling');
  });

  test('benchmark WITHOUT the "not a valuation" caveat -> rejection', () => {
    const optional = {
      _sentinel: false,
      risk_matrix: null,
      competition: null,
      financials_lite: {
        statements: [statement({ text: 'Comparable pre-seed rounds closed at ~$8-12M post.', claim_ids: [], kind: 'benchmark' })],
      },
    };
    const inputs = validInputs();
    inputs.sections_parts = [partQuestions(), optional, partDescriptive(), partAnalytical()];
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'benchmark_missing_caveat');
  });

  test('benchmark WITH the caveat + numbers -> accepted', () => {
    const optional = {
      _sentinel: false,
      risk_matrix: null,
      competition: null,
      financials_lite: {
        statements: [
          statement({
            text: 'Comparable pre-seed AI-infra rounds in 2025 closed at ~$8-12M post (range, not a valuation; survivorship-biased).',
            claim_ids: [],
            kind: 'benchmark',
          }),
        ],
      },
    };
    const inputs = validInputs();
    inputs.sections_parts = [partQuestions(), optional, partDescriptive(), partAnalytical()];
    const { row, error } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.ok(row.sections.financials_lite);
  });

  test('a fact statement with zero claim_ids -> rejection', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({
        snapshot: { statements: [statement({ text: 'Unbacked fact.', claim_ids: [], kind: 'fact' })] },
      }),
      partAnalytical(),
    ];
    const { error } = assembleMemo(inputs);
    assert.equal(error.code, 'fact_missing_claim_id');
  });
});

// ============================================================================
// Required-section back-fill (step 2, spec-review should-fix #1 --
// "BACK-FILL, never reject")
// ============================================================================

describe('assembleMemo / backfillRequiredSections', () => {
  function backfilledStatement(row, key) {
    const arr = key.startsWith('swot.') ? row.sections.swot[key.slice('swot.'.length)] : row.sections[key].statements;
    return arr[0];
  }

  test('missing required key (traction absent) -> back-filled with a structural line', () => {
    const missingTraction = partDescriptive();
    delete missingTraction.traction;
    const inputs = validInputs();
    inputs.sections_parts = [partQuestions(), partOptionalSentinel(), missingTraction, partAnalytical()];
    const { row, error } = assembleMemo(inputs);
    assert.equal(error, undefined);
    const stmt = backfilledStatement(row, 'traction');
    assert.equal(row.sections.traction.statements.length, 1);
    assert.equal(stmt.kind, 'structural');
    assert.deepEqual(stmt.claim_ids, []);
    assert.match(stmt.text, /traction/i);
    assert.equal(statementHasNumericFigure(stmt.text), false);
  });

  test('empty required section (traction.statements = []) -> back-filled with a structural line', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({ traction: { statements: [] } }),
      partAnalytical(),
    ];
    const { row, error } = assembleMemo(inputs);
    assert.equal(error, undefined);
    const stmt = backfilledStatement(row, 'traction');
    assert.equal(row.sections.traction.statements.length, 1);
    assert.equal(stmt.kind, 'structural');
    assert.equal(statementHasNumericFigure(stmt.text), false);
  });

  test('empty SWOT array (threats = []) -> back-filled with a structural line', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive(),
      partAnalytical({ swot: Object.assign({}, partAnalytical().swot, { threats: [] }) }),
    ];
    const { row, error } = assembleMemo(inputs);
    assert.equal(error, undefined);
    const stmt = backfilledStatement(row, 'swot.threats');
    assert.equal(row.sections.swot.threats.length, 1);
    assert.equal(stmt.kind, 'structural');
    assert.match(stmt.text, /threats/i);
    assert.equal(statementHasNumericFigure(stmt.text), false);
  });

  test('backfillRequiredSections direct call: valid sections pass through unchanged', () => {
    const { sections } = mergeSectionsParts(validSectionsParts());
    const filled = backfillRequiredSections(sections);
    for (const key of ['snapshot', 'hypotheses', 'problem_product', 'traction']) {
      assert.equal(filled[key].statements.length, sections[key].statements.length);
    }
    for (const bucket of SWOT_ARRAYS) {
      assert.equal(filled.swot[bucket].length, sections.swot[bucket].length);
    }
  });

  test('backfillRequiredSections direct call: empty input -> all 5 required sections + 4 swot arrays back-filled, one structural line each, no claim_ids', () => {
    const filled = backfillRequiredSections({});
    for (const key of ['snapshot', 'hypotheses', 'problem_product', 'traction']) {
      assert.equal(filled[key].statements.length, 1);
      assert.equal(filled[key].statements[0].kind, 'structural');
      assert.deepEqual(filled[key].statements[0].claim_ids, []);
    }
    for (const bucket of SWOT_ARRAYS) {
      assert.equal(filled.swot[bucket].length, 1);
      assert.equal(filled.swot[bucket][0].kind, 'structural');
      assert.deepEqual(filled.swot[bucket][0].claim_ids, []);
    }
  });

  test('backfillRequiredSections preserves a live optional section untouched', () => {
    const optional = { risk_matrix: { risks: [{ text: 'x', severity: 'minor', likelihood: 'low', claim_ids: [] }] } };
    const filled = backfillRequiredSections(optional);
    assert.equal(filled.risk_matrix.risks.length, 1);
  });
});

// ============================================================================
// Empty-pack memo (design §10) -- an application with NO claims at all still
// writes: every required section back-filled, recommendation is total
// (decision.js is a separate module -- assembleMemo() itself never computes
// it), and the citation gate does not reject an empty allowed-claim-id set
// against an empty cited set.
// ============================================================================

describe('assembleMemo -- empty pack (design §10)', () => {
  test('no claims, no sections_parts -> writes a memo with every required section back-filled', () => {
    const { row, error } = assembleMemo({
      pack: { application_id: APP_ID, allowed_claim_ids: [], gaps: { not_disclosed: [], missing_axes: [], missing_fields: [], low_coverage: {}, contradictions: [] } },
      sections_parts: [],
      decision: { recommendation: 'watchlist', conditions: { check_size_usd: 100000, rationale: 'Not enough is known to decide responsibly in 24h.', items: [], decision_inputs: { rule_fired: 'D3' }, thresholds_version: 'f06-2026.07' } },
    });
    assert.equal(error, undefined);
    for (const key of ['snapshot', 'hypotheses', 'swot', 'problem_product', 'traction']) {
      assert.ok(row.sections[key], `expected sections.${key} to be present`);
    }
    assert.equal(row.sections.traction.statements.length, 1);
    for (const bucket of SWOT_ARRAYS) assert.equal(row.sections.swot[bucket].length, 1);
    assert.equal(row.recommendation, 'watchlist');
    assert.deepEqual(row.cited_claim_ids, []);
  });
});

// ============================================================================
// collectAllClaimIds / checkCitationGate unit-level checks
// ============================================================================

describe('collectAllClaimIds / checkCitationGate', () => {
  test('collects ids from every documented location', () => {
    const { sections, deep_dive_questions } = mergeSectionsParts(validSectionsParts());
    const gaps = validPack().gaps;
    const conditions = validDecision().conditions;
    const ids = collectAllClaimIds({ sections, deep_dive_questions, conditions, gaps });
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c7']) assert.ok(ids.has(id), `expected id ${id} to be collected`);
  });

  test('checkCitationGate returns null when every id is allowed', () => {
    const allowed = new Set(['a', 'b']);
    assert.equal(checkCitationGate(new Set(['a', 'b']), allowed), null);
  });

  test('checkCitationGate flags every offending id, not just the first', () => {
    const allowed = new Set(['a']);
    const result = checkCitationGate(new Set(['a', 'b', 'c']), allowed);
    assert.match(result.message, /b/);
    assert.match(result.message, /c/);
  });
});

// ============================================================================
// computeVersion (design §9.4)
// ============================================================================

describe('computeVersion', () => {
  test('empty existing versions -> 1', () => {
    assert.equal(computeVersion([]), 1);
  });

  test('[1, 2] -> 3', () => {
    assert.equal(computeVersion([1, 2]), 3);
  });

  test('unsorted / non-numeric-safe input still finds the max', () => {
    assert.equal(computeVersion([3, 1, 2]), 4);
  });

  test('undefined/null input treated as empty -> 1', () => {
    assert.equal(computeVersion(undefined), 1);
    assert.equal(computeVersion(null), 1);
  });
});

// ============================================================================
// buildMemoGeneratedEvent (design §9.7)
// ============================================================================

describe('buildMemoGeneratedEvent', () => {
  test('builds the design §9.7 payload shape', () => {
    const event = buildMemoGeneratedEvent({
      memo_id: 'memo-1',
      application_id: APP_ID,
      version: 2,
      recommendation: 'proceed',
      rule_fired: 'D5',
      run_id: 'run-1',
      n8n_execution_id: 'exec-1',
    });
    assert.equal(event.event_type, 'memo_generated');
    assert.equal(event.entity_type, 'application');
    assert.equal(event.entity_id, APP_ID);
    assert.deepEqual(event.payload, {
      memo_id: 'memo-1',
      version: 2,
      recommendation: 'proceed',
      rule_fired: 'D5',
      run_id: 'run-1',
      n8n_execution_id: 'exec-1',
    });
  });
});
