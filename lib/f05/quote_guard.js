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
//   - directional, WINDOWED, POSITIVE-ASSERTION negation check -- flags only
//     when the QUOTE asserts a negation whose SINGLE precise predicate the
//     source POSITIVELY RESTATES (not merely fails to echo) in the region
//     aligned to that quote (+/-240 chars), never the reverse (source
//     negates, quote doesn't). Both the positive-assertion requirement and
//     the single-precise-predicate requirement are post-port tightenings
//     (Finding 2(b) above, rounds 1 and 2), not part of the original
//     Python's rule
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
// Fixed post-port, 2026-07-19, per QA pass Finding 2(a) (not a load-bearing
// design choice, a plain parsing bug): the single-value CURRENCY_RE /
// DURATION_RE / PERCENT_RE below only bind a unit/suffix to the number
// immediately adjacent to it, so a range like "$1-2 million" tokenized as a
// bare, unit-less "$1" (the "million" belongs to the SECOND number) while
// "12-18 months" tokenized as a bare "12" plus a unit-bound "18 months" --
// silently discarding the TRUE point figure a source reports inside that
// range as an unsupported, contradiction-flagged fabrication. Fixed by
// matching a range as one token first (CURRENCY_RANGE_RE / DURATION_RANGE_RE
// / PERCENT_RANGE_RE below), recording its span so the single-value regexes
// never re-tokenize its low/high numbers as bare values, and treating the
// claim as supported when the source's point value falls inside
// [low, high] (each edge still getting the type's usual tolerance).
//
// Fixed post-port, 2026-07-19, per QA pass Finding 2(b) (a real behavioural
// divergence from the Python original, not a load-bearing design choice),
// TWO rounds:
//   Round 1 -- the negation check originally fired whenever the source
//   window simply failed to RESTATE the quote's negation -- the normal
//   case, since an independently-collected source rarely repeats a claim's
//   exact wording, let alone its negative phrasing. Fired on ordinary, true,
//   pre-seed disclosures ("The company does not currently generate
//   revenue"). Tightened to require a POSITIVE assertion: the quote's
//   negation predicate must appear in some sentence of the aligned source
//   window WITHOUT a negation cue of its own.
//   Round 2 -- the round-1 fix derived the predicate from up to 4 loosely
//   collected nearby words, and fired if ANY of them matched un-negated
//   text anywhere in the source. That let an INCIDENTAL trailing word --
//   "beta" in "do not charge for the beta", against an unrelated "closed
//   beta" mention in the source -- trigger a false positive on another true,
//   mutually-consistent disclosure. Tightened again to derive exactly ONE
//   precise predicate (see `negationPredicate` below) -- the negated
//   verb/noun/adjective itself, not incidental neighbours -- and require
//   THAT word, specifically, to be positively asserted. This remains a
//   lexical check: a genuinely paraphrased flip ("has not launched
//   publicly" vs. "went live to the public") is missed. Accepted trade --
//   the false-negative direction costs one finding; the false-positive
//   direction breaks REQ-004.
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

