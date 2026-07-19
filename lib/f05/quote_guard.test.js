// lib/f05/quote_guard.test.js
//
// Tests for lib/f05/quote_guard.js (feature 05, design.md §5.1(a) --
// `factual_static` sub-check (a), the quote-salience fabrication guard). Run
// with: node --test lib/f05/quote_guard.test.js
//
// Do NOT run this via the `lib/f05/*.test.js` glob -- other agents are
// concurrently adding sibling files to this new directory (task A3
// instruction).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractSalientTokens, quoteSalienceMismatches } = require('./quote_guard');

// ============================================================================
// Currency -- the "$2,000,000" -> "$5,000,000" material-edit case
// ============================================================================

describe('quoteSalienceMismatches -- currency', () => {
  test('CATCHES a material currency edit ($2,000,000 quoted, source only supports $5,000,000)', () => {
    const quote = 'The company closed the round at $2,000,000 in committed capital.';
    const source = 'Public filings confirm the round closed at $5,000,000 in committed capital.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.includes('currency') && m.includes('$2000000')),
      `expected a currency mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });

  test('does NOT fire on a +/-5% rounding difference ($1,000,000 quoted, source says $1,030,000)', () => {
    const quote = 'Revenue reached $1,000,000 for the year.';
    const source = 'Audited figures show revenue of $1,030,000 for the year.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('a magnitude-suffixed amount ($1.2M) is supported by an equivalent spelled-out source figure', () => {
    const quote = 'ARR stands at $1.2M as of the last close.';
    const source = 'As of the last close, ARR stands at $1,200,000.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('a "MM" magnitude suffix resolves to millions, not a parse failure (fixed vs. the Python original -- see file header)', () => {
    const tokens = extractSalientTokens('The facility is sized at $50MM.');
    assert.ok(tokens.currency.has('$50000000'), `expected $50000000 in ${JSON.stringify([...tokens.currency])}`);
  });
});

// ============================================================================
// Percent -- same material-edit / tolerance shape as currency
// ============================================================================

describe('quoteSalienceMismatches -- percent', () => {
  test('catches a material percentage edit (15% quoted, source only supports 45%)', () => {
    const quote = 'Gross margin runs at 15% company-wide.';
    const source = 'Company-wide gross margin is 45% per the latest board deck.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.includes('percentage 15%')),
      `expected a percentage mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });

  test('does NOT fire on a +/-5% rounding difference (15% quoted, source says 15.4%)', () => {
    const quote = 'Churn is 15% monthly.';
    const source = 'Monthly churn measures 15.4% over the trailing quarter.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });
});

// ============================================================================
// Negation -- directional, windowed, narrow regex (design.md §5.1(a),
// all three load-bearing)
// ============================================================================

describe('quoteSalienceMismatches -- negation', () => {
  test('CATCHES a flipped negation ("shall indemnify" -> "shall not indemnify")', () => {
    const quote = 'The company shall not indemnify the buyer for third-party claims.';
    const source = 'Per the agreement, the company shall indemnify the buyer for third-party claims arising from the deal.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.startsWith('negation mismatch')),
      `expected a negation mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });

  test('does NOT fire on "no later than" -- the narrow regex deliberately excludes bare "no"', () => {
    // Deliberately no currency/duration/percent figures in the quote, so this
    // test isolates the negation branch alone.
    const quote = 'Payment is due no later than the invoice date each cycle.';
    const source = 'The invoice payment schedule is unrelated boilerplate text with no matching figures.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
    // Confirms the exclusion is structural, not incidental: the quote's own
    // extracted tokens must show no negation at all.
    assert.equal(extractSalientTokens(quote).negation, false);
  });

  test('a clean, matching negation does not fire (source echoes the same negation)', () => {
    const quote = 'The vendor shall not be liable for indirect damages.';
    const source = 'Per section 9, the vendor shall not be liable for indirect or consequential damages of any kind.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('directional: a negation present only in the SOURCE (not the quote) never fires', () => {
    const quote = 'The vendor is liable for indirect damages.';
    const source = 'Per section 9, the vendor shall not be liable for indirect damages.';
    // The quote itself asserts no negation, so the negation branch is never
    // entered -- this is not evaluated as a fabrication by the quote.
    assert.equal(extractSalientTokens(quote).negation, false);
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });
});

// ============================================================================
// Empty-input and non-mismatch baseline behaviour
// ============================================================================

describe('quoteSalienceMismatches -- baseline', () => {
  test('an empty quote or source returns no mismatches (handled upstream as non-blocking)', () => {
    assert.deepEqual(quoteSalienceMismatches('', 'some source text'), []);
    assert.deepEqual(quoteSalienceMismatches('some quote text', ''), []);
    assert.deepEqual(quoteSalienceMismatches('   ', '   '), []);
  });

  test('a clean citation with no salient tokens never fires', () => {
    const quote = 'The founder previously led engineering at a mid-size fintech company.';
    const source = 'Prior to founding the company, they led the engineering org at a mid-size fintech firm.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });
});

// ============================================================================
// Duration -- reinstated 2026-07-19 (team lead reversed the earlier "drop
// duration" call once STEP 0 showed a live call site and design.md's own
// "durations are rare" rationale turned out to be an unmeasured assumption).
// Same material-edit / tolerance shape as currency and percent, but with the
// wider +/-15% cross-unit tolerance (month=~30d, year=~365d is approximate).
// ============================================================================

describe('quoteSalienceMismatches -- duration', () => {
  test('CATCHES a material duration edit ("90 days" quoted, source only supports "30 days")', () => {
    const quote = 'The pilot converts to a paid contract within 90 days.';
    const source = 'The pilot converts to a paid contract within 30 days, per the signed order form.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.includes('duration') && m.includes('90 days')),
      `expected a duration mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });

  test('does NOT fire on a +/-15% duration difference (90 days quoted, source says 100 days)', () => {
    const quote = 'Runway extends 90 days from close.';
    const source = 'Per the model, runway extends 100 days from close.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('cross-unit tolerance: "4 weeks" (28d) is supported by a source stating "1 month" (30d)', () => {
    const quote = 'Onboarding takes 4 weeks end to end.';
    const source = 'End to end, onboarding takes 1 month for a typical customer.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('plural/singular units normalize the same way ("1 month" and "1 months" canonicalize identically)', () => {
    assert.deepEqual([...extractSalientTokens('renews after 1 month').duration], ['1 months']);
    assert.deepEqual([...extractSalientTokens('renews after 1 months').duration], ['1 months']);
  });
});

// ============================================================================
// Numeric ranges -- QA pass Finding 2(a): "$1-2 million" / "10-15%" /
// "12-18 months" were mis-tokenized as a bare, unit-less low bound (currency)
// or an untethered high bound (duration/percent), flagging a TRUE point
// figure the source reports inside the range as a fabricated mismatch. Fixed
// by matching the range as one token and checking source-value-in-range.
// ============================================================================

describe('quoteSalienceMismatches -- numeric ranges (QA Finding 2a)', () => {
  test('a currency range ("$1-2 million") is supported by a source point figure inside it ($1.5 million)', () => {
    const quote = 'We raised $1-2 million in our seed round.';
    const source = 'The company raised $1.5 million in a seed round led by a local angel syndicate.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('a percentage range ("10-15%") is supported by a source point figure inside it (12%)', () => {
    const quote = 'We grew revenue by 10-15% quarter over quarter.';
    const source = 'Quarterly revenue growth was approximately 12% for the company.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('a duration range ("12-18 months") is supported by a source point figure inside it (15 months)', () => {
    const quote = 'Runway of 12-18 months at current burn.';
    const source = 'The company reported approximately 15 months of runway remaining.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('structural fix, not a data fluke: a range never leaves a bare fragment token behind', () => {
    // Before the fix, "$1-2 million" tokenized as a bare, unit-less "$1"
    // (the "million" only bound to the second number) -- confirmed live by
    // QA against a real currency Set containing "$1". After the fix the
    // range is consumed as a single token and the scalar Set is empty.
    const currencyTokens = extractSalientTokens('We raised $1-2 million in our seed round.');
    assert.deepEqual([...currencyTokens.currency], []);
    assert.deepEqual(currencyTokens.currencyRanges, [{ low: 1_000_000, high: 2_000_000 }]);

    const percentTokens = extractSalientTokens('We grew revenue by 10-15% quarter over quarter.');
    assert.deepEqual([...percentTokens.percent], []);
    assert.deepEqual(percentTokens.percentRanges, [{ low: 10, high: 15 }]);

    const durationTokens = extractSalientTokens('Runway of 12-18 months at current burn.');
    assert.deepEqual([...durationTokens.duration], []);
    assert.deepEqual(durationTokens.durationRanges, [{ low: 360, high: 540 }]);
  });

  test('a range still CATCHES a genuinely unsupported figure (source is outside the range)', () => {
    const quote = 'We raised $1-2 million in our seed round.';
    const source = 'Public filings show the round closed at $500,000.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.includes('currency range')),
      `expected a currency range mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });
});

// ============================================================================
// Negation over-triggering -- QA pass Finding 2(b): a bare "absent from
// source" rule fired on ordinary, true, self-aware pre-seed disclosures
// ("does not currently generate revenue") the instant an unrelated,
// independently-collected source simply didn't happen to restate the same
// negation -- the normal case. Fixed to require the source POSITIVELY
// asserting the opposite before flagging.
// ============================================================================

describe('quoteSalienceMismatches -- negation over-triggering (QA Finding 2b)', () => {
  test('an honest "does not" disclosure does NOT fire when the source simply never mentions the topic', () => {
    const quote = 'The company does not currently generate revenue.';
    const source = 'Nordkit is developer tooling and infrastructure that lets backend teams trace and debug distributed systems in production.';
    assert.deepEqual(quoteSalienceMismatches(quote, source), []);
  });

  test('regression: a genuine liability flip still fires (source positively asserts the opposite)', () => {
    // Same shape as the file header's canonical example, re-asserted here so
    // the negation rewrite's regression coverage is explicit and adjacent to
    // the false-positive fix above, not just inherited from the older test.
    const quote = 'The company shall not indemnify the buyer for third-party claims.';
    const source = 'Per the agreement, the company shall indemnify the buyer for third-party claims arising from the deal.';
    const mismatches = quoteSalienceMismatches(quote, source);
    assert.ok(
      mismatches.some((m) => m.startsWith('negation mismatch')),
      `expected a negation mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  });
});
