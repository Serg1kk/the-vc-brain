// lib/f06/assemble.test.js
//
// Acceptance tests for lib/f06/assemble.js, per docs/backlog/
// 06-memo-decision/design.md §9 (DROP + LOG revision, task T6b) and plan.md
// task T3's original acceptance list. Run with:
// node --test lib/f06/assemble.test.js -- ONLY this file (T1/T2 are
// concurrently building sibling lib/f06 modules in the same directory).
//
// T6b revision: the citation gate and the typed-exception guard used to
// reject the WHOLE memo on a content slip (T6's live smoke measured ~40% of
// runs hitting that reject). design §9 now has both DROP the offending
// statement/item and LOG it, never reject -- the tests below that used to
// assert "-> {error}" for a content issue now assert "-> dropped, logged,
// memo still assembles". The ONLY surviving `{error}` path is malformed
// input (`pack`/`decision` missing entirely), covered in its own describe
// block near the end.
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
  dropUncitedItems,
  statementHasNumericFigure,
  dropTypedExceptionOffenders,
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
  test('produces a row with all 5 required keys, no optional keys, no error, no drops', () => {
    const { row, error, dropped_statements } = assembleMemo(validInputs());
    assert.equal(error, undefined);
    assert.ok(row);
    assert.deepEqual(dropped_statements, []);
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
// Citation drop (step 2, DROP + LOG -- design §9.1, revised per task T6b).
// A hallucinated claim id anywhere drops JUST that statement/item -- never
// the whole memo -- and is recorded in dropped_statements[].
// ============================================================================

describe('assembleMemo -- citation drop (DROP + LOG, never a whole-memo reject)', () => {
  test('hallucinated id in a section statement -> statement dropped, section back-filled, memo still assembles', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({ snapshot: { statements: [statement({ text: 'Bad.', claim_ids: ['HALLUCINATED'], kind: 'fact' })] } }),
      partAnalytical(),
    ];
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.ok(row);
    // snapshot's only statement was the bad one -- dropping it empties the
    // required section, so back-fill (step 4) covers it with one structural line.
    assert.equal(row.sections.snapshot.statements.length, 1);
    assert.equal(row.sections.snapshot.statements[0].kind, 'structural');
    assert.equal(dropped_statements.length, 1);
    assert.deepEqual(dropped_statements[0], { location: 'snapshot', text: 'Bad.', offending_ids: ['HALLUCINATED'], reason: 'uncited_claim_id' });
    assert.ok(!row.cited_claim_ids.includes('HALLUCINATED'));
  });

  test('hallucinated id in deep_dive_questions[].claim_ids -> question dropped, others survive', () => {
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
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.deep_dive_questions.length, 4);
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].location, 'deep_dive_questions');
    assert.deepEqual(dropped_statements[0].offending_ids, ['HALLUCINATED']);
    assert.ok(!row.cited_claim_ids.includes('HALLUCINATED'));
  });

  test('hallucinated id in conditions.items[].claim_ids -> item dropped, conditions still ship', () => {
    const inputs = validInputs();
    inputs.decision = validDecision({
      conditions: Object.assign({}, validDecision().conditions, {
        items: [{ text: 'x', closes: 'y', claim_ids: ['HALLUCINATED'] }],
      }),
    });
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.conditions.items.length, 0);
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].location, 'conditions.items');
    assert.ok(!row.cited_claim_ids.includes('HALLUCINATED'));
  });

  test('gaps.contradictions[].claim_id (singular key) is pack-sourced -- never walked by the drop step', () => {
    // §3.6's allowed_claim_ids superset makes this id always valid in real
    // usage; this only proves the drop step does not even check it (design
    // §9.1: "leave it").
    const inputs = validInputs();
    inputs.pack = validPack({
      gaps: Object.assign({}, validPack().gaps, {
        contradictions: [{ claim_id: 'OUT_OF_SCOPE', severity: 'material', nature: 'temporal', topic: 'x' }],
      }),
    });
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.deepEqual(dropped_statements, []);
    assert.ok(row.cited_claim_ids.includes('OUT_OF_SCOPE'));
  });

  test('a founder-scoped pack id (allowed_claim_ids superset) passes cleanly, no drops', () => {
    // c7 is referenced by gaps.contradictions and a deep-dive question, never
    // by a section -- proves the superset makes pack-sourced ids safe.
    const { error, dropped_statements } = assembleMemo(validInputs());
    assert.equal(error, undefined);
    assert.deepEqual(dropped_statements, []);
  });
});

