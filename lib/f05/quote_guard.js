// SOURCE OF TRUTH: lib/f05/quote_guard.js
//
// Deterministic quote-salience mismatch guard -- feature 05 (Truth-Gap Check
// & Trust Score), design.md §5.1(a) "factual_static" branch (a).
//
// JS port of `extract_salient_tokens` / `quote_salience_mismatches` from
// internal/other-projects/due-diligence-agents/src/dd_agents/validation/
// quote_guard.py -- Copyright the due-diligence-agents authors, licensed
// Apache License 2.0 (see that project's LICENSE). Porting under Apache 2.0
// requires attribution; a repo-root NOTICE covering this and the project's
// other Apache-2.0-derived ports is handled by a separate task -- do not
// remove this notice or the one below without updating that NOTICE too.
//
// Why this exists (design.md §5.1(a)): fuzzy citation matching at ~0.85
// similarity verifies a quote *roughly* appears in its source, but because it
// scores the best-aligning substring window, it also waves through small but
// MATERIAL adversarial edits -- "90 days" -> "30 days", "$2,000,000" ->
// "$5,000,000", a flipped negation ("shall indemnify" -> "shall not
// indemnify") -- all of which score 0.93-0.99 and pass. This module closes
// that blind spot: extract the *salient* tokens (currency, durations,
// percentages, negation) from a claim's quote and require each to be
// supported by the cited source text. A salient token present in the quote
// but unsupported by the source is a POSITIVE contradiction signature, not
// merely a non-match.
//
// Ported choices, faithful to the Python original (design.md §5.1(a), load-bearing):
//   - +/-5% numeric tolerance for currency/percent ("rounding and magnitude
//     phrasing are not fabrication")
//   - +/-15% tolerance for durations specifically -- looser than the +/-5%
//     numeric default because cross-unit conversion (month=~30d, year=~365d)
//     is approximate, so e.g. "4 weeks" (28d) must not be flagged against
//     "1 month" (30d)
//   - directional, WINDOWED negation check -- flags only when the QUOTE
//     asserts a negation absent from the source region aligned to that quote
//     (+/-240 chars), never the reverse (source negates, quote doesn't)
//   - deliberately narrow strong-negation regex, excluding bare "no" so it
//     does not fire on "no later than" / "no less than"
//
// All four branches from the Python original are ported: currency, duration,
// percent, negation. (An earlier draft of this file scoped the duration
// branch out per an unmeasured "durations are rare in this corpus" assumption
// in design.md §5.1(a) -- the team lead reversed that call 2026-07-19 after
// this port's own STEP 0 measurement showed 44 live claims with quotes, and
// because "90 days" -> "30 days" is the source module's own canonical
// fabrication example. design.md is being updated to match.)
//
// Fixed while porting (not a load-bearing design choice, a plain parsing
// bug): the Python `_currency_to_float` strips a currency suffix with
// `re.sub(r"(?:m|million)$", "", s)` etc. -- for a two-letter "MM" suffix
// (e.g. "$50MM") that regex's own alternation order only removes the single
// trailing "m", leaving "50m", so `float("50m")` throws and the amount
// silently drops out of the comparison. `currencyToFloat` below strips the
// matched suffix as one unit (longest alternative first) so "MM" resolves to
// the same $50,000,000 as "$50M" / "$50 million".
//
// Zero imports -- this file is inlined verbatim into an n8n Code node by
// n8n/build-f05-workflow.py (n8n cannot `require()` from this repo, no
// bind-mount). Self-contained CommonJS, no `require()`, no `Date.now()`, no
// `Math.random()`, no top-level side effects. Pure functions only.

'use strict';

// ============================================================================
// Tunables
// ============================================================================

// Relative tolerance for numeric/currency/percent support (rounding !=
// fabrication).
const NUMERIC_TOLERANCE = 0.05;

// Cross-unit duration comparison (month=~30d, year=~365d) is approximate, so
// durations use a looser tolerance than exact currency/percent figures --
// "4 weeks" (28d) must not be flagged against "1 month" (30d).
const DURATION_TOLERANCE = 0.15;

// Currency like $1,200,000 / $1.2M / $904K / $3 billion / $50MM. The
// magnitude suffix requires a trailing word boundary so it never swallows
// the leading letter of a following word (e.g. the "m" of "monthly" must NOT
// inflate $50,000 to $50B).
const CURRENCY_RE = /\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:m|b|k|mm|million|billion|thousand)\b)?/gi;

// Durations like "90 days", "12 months", "3 years", "6 weeks".
const DURATION_RE = /\b(\d+)\s+(day|days|month|months|year|years|week|weeks)\b/gi;