// Numeric ranges -- "$1-2 million", "10-15%", "12-18 months" -- matched as a
// SINGLE token, low and high sharing one trailing unit/suffix. See the file
// header's Finding 2(a) divergence note: without these, the single-value
// regexes above mis-tokenize a range's low bound as bare and unit-less.
// Matched BEFORE (and its span excluded from) the single-value regexes.
const CURRENCY_RANGE_RE = /\$\s*([\d,]+(?:\.\d+)?)\s*[-–]\s*([\d,]+(?:\.\d+)?)(?:\s*(m|b|k|mm|million|billion|thousand)\b)?/gi;
const DURATION_RANGE_RE = /\b(\d+)\s*[-–]\s*(\d+)\s+(day|days|month|months|year|years|week|weeks)\b/gi;
const PERCENT_RANGE_RE = /\b(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*%/g;

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

// Day-equivalent factor per unit stem. Shared by durationValue() (single
// tokens) and the range extraction in extractSalientTokens() below, so
// "12-18 months" and a bare "12 months" convert with identical arithmetic.
const DURATION_FACTORS = { day: 1.0, week: 7.0, month: 30.0, year: 365.0 };

// Normalize a duration unit to its plural canonical form (day -> days).
function singularUnit(unit) {
  const u = unit.toLowerCase().replace(/s$/, '');
  return `${u}s`;
}

// Convert a canonical duration token ("90 days") to a comparable day count.
function durationValue(token) {
  const m = /^(\d+)\s+(day|month|year|week)s?$/.exec(token);
  if (!m) return null;
  return parseFloat(m[1]) * DURATION_FACTORS[m[2]];
}

// ============================================================================
// Salient-token extraction
// ============================================================================

// True if `index` falls inside any [start, end) span. Used to keep the
// single-value regexes below from re-tokenizing a range's low/high number as
// an untethered bare value (file header, Finding 2(a)).
function withinSpan(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

// Extract the material tokens (currency, duration, percent, negation) from
// `text`. Returns { currency: Set<string>, duration: Set<string>,
// percent: Set<string>, negation: boolean, currencyRanges: {low,high}[],
// durationRanges: {low,high}[] (bounds in days), percentRanges: {low,high}[]
// }. Ranges are extracted first so their spans can be excluded from the
// single-value Sets.
function extractSalientTokens(text) {
  const norm = normalize(text);

  const currencyRanges = [];
  const currencyRangeSpans = [];
  for (const match of norm.matchAll(CURRENCY_RANGE_RE)) {
    currencyRangeSpans.push([match.index, match.index + match[0].length]);
    const suffix = match[3] || '';
    const low = currencyToFloat(`$${match[1]}${suffix}`);
    const high = currencyToFloat(`$${match[2]}${suffix}`);
    if (low !== null && high !== null) currencyRanges.push({ low, high });
  }

  const durationRanges = [];
  const durationRangeSpans = [];
  for (const match of norm.matchAll(DURATION_RANGE_RE)) {
    durationRangeSpans.push([match.index, match.index + match[0].length]);
    const factor = DURATION_FACTORS[match[3].toLowerCase().replace(/s$/, '')];
    durationRanges.push({ low: parseFloat(match[1]) * factor, high: parseFloat(match[2]) * factor });
  }

  const percentRanges = [];
  const percentRangeSpans = [];
  for (const match of norm.matchAll(PERCENT_RANGE_RE)) {
    percentRangeSpans.push([match.index, match.index + match[0].length]);
    percentRanges.push({ low: parseFloat(match[1]), high: parseFloat(match[2]) });
  }

  const currency = new Set();
  for (const match of norm.matchAll(CURRENCY_RE)) {
    if (withinSpan(match.index, currencyRangeSpans)) continue;
    currency.add(canonicalCurrency(match[0]));
  }

  const duration = new Set();
  for (const match of norm.matchAll(DURATION_RE)) {
    if (withinSpan(match.index, durationRangeSpans)) continue;
    duration.add(`${match[1]} ${singularUnit(match[2])}`);
  }

  const percent = new Set();
  for (const match of norm.matchAll(PERCENT_RE)) {
    if (withinSpan(match.index, percentRangeSpans)) continue;
    percent.add(`${match[1]}%`);
  }

  const negation = NEGATION_RE.test(norm);

  return {
    currency, duration, percent, negation, currencyRanges, durationRanges, percentRanges,
  };
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
// Range support (file header, Finding 2(a))
// ============================================================================

// True if `value` falls inside [low, high], each bound loosened by
// `tolerance` -- the same relative tolerance a bare value already gets, so a
// source figure at the very edge of a quoted range isn't penalized for
// ordinary rounding.
function valueInRange(value, low, high, tolerance) {
  const loLimit = low - Math.abs(low) * tolerance;
  const hiLimit = high + Math.abs(high) * tolerance;
  return value >= loLimit && value <= hiLimit;
}

// True if two (tolerance-loosened) ranges overlap.
function rangesOverlap(a, b, tolerance) {
  const aLo = a.low - Math.abs(a.low) * tolerance;
  const aHi = a.high + Math.abs(a.high) * tolerance;
  const bLo = b.low - Math.abs(b.low) * tolerance;
  const bHi = b.high + Math.abs(b.high) * tolerance;
  return aLo <= bHi && bLo <= aHi;
}

// A bare quoted value is supported if it matches a bare source value
// (existing tolerance rule) OR falls inside a source-stated range.
function scalarSupported(value, sourceScalars, sourceRanges, tolerance) {
  if (numericSupported(value, sourceScalars, tolerance)) return true;
  for (const r of sourceRanges) {
    if (valueInRange(value, r.low, r.high, tolerance)) return true;
  }
  return false;
}

// A quoted range ("$1-2 million") is supported if the source's point figure
// falls inside it, or a source-stated range overlaps it. Without this, only
// the range's high bound would survive as a bare token (see file header) and
// a true point figure inside the range would be flagged as unsupported.
function rangeSupported(range, sourceScalars, sourceRanges, tolerance) {
  for (const v of sourceScalars) {
    if (valueInRange(v, range.low, range.high, tolerance)) return true;
  }
  for (const r of sourceRanges) {
    if (rangesOverlap(range, r, tolerance)) return true;
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
// Negation predicate extraction (file header, Finding 2(b))
// ============================================================================

// Function words, the negation cue words themselves, and a short list of
// weak temporal adverbs that commonly sit right after a negation cue without
// being the thing actually negated ("does not CURRENTLY generate revenue" --
// the negated predicate is "generate", not "currently") -- excluded when
// deriving a negation's predicate below, so the predicate is always genuine
// content (e.g. "indemnify", "liable", "obligation"), never a piece of the
// negation machinery around it.
const NEGATION_SKIP_WORDS = new Set([
  'shall', 'will', 'would', 'may', 'can', 'must', 'does', 'do', 'is', 'are', 'was', 'were', 'has', 'have',
  'not', 'no', 'never',
  'cannot', "won't", "can't", "shan't", "isn't", "aren't", "wasn't", "weren't",
  "doesn't", "don't", "didn't", "hasn't", "haven't", "wouldn't", "couldn't", "shouldn't",
  'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on', 'at', 'and', 'or', 'this', 'that',
  'with', 'by', 'it', 'its', 'as', 'than', 'be', 'been', 'being',
  'currently', 'yet', 'already', 'still', 'now', 'presently', 'recently',
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split into rough sentence-like chunks on terminal punctuation. Coarse on
// purpose -- just enough so a positive assertion of the predicate elsewhere
// in a long, unrelated clause of the window isn't credited to the negation
// being checked.
function splitSentences(text) {
  return text.split(/[.!?;]+/).map((s) => s.trim()).filter(Boolean);
}

// From a NEGATION_RE match on the (normalized) quote, derive the SINGLE
// content word the negation actually attaches to -- e.g. "indemnify" in
// "shall not indemnify", "charge" in "do not charge", "obligation" in "no
// obligation". Deliberately ONE precise predicate, not a sweep of several
// nearby words (QA Finding 2(b), round 2 -- see file header): a multi-word
// sweep let an INCIDENTAL trailing word ("beta" in "do not charge for the
// beta") match an unrelated positive mention elsewhere in the source,
// flagging a true, mutually-consistent claim as a fabrication. A single
// precise predicate is worth more than several fuzzy ones.
//
// The "no <noun>" / "not <adjective>" cues already END on their predicate
// (the noun/adjective is baked into NEGATION_RE's own alternation), so that
// last match word is used directly. The modal/contraction/"never" cues
// negate whatever verb comes next, so we scan forward past skip-words for
// the first content word. Returns null when no content word is found within
// a short lookahead -- callers treat that as "cannot check", not "mismatch"
// (false-negative bias, see the call site).
function negationPredicate(normQuote, match) {
  const matchWords = match[0].split(/[^a-z0-9']+/i).filter(Boolean);
  const lastMatchWord = matchWords[matchWords.length - 1];
  if (lastMatchWord && lastMatchWord.length >= 3 && !NEGATION_SKIP_WORDS.has(lastMatchWord)) {
    return lastMatchWord;
  }
  const after = normQuote.slice(match.index + match[0].length)
    .split(/[^a-z0-9']+/i).filter(Boolean).slice(0, 6);
  for (const w of after) {
    if (w.length >= 3 && !NEGATION_SKIP_WORDS.has(w)) return w;
  }
  return null;
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

  // Currency: every quoted amount (bare or ranged) must be supported
  // (+/-tolerance) by the source, and vice versa for a quoted range -- see
  // the file header's Finding 2(a) note.
  const sourceAmounts = new Set();
  for (const raw of s.currency) {
    const v = currencyToFloat(raw);
    if (v !== null) sourceAmounts.add(v);
  }
  for (const raw of q.currency) {
    const val = currencyToFloat(raw);
    if (val !== null && !scalarSupported(val, sourceAmounts, s.currencyRanges, NUMERIC_TOLERANCE)) {
      mismatches.push(`currency ${raw} in quote not supported by source`);
    }
  }
  for (const range of q.currencyRanges) {
    if (!rangeSupported(range, sourceAmounts, s.currencyRanges, NUMERIC_TOLERANCE)) {
      mismatches.push(`currency range $${range.low}-$${range.high} in quote not supported by source`);
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
    if (val !== null && !scalarSupported(val, sourceDays, s.durationRanges, DURATION_TOLERANCE)) {
      mismatches.push(`duration '${tok}' in quote not supported by source`);
    }
  }
  for (const range of q.durationRanges) {
    if (!rangeSupported(range, sourceDays, s.durationRanges, DURATION_TOLERANCE)) {
      mismatches.push(`duration range ${range.low}-${range.high} days in quote not supported by source`);
    }
  }

  // Percentages: exact numeric support (+/-tolerance).
  const sourcePcts = new Set();
  for (const p of s.percent) sourcePcts.add(parseFloat(p.slice(0, -1)));
  for (const p of q.percent) {
    const val = parseFloat(p.slice(0, -1));
    if (!scalarSupported(val, sourcePcts, s.percentRanges, NUMERIC_TOLERANCE)) {
      mismatches.push(`percentage ${p} in quote not supported by source`);
    }
  }
  for (const range of q.percentRanges) {
    if (!rangeSupported(range, sourcePcts, s.percentRanges, NUMERIC_TOLERANCE)) {
      mismatches.push(`percentage range ${range.low}%-${range.high}% in quote not supported by source`);
    }
  }

  // Negation -- DIRECTIONAL, WINDOWED, and requires a POSITIVE ASSERTION of
  // the ONE precise predicate the negation attaches to, not merely an
  // absence of restatement (file header, Finding 2(b)): we derive the
  // negation's single predicate from the quote (e.g. "indemnify" in "shall
  // not indemnify"), then flag only when some sentence of the region of the
  // source aligned to the quote contains that SAME predicate WITHOUT a
  // negation cue of its own -- i.e. the source itself positively asserts the
  // opposite. We never flag the reverse (source negates, quote doesn't) --
  // that is not a fabrication by the quote. If no predicate can be derived,
  // or no positive sentence is found, we do NOT flag: biased hard toward
  // false negatives on purpose, because missing a real fabrication costs one
  // finding, while a false accusation against a true founder claim breaks
  // REQ-004 -- the invariant this whole check exists to protect. This
  // remains a lexical, not semantic, check -- a genuine paraphrased flip
  // ("has not launched publicly" vs. "went live to the public") is missed,
  // a known and accepted limitation given that bias.
  if (q.negation) {
    const normQuote = normalize(quote);
    const negMatch = NEGATION_RE.exec(normQuote);
    const predicate = negMatch ? negationPredicate(normQuote, negMatch) : null;
    if (predicate) {
      const sentences = splitSentences(alignedWindow(quote, source));
      const wordRe = new RegExp(`\\b${escapeRegExp(predicate)}\\b`, 'i');
      const flipped = sentences.some((sentence) => wordRe.test(sentence) && !NEGATION_RE.test(sentence));
      if (flipped) {
        mismatches.push('negation mismatch: source positively asserts the opposite of a negation in the quote');
      }
    }
  }

  return mismatches;
}

module.exports = {
  extractSalientTokens,
  quoteSalienceMismatches,
};