// ============================================================================
// Typed-exception drop (step 3, DROP + LOG -- design §9.2, same revision)
// ============================================================================

describe('assembleMemo / dropTypedExceptionOffenders -- numeric smuggling, DROP + LOG', () => {
  test('statementHasNumericFigure detects $ and digit+unit, not a bare year', () => {
    assert.equal(statementHasNumericFigure('Raised $50K to date.'), true);
    assert.equal(statementHasNumericFigure('18 months of runway remaining.'), true);
    assert.equal(statementHasNumericFigure('Cap table: not disclosed.'), false);
    assert.equal(statementHasNumericFigure('No revenue disclosed as of 2026.'), false);
  });

  test('$ inside a not_disclosed statement -> dropped, required section back-filled', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({
        traction: { statements: [statement({ text: 'Raised $50K, not disclosed further.', claim_ids: [], kind: 'not_disclosed' })] },
      }),
      partAnalytical(),
    ];
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.sections.traction.statements.length, 1);
    assert.equal(row.sections.traction.statements[0].kind, 'structural');
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].reason, 'typed_exception_numeric_smuggling');
    assert.equal(dropped_statements[0].location, 'traction');
  });

  test('digit+unit inside a structural statement -> dropped, swot array back-filled', () => {
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
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.sections.swot.opportunities.length, 1);
    assert.equal(row.sections.swot.opportunities[0].kind, 'structural');
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].location, 'swot.opportunities');
    assert.equal(dropped_statements[0].reason, 'typed_exception_numeric_smuggling');
  });

  test('benchmark WITHOUT the "not a valuation" caveat -> dropped (financials_lite is optional, ships with an empty array, not back-filled)', () => {
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
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.sections.financials_lite.statements.length, 0);
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].reason, 'benchmark_missing_caveat');
  });

  test('benchmark WITH the caveat + numbers -> accepted, not dropped', () => {
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
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.deepEqual(dropped_statements, []);
    assert.ok(row.sections.financials_lite);
    assert.equal(row.sections.financials_lite.statements.length, 1);
  });

  test('a fact statement with zero claim_ids -> dropped, required section back-filled', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({
        snapshot: { statements: [statement({ text: 'Unbacked fact.', claim_ids: [], kind: 'fact' })] },
      }),
      partAnalytical(),
    ];
    const { row, error, dropped_statements } = assembleMemo(inputs);
    assert.equal(error, undefined);
    assert.equal(row.sections.snapshot.statements.length, 1);
    assert.equal(row.sections.snapshot.statements[0].kind, 'structural');
    assert.equal(dropped_statements.length, 1);
    assert.equal(dropped_statements[0].reason, 'fact_missing_claim_id');
  });
});

// ============================================================================
// dropUncitedItems / dropTypedExceptionOffenders -- direct unit-level checks.
// These exercise locations the assembleMemo fixtures above never populate
// with LIVE (non-sentinel) content -- risk_matrix.risks and
// competition.competitors -- and confirm every offender is reported, not
// just the first.
// ============================================================================