// Percentages like "15%" or "15 %".
const PERCENT_RE = /\b(\d+(?:\.\d+)?)\s*%/g;

// STRONG negation / liability-flip cues only. Deliberately EXCLUDES bare "no"
// (which fires on innocuous comparison phrases like "no later than", "no
// less than", "at no additional cost") and "without"/"except"/"none". Flags a
// negation mismatch ONLY when the quote asserts one of these strong
// negations that appears NOWHERE in the cited source -- a near-certain
// fabrication signal with effectively zero false positives.
const NEGATION_RE = new RegExp(
  '(?:\\b(?:shall|will|would|may|can|must|does|do|is|are|was|were|has|have)\\s+not\\b'
  + "|\\b(?:cannot|won't|can't|shan't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|wouldn't|couldn't|shouldn't)\\b"
  + '|\\bno\\s+(?:obligation|liability|liabilities|right|rights|warrant(?:y|ies)|refund|indemnit)'
  + '|\\bnot\\s+(?:liable|entitled|obligated|responsible|permitted|required|bound)\\b'
  + '|\\bnever\\b)',
  'i',
);

// ============================================================================
// Normalization
// ============================================================================

// NFKC-normalize, collapse whitespace, fold curly apostrophes, lowercase.
// Curly apostrophes (U+2019 RIGHT SINGLE QUOTATION MARK, U+02BC MODIFIER
// LETTER APOSTROPHE) are folded to ASCII "'" so contraction-based negations
// ("won't", "isn't") match regardless of the document's typography.
function normalize(text) {
  const nfkc = String(text).normalize('NFKC');
  const foldedApostrophes = nfkc.replace(/’/g, "'").replace(/ʼ/g, "'");
  return foldedApostrophes.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ============================================================================
// Currency parsing
// ============================================================================

// Parse a currency match (e.g. "$1.2M", "$50MM") to a float dollar value.
// Longest-alternative-first ('mm'/'million' checked before bare 'm', etc.) so
// a multi-letter suffix is stripped as one unit -- see the file header note
// on the Python original's single-character-strip bug this avoids.
function currencyToFloat(raw) {
  let s = raw.toLowerCase().replace(/\$/g, '').replace(/,/g, '').trim();
  let multiplier = 1.0;
  if (/(?:mm|million)$/.test(s)) {
    s = s.replace(/(?:mm|million)$/, '').trim();
    multiplier = 1_000_000.0;
  } else if (s.endsWith('m')) {
    s = s.slice(0, -1).trim();
    multiplier = 1_000_000.0;
  } else if (s.endsWith('billion')) {
    s = s.replace(/billion$/, '').trim();
    multiplier = 1_000_000_000.0;
  } else if (s.endsWith('b')) {
    s = s.slice(0, -1).trim();
    multiplier = 1_000_000_000.0;
  } else if (s.endsWith('thousand')) {
    s = s.replace(/thousand$/, '').trim();
    multiplier = 1_000.0;
  } else if (s.endsWith('k')) {
    s = s.slice(0, -1).trim();
    multiplier = 1_000.0;
  }
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  return parseFloat(s) * multiplier;
}

// Canonical key for a currency token: "$<number>" with no separators or
// magnitude suffix, so "$1.2M" and "$1200000" collapse to the same key.
// (Python's original branches on `value.is_integer()` to avoid a trailing
// ".0" -- unnecessary here, since JS's own number-to-string coercion already
// renders an integer-valued float without one.)
function canonicalCurrency(raw) {
  const value = currencyToFloat(raw);
  if (value === null) return raw.trim();
  return `$${value}`;
}

// ============================================================================
// Duration parsing
// ============================================================================

// Normalize a duration unit to its plural canonical form (day -> days).
function singularUnit(unit) {
  const u = unit.toLowerCase().replace(/s$/, '');
  return `${u}s`;
}

// Convert a canonical duration token ("90 days") to a comparable day count.
function durationValue(token) {
  const m = /^(\d+)\s+(day|month|year|week)s?$/.exec(token);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const factor = { day: 1.0, week: 7.0, month: 30.0, year: 365.0 }[m[2]];
  return n * factor;
}

// ============================================================================
// Salient-token extraction
// ============================================================================

// Extract the material tokens (currency, duration, percent, negation) from
// `text`. Returns { currency: Set<string>, duration: Set<string>,
// percent: Set<string>, negation: boolean }.
function extractSalientTokens(text) {
  const norm = normalize(text);

  const currency = new Set();
  for (const match of norm.matchAll(CURRENCY_RE)) {
    currency.add(canonicalCurrency(match[0]));
  }

  const duration = new Set();
  for (const match of norm.matchAll(DURATION_RE)) {
    duration.add(`${match[1]} ${singularUnit(match[2])}`);
  }

  const percent = new Set();
  for (const match of norm.matchAll(PERCENT_RE)) {
    percent.add(`${match[1]}%`);
  }

  const negation = NEGATION_RE.test(norm);

  return { currency, duration, percent, negation };
}

// ============================================================================
// Numeric support check
// ============================================================================

// True if `value` matches any candidate within `tolerance` (0 matches 0).
function numericSupported(value, candidates, tolerance = NUMERIC_TOLERANCE) {
  for (const c of candidates) {
    if (c === 0 && value === 0) return true;
    if (c !== 0 && Math.abs(value - c) / Math.abs(c) <= tolerance) return true;
  }
  return false;
}

// ============================================================================
// Negation window alignment
// ============================================================================

// Return the slice of `source` aligned to `quote`, for local negation checks.
//
// Anchors on the quote's longest run of content words and returns that
// region of the source +/- `margin` chars. When no anchor is found (the
// quote's content is not in the source at all), returns the whole
// (normalized) source so a genuinely unsupported negated quote is still
// evaluated. Pure string work -- no deps.
function alignedWindow(quote, source, margin = 240) {
  const nSource = normalize(source);
  const nQuote = normalize(quote);
  if (!nQuote || !nSource) return source;

  const words = nQuote.split(' ');
  const maxSpan = Math.min(words.length, 12);
  // Mirrors Python's `range(min(len(words), 12), 2, -1)`: tries progressively
  // shorter leading word-runs, stopping once span would drop to 2 or below.
  for (let span = maxSpan; span > 2; span -= 1) {
    const probe = words.slice(0, span).join(' ');
    const idx = nSource.indexOf(probe);
    if (idx !== -1) {
      const start = Math.max(0, idx - margin);
      const end = Math.min(nSource.length, idx + probe.length + margin);
      return nSource.slice(start, end);
    }
  }
  // No alignment anchor -> evaluate against the full source (conservative).
  return nSource;
}

// ============================================================================
// Main guard
// ============================================================================

// Return human-readable mismatches where `quote`'s salient tokens lack
// support in `source`.
//
// Returns an empty array when the source supports every salient token in the
// quote (within numeric tolerance), or when either input is empty (absence
// of source is handled upstream as non-blocking, not as a contradiction
// here).
function quoteSalienceMismatches(quote, source) {
  if (!String(quote).trim() || !String(source).trim()) return [];

  const q = extractSalientTokens(quote);
  const s = extractSalientTokens(source);
  const mismatches = [];

  // Currency: every quoted amount must be supported (+/-tolerance) by the source.
  const sourceAmounts = new Set();
  for (const raw of s.currency) {
    const v = currencyToFloat(raw);
    if (v !== null) sourceAmounts.add(v);
  }
  for (const raw of q.currency) {
    const val = currencyToFloat(raw);
    if (val !== null && !numericSupported(val, sourceAmounts)) {
      mismatches.push(`currency ${raw} in quote not supported by source`);
    }
  }

  // Durations: compared in normalized days, with a looser tolerance because
  // cross-unit conversion (month=~30d, year=~365d) is approximate.
  const sourceDays = new Set();
  for (const tok of s.duration) {
    const v = durationValue(tok);
    if (v !== null) sourceDays.add(v);
  }
  for (const tok of q.duration) {
    const val = durationValue(tok);
    if (val !== null && !numericSupported(val, sourceDays, DURATION_TOLERANCE)) {
      mismatches.push(`duration '${tok}' in quote not supported by source`);
    }
  }

  // Percentages: exact numeric support (+/-tolerance).
  const sourcePcts = new Set();
  for (const p of s.percent) sourcePcts.add(parseFloat(p.slice(0, -1)));
  for (const p of q.percent) {
    const val = parseFloat(p.slice(0, -1));
    if (!numericSupported(val, sourcePcts)) {
      mismatches.push(`percentage ${p} in quote not supported by source`);
    }
  }

  // Negation -- DIRECTIONAL and WINDOWED to avoid blocking-gate false
  // positives: only flag when the QUOTE asserts a strong negation that is
  // absent from the region of the source aligned to the quote. We never flag
  // the reverse (source negates, quote doesn't) -- that is not a fabrication
  // by the quote -- and we compare against a window around the quote's best
  // alignment, not the whole source (an unrelated "shall not" elsewhere in a
  // long document is irrelevant).
  if (q.negation) {
    const window = alignedWindow(quote, source);
    if (!NEGATION_RE.test(normalize(window))) {
      mismatches.push('negation mismatch: quote asserts a negation absent from the cited source passage');
    }
  }

  return mismatches;
}

module.exports = {
  extractSalientTokens,
  quoteSalienceMismatches,
};