describe('dropUncitedItems', () => {
  test('drops offenders from every documented location, keeps everything else, reports every offending id', () => {
    const allowedClaimIds = new Set(['a', 'b']);
    const sections = {
      snapshot: {
        statements: [
          statement({ text: 'Good.', claim_ids: ['a'], kind: 'fact' }),
          statement({ text: 'Bad.', claim_ids: ['a', 'BAD1'], kind: 'fact' }),
        ],
      },
      swot: {
        strengths: [statement({ text: 'Good strength.', claim_ids: ['b'], kind: 'fact' })],
        weaknesses: [statement({ text: 'Bad weakness.', claim_ids: ['BAD2'], kind: 'fact' })],
        opportunities: [],
        threats: [],
      },
      risk_matrix: {
        risks: [
          { text: 'Good risk.', severity: 'minor', likelihood: 'low', claim_ids: ['a'] },
          { text: 'Bad risk.', severity: 'minor', likelihood: 'low', claim_ids: ['BAD3'] },
        ],
      },
      competition: {
        statements: [],
        competitors: [
          { name: 'GoodCo', named_by_founder: true, claim_ids: ['b'] },
          { name: 'BadCo', named_by_founder: true, claim_ids: ['BAD4'] },
        ],
      },
    };
    const deep_dive_questions = [
      { question: 'Q good?', closes_gap: 'x', gap_kind: 'missing', claim_ids: ['a'] },
      { question: 'Q bad?', closes_gap: 'x', gap_kind: 'missing', claim_ids: ['BAD5'] },
    ];
    const conditions = {
      items: [
        { text: 'Good item.', closes: 'x', claim_ids: ['b'] },
        { text: 'Bad item.', closes: 'x', claim_ids: ['BAD6'] },
      ],
    };

    const result = dropUncitedItems({ sections, deep_dive_questions, conditions, allowedClaimIds });

    assert.equal(result.sections.snapshot.statements.length, 1);
    assert.equal(result.sections.snapshot.statements[0].text, 'Good.');
    assert.equal(result.sections.swot.strengths.length, 1);
    assert.equal(result.sections.swot.weaknesses.length, 0);
    assert.equal(result.sections.risk_matrix.risks.length, 1);
    assert.equal(result.sections.risk_matrix.risks[0].text, 'Good risk.');
    assert.equal(result.sections.competition.competitors.length, 1);
    assert.equal(result.sections.competition.competitors[0].name, 'GoodCo');
    assert.equal(result.deep_dive_questions.length, 1);
    assert.equal(result.conditions.items.length, 1);

    assert.equal(result.dropped.length, 6);
    const offendingIds = result.dropped
      .map(function (d) {
        return d.offending_ids[0];
      })
      .sort();
    assert.deepEqual(offendingIds, ['BAD1', 'BAD2', 'BAD3', 'BAD4', 'BAD5', 'BAD6']);
    for (const d of result.dropped) assert.equal(d.reason, 'uncited_claim_id');
  });

  test('an item with claim_ids: [] is always kept (nothing to be offending)', () => {
    const allowedClaimIds = new Set(['a']);
    const sections = { snapshot: { statements: [statement({ text: 'Absence.', claim_ids: [], kind: 'not_disclosed' })] } };
    const result = dropUncitedItems({ sections, deep_dive_questions: [], conditions: { items: [] }, allowedClaimIds });
    assert.equal(result.sections.snapshot.statements.length, 1);
    assert.deepEqual(result.dropped, []);
  });
});

describe('dropTypedExceptionOffenders', () => {
  test('drops offending statements across `.statements` sections and swot, leaves risk_matrix/competition untouched (no `kind` field)', () => {
    const sections = {
      traction: {
        statements: [
          statement({ text: 'Cap table: not disclosed.', claim_ids: [], kind: 'not_disclosed' }),
          statement({ text: 'Raised $50K.', claim_ids: [], kind: 'not_disclosed' }),
        ],
      },
      swot: {
        strengths: [statement({ text: 'Grew 40 users.', kind: 'structural' })],
        weaknesses: [],
        opportunities: [],
        threats: [],
      },
      risk_matrix: { risks: [{ text: 'Contains $100K exposure.', severity: 'minor', likelihood: 'low', claim_ids: [] }] },
    };
    const { sections: out, dropped } = dropTypedExceptionOffenders(sections);
    assert.equal(out.traction.statements.length, 1);
    assert.equal(out.traction.statements[0].text, 'Cap table: not disclosed.');
    assert.equal(out.swot.strengths.length, 0);
    // risk_matrix.risks has no `kind` -- the typed-exception vocabulary does
    // not apply to it, so it survives untouched even with a `$` in its text.
    assert.equal(out.risk_matrix.risks.length, 1);
    assert.equal(dropped.length, 2);
    for (const d of dropped) assert.equal(d.reason, 'typed_exception_numeric_smuggling');
  });

  test('covers the benchmark-missing-caveat and fact-missing-claim_id reasons directly', () => {
    const sections = {
      financials_lite: {
        statements: [statement({ text: 'Comparable rounds ~$8-12M post.', claim_ids: [], kind: 'benchmark' })],
      },
      snapshot: {
        statements: [statement({ text: 'Unbacked fact.', claim_ids: [], kind: 'fact' })],
      },
    };
    const { dropped } = dropTypedExceptionOffenders(sections);
    assert.equal(dropped.length, 2);
    const reasons = dropped
      .map(function (d) {
        return d.reason;
      })
      .sort();
    assert.deepEqual(reasons, ['benchmark_missing_caveat', 'fact_missing_claim_id']);
  });
});

// ============================================================================
// Required-section back-fill (step 4, spec-review should-fix #1 --
// "BACK-FILL, never reject"; runs AFTER both drop steps as of task T6b)
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
  test('no claims, no sections_parts -> writes a memo with every required section back-filled, no drops', () => {
    const { row, error, dropped_statements } = assembleMemo({
      pack: { application_id: APP_ID, allowed_claim_ids: [], gaps: { not_disclosed: [], missing_axes: [], missing_fields: [], low_coverage: {}, contradictions: [] } },
      sections_parts: [],
      decision: { recommendation: 'watchlist', conditions: { check_size_usd: 100000, rationale: 'Not enough is known to decide responsibly in 24h.', items: [], decision_inputs: { rule_fired: 'D3' }, thresholds_version: 'f06-2026.07' } },
    });
    assert.equal(error, undefined);
    assert.deepEqual(dropped_statements, []);
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
// assembleMemo -- malformed input (design §9: the ONLY remaining {error}
// path, task T6b). Never fires from real [A]/[C] output -- exists so this
// pure function fails loudly on a genuinely broken caller instead of
// assembling a memo from nothing.
// ============================================================================

describe('assembleMemo -- malformed input', () => {
  test('missing pack -> {error: malformed_input}', () => {
    const { row, error } = assembleMemo({ sections_parts: [], decision: validDecision() });
    assert.equal(row, undefined);
    assert.equal(error.code, 'malformed_input');
    assert.match(error.message, /pack/i);
  });

  test('pack present but not an object -> {error: malformed_input}', () => {
    const { error } = assembleMemo({ pack: 'not-an-object', sections_parts: [], decision: validDecision() });
    assert.equal(error.code, 'malformed_input');
  });

  test('missing decision -> {error: malformed_input}', () => {
    const { error } = assembleMemo({ pack: validPack(), sections_parts: [] });
    assert.equal(error.code, 'malformed_input');
    assert.match(error.message, /decision/i);
  });

  test('decision present but not an object -> {error: malformed_input}', () => {
    const { error } = assembleMemo({ pack: validPack(), sections_parts: [], decision: 'nope' });
    assert.equal(error.code, 'malformed_input');
  });

  test('called with no arguments at all -> {error: malformed_input}', () => {
    const { error } = assembleMemo();
    assert.equal(error.code, 'malformed_input');
  });

  test('a genuine content slip (bad citation) is NEVER routed through this error path', () => {
    const inputs = validInputs();
    inputs.sections_parts = [
      partQuestions(),
      partOptionalSentinel(),
      partDescriptive({ snapshot: { statements: [statement({ text: 'Bad.', claim_ids: ['HALLUCINATED'], kind: 'fact' })] } }),
      partAnalytical(),
    ];
    const { error } = assembleMemo(inputs);
    assert.equal(error, undefined);
  });
});

// ============================================================================
// collectAllClaimIds -- unit-level checks (the read-only collector cited_claim_ids
// (step 5) is built from, over the POST-drop, POST-back-fill row)
// ============================================================================

describe('collectAllClaimIds', () => {
  test('collects ids from every documented location', () => {
    const { sections, deep_dive_questions } = mergeSectionsParts(validSectionsParts());
    const gaps = validPack().gaps;
    const conditions = validDecision().conditions;
    const ids = collectAllClaimIds({ sections, deep_dive_questions, conditions, gaps });
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c7']) assert.ok(ids.has(id), `expected id ${id} to be collected`);
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
// buildMemoGeneratedEvent (design §9.7, dropped_count/dropped_statements
// added per task T6b -- "the drop is logged, not silent")
// ============================================================================

describe('buildMemoGeneratedEvent', () => {
  test('builds the design §9.7 payload shape, including dropped_count/dropped_statements', () => {
    const dropped = [{ location: 'snapshot', text: 'Bad.', offending_ids: ['x'], reason: 'uncited_claim_id' }];
    const event = buildMemoGeneratedEvent({
      memo_id: 'memo-1',
      application_id: APP_ID,
      version: 2,
      recommendation: 'proceed',
      rule_fired: 'D5',
      run_id: 'run-1',
      n8n_execution_id: 'exec-1',
      dropped_statements: dropped,
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
      dropped_count: 1,
      dropped_statements: dropped,
    });
  });

  test('dropped_statements omitted -> dropped_count 0, dropped_statements []', () => {
    const event = buildMemoGeneratedEvent({
      memo_id: 'memo-1',
      application_id: APP_ID,
      version: 1,
      recommendation: 'pass',
      rule_fired: 'D1',
      run_id: 'run-1',
      n8n_execution_id: 'exec-1',
    });
    assert.equal(event.payload.dropped_count, 0);
    assert.deepEqual(event.payload.dropped_statements, []);
  });
});
