// lib/f02/claims.js
// SOURCE OF TRUTH: lib/f02/claims.js
//
// One pure producer per design.md §5.1 topic slug -- the claims 03 actually
// consumes. Self-contained CommonJS, ZERO imports (docs/backlog/TRACKER.md
// hard convention -- n8n Code nodes cannot require() from this repo). Pure
// functions only: no I/O, no network, no Date.now()/Math.random().
//
// Topic slugs are EXACT strings from design §5.1 -- 03 routes by prefix,
// and a typo silently starves a criterion in feature 03 (plan.md Task 3's
// own warning). They are centralised in the TOPIC map below so a producer
// can never typo its own slug.
//
// ============================================================================
// design.md §5.0 RULE 2 -- load-bearing, implemented exactly here:
//
//   1. Every claim this file emits carries >=1 evidence row with
//      raw_signal_ref populated. assertClaimWellFormed() below throws
//      otherwise -- it is the acceptance criterion plan.md Task 3 names
//      ("no radar-written claim reaches 03 without a resolvable
//      raw_signals.source").
//   2. A `missing`-marker claim (evidence.tier='missing',
//      relation='context', quote_verbatim=null) is emitted ONLY when an
//      ATTEMPT produced a raw signal (the API call was made and returned
//      nothing useful) -- makeMissingClaim() below, called only from
//      inside a producer that has already confirmed `fact.attempted` and
//      `fact.rawSignalRef` are both present.
//   3. If NO attempt was made at all (no GitHub token, the call never
//      issued) -> every producer returns `null`, emitting NO claim.
//      Emitting a claim here would license `not_met` on every criterion in
//      03 via its `source_kind='public'` wildcard fallback (03 §4.4 step
//      5), inverting REQ-003. This is `hasUsableAttempt()` below, the
//      FIRST line of every producer.
//
// evidence.tier defaults (design §5.0 field-defaults table):
//   github_api -> 'documented', hn_algolia -> 'documented',
//   tavily_extract -> 'discovered'. If the identity-link confidence
//   (ctx.identityConfidence, from lib/f02/identity.js's `confidence`) is
//   < 0.85, the tier is FORCED to 'inferred' regardless of source -- "the
//   only lever that makes §4.1's 'enters scoring at reduced confidence'
//   real, since 03 never reads founder_identities.confidence" (design
//   §5.0). See tierForSource() below.
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// Topic slugs -- design §5.1, verbatim.
// ----------------------------------------------------------------------------

const TOPIC = Object.freeze({
  EXECUTION_MERGED_PR_FOREIGN: 'founder.execution.merged_pr_foreign',
  EXECUTION_COMMIT_CONSISTENCY: 'founder.execution.commit_consistency',
  EXECUTION_LIVE_PRODUCT: 'founder.execution.live_product',
  EXECUTION_EXTERNAL_USAGE: 'founder.execution.external_usage',
  EXECUTION_PROVENANCE: 'founder.execution.provenance',
  EXPERTISE_VERTICAL_TENURE: 'founder.expertise.vertical_tenure',
  EXPERTISE_INSIGHT_SPECIFICITY: 'founder.expertise.insight_specificity',
  EXPERTISE_UNASKED_WORK: 'founder.expertise.unasked_work',
  LEADERSHIP_WRITTEN_COMMUNICATION: 'founder.leadership.written_communication',
});

// ----------------------------------------------------------------------------
// Small shared helpers
// ----------------------------------------------------------------------------

function nonEmptyString(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// hasUsableAttempt(fact) -- design §5.0 rule 2.3. `fact.attempted` says the
// call was issued; `fact.rawSignalRef` is what evidence.raw_signal_ref will
// cite. Either missing means there is nothing to attach evidence to, so
// the producer must return null (no claim), not a claim with a hole in it.
function hasUsableAttempt(fact) {
  return Boolean(fact) && fact.attempted === true && Boolean(fact.rawSignalRef);
}

// tierForSource -- design §5.0 field-defaults table, exact defaulting +
// override rule described in the file header above.
const DEFAULT_TIER_BY_SOURCE = Object.freeze({
  github_api: 'documented',
  hn_algolia: 'documented',
  tavily_extract: 'discovered',
});

function tierForSource(source, identityConfidence) {
  if (typeof identityConfidence === 'number' && identityConfidence < 0.85) return 'inferred';
  return DEFAULT_TIER_BY_SOURCE[source] || 'discovered';
}

// Radar-assigned prior confidence that a produced claim's VALUE is true,
// distinct from evidence.tier (which is about the SOURCE's trustworthiness,
// not this claim's own content). design.md does not pin exact numbers for
// claims.base_confidence anywhere in §5 -- unlike 03's credit/tier_factor
// maps, which are spelled out to 2dp -- so these two constants are this
// file's own judgment call, named and centralised here (not scattered
// per-producer) so a reviewer can find and challenge them in one place:
// hard structured facts straight off an API (counts, timestamps) carry a
// higher prior than a single verbatim excerpt whose SIGNIFICANCE (not its
// existence) still needs a human/agent read.
const BASE_CONFIDENCE_HARD_FACT = 0.90;
const BASE_CONFIDENCE_TEXT_SIGNAL = 0.75;

// makeClaim / makeMissingClaim -- the two shapes every producer returns.
// Field names match the task brief's exact output contract.
function makeClaim({ topic, textVerbatim, value, baseConfidence, tier, quoteVerbatim, sourceUrl, rawSignalRef }) {
  return {
    topic,
    text_verbatim: textVerbatim,
    value: value === undefined ? null : value,
    source_kind: 'public',
    base_confidence: baseConfidence,
    evidence: {
      tier,
      relation: 'supports',
      quote_verbatim: quoteVerbatim === undefined ? null : quoteVerbatim,
      source_url: sourceUrl === undefined ? null : sourceUrl,
      raw_signal_ref: rawSignalRef,
    },
  };
}

// db/schema.sql: `claims.text_verbatim text NOT NULL` -- a missing-marker
// claim still has to satisfy that constraint even though there is, by
// definition, no source text to quote. This is deliberately NOT topic- or
// call-specific text (that would risk reading as a fabricated observation,
// exactly what rule 2 forbids) -- a single, unmistakably-synthetic constant
// that a reader (human or 03's sub-scorer) can recognise on sight as "the
// system recorded an absence", never as evidence of anything. Contrast
// evidence.quote_verbatim, which IS nullable at the schema level and stays
// genuinely null here -- the absence lives there, not in this string.
const MISSING_TEXT_VERBATIM = '[no data observed -- attempted, nothing found]';

// design §5.0 rule 2.2: cites the raw signal of the ATTEMPT, relation
// 'context', tier 'missing', quote_verbatim always null (there is nothing
// to quote -- the attempt found no fact).
function makeMissingClaim({ topic, sourceUrl, rawSignalRef }) {
  return {
    topic,
    text_verbatim: MISSING_TEXT_VERBATIM,
    value: null,
    source_kind: 'public',
    base_confidence: null,
    evidence: {
      tier: 'missing',
      relation: 'context',
      quote_verbatim: null,
      source_url: sourceUrl === undefined ? null : sourceUrl,
      raw_signal_ref: rawSignalRef,
    },
  };
}

// ============================================================================
// assertClaimWellFormed -- design §5.0 rule 2's enforcement point. Throws
// on any claim (real or missing-marker) that would license the exact
// defect rule 2 exists to prevent. Exported so both this file's own tests
// and a caller's DB-write step can call it as a final guard before insert.
// ============================================================================

const VALID_TIERS = new Set(['documented', 'discovered', 'inferred', 'missing']);
const VALID_RELATIONS = new Set(['supports', 'context', 'contradicts']);

function assertClaimWellFormed(claim) {
  if (!claim || typeof claim !== 'object') {
    throw new Error('assertClaimWellFormed: claim must be an object');
  }
  if (!nonEmptyString(claim.topic)) {
    throw new Error('assertClaimWellFormed: claim.topic is required');
  }
  if (!claim.evidence || typeof claim.evidence !== 'object') {
    throw new Error(`assertClaimWellFormed: ${claim.topic} -- claim.evidence is required`);
  }

  const { tier, relation, raw_signal_ref: rawSignalRef, quote_verbatim: quoteVerbatim } = claim.evidence;

  if (!VALID_TIERS.has(tier)) {
    throw new Error(`assertClaimWellFormed: ${claim.topic} -- invalid evidence.tier ${JSON.stringify(tier)}`);
  }
  if (!VALID_RELATIONS.has(relation)) {
    throw new Error(`assertClaimWellFormed: ${claim.topic} -- invalid evidence.relation ${JSON.stringify(relation)}`);
  }

  // design §5.0 rule 2.1, the load-bearing check: no claim without a
  // resolvable raw_signal_ref. A missing-marker claim is held to the SAME
  // requirement (rule 2.2: "a missing-marker claim cites the raw signal of
  // the attempt") -- there is no exemption for it.
  if (!nonEmptyString(rawSignalRef)) {
    throw new Error(`assertClaimWellFormed: ${claim.topic} -- evidence.raw_signal_ref is required (design §5.0 rule 2)`);
  }

  if (tier === 'missing') {
    if (quoteVerbatim !== null) {
      throw new Error(`assertClaimWellFormed: ${claim.topic} -- a 'missing' marker must have evidence.quote_verbatim === null`);
    }
    if (relation !== 'context') {
      throw new Error(`assertClaimWellFormed: ${claim.topic} -- a 'missing' marker must have evidence.relation === 'context'`);
    }
  }

  return true;
}

// ============================================================================
// Producers -- one per §5.1 topic slug. Every producer's FIRST line is the
// rule-2.3 gate (hasUsableAttempt); every producer's LAST resort before a
// real claim is a missing-marker, never a fabricated value.
//
// Input shape is this file's own design choice (design §5 does not pin an
// exact upstream JSON shape -- it names WHICH GraphQL/REST/Tavily fields
// feed each slug, not the wire format a Code node hands this function).
// Every `fact` object shares three common fields:
//   attempted    -- bool, was the underlying call issued at all
//   rawSignalRef -- the id/hash the caller will use as
//                   evidence.raw_signal_ref (design §5.0's "raw_signals
//                   row of the attempt")
//   sourceUrl    -- optional, evidence.source_url
// plus whatever slug-specific fields are documented on each producer.
// ============================================================================

// founder.execution.merged_pr_foreign -- E1 (0.100), source github_api.
// design §3: pullRequestContributionsByRepository, filtered owner != user
// AND merged, <=12 months -- "the strongest un-gameable signal".
// fact: {..., mergedForeignPrCount, examples?: string[]}
// `fact.truncated` (added 2026-07-19, wired from a live GitHub Search API
// capture): the Search API returns at most 100 items per page and this
// project makes no attempt to paginate through `total_count` (design §5.4
// names the endpoint, not a pagination strategy, and the Search API's own
// ~10 req/min unauthenticated ceiling makes deep paging expensive). Found
// LIVE against a genuinely prolific account (ayuhito: `total_count` 945,
// the 100 returned items span only ~126 of the requested 365 days) --
// undercounting is the only failure mode this can produce (a real PR
// outside the fetched page is simply invisible, never double-counted), so
// the qualitative claim ("this person merges PRs into others' repos") is
// NOT weakened by truncation -- only the exact count is a lower bound.
// Phrased as "at least N", never presented as exhaustive; no
// base_confidence penalty (contrast E3 below, where truncation DOES
// undermine the claim's core question).
function founderExecutionMergedPrForeign(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const count = numOrNull(fact.mergedForeignPrCount);
  if (count === null || count <= 0) {
    return makeMissingClaim({
      topic: TOPIC.EXECUTION_MERGED_PR_FOREIGN,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const truncated = Boolean(fact.truncated);
  const countPhrase = truncated ? `At least ${count}` : `${count}`;
  const textVerbatim = `${countPhrase} merged pull request${count === 1 ? '' : 's'} into ${
    count === 1 ? 'a repository' : 'repositories'
  } not owned by this account in the last 12 months${
    truncated ? ' (the Search API page was capped at 100 results; the true count may be higher, never lower)' : ''
  }.`;

  return makeClaim({
    topic: TOPIC.EXECUTION_MERGED_PR_FOREIGN,
    textVerbatim,
    value: { merged_foreign_pr_count: count, truncated, examples: Array.isArray(fact.examples) ? fact.examples : [] },
    baseConfidence: BASE_CONFIDENCE_HARD_FACT,
    tier: tierForSource('github_api', ctx && ctx.identityConfidence),
    quoteVerbatim: null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.execution.commit_consistency -- E3 (0.060), source github_api.
// design §3/§5.4: contributionCalendar day array -> count of the last 12
// weeks with >=1 commit. `partial: true` marks the REST /events fallback
// (design §5.4: "~90-day substitute for the GraphQL-only calendar") --
// lower base_confidence, noted in the text rather than silently dropped.
//
// `fact.coverageDays` (added 2026-07-19, wired from a live capture):
// `/users/{u}/events` caps at ~300 events / 90 days IN THEORY, but for a
// genuinely high-activity account the 100-event page this project fetches
// can exhaust itself in under two days of real time (found live: ayuhito's
// 100 most recent events span ~21 HOURS, JustVugg's span ~37 hours) --
// nowhere near the "roughly 90 days" design §5.4 describes as the typical
// case. That is a REAL outcome for a high-activity account, not a bug, and
// this file's job is to represent it honestly rather than silently reusing
// the generic "~90-day substitute" phrasing regardless of what was actually
// observed. `coverageDays` (when supplied) drives BOTH the text and a
// confidence that scales down toward the true visibility, not a flat 0.60
// regardless of whether 89 days or 1 day were actually seen. Backward
// compatible: a caller that supplies `partial` without `coverageDays` (or
// omits both) keeps this file's original flat 0.60-when-partial behaviour.
// fact: {..., weeksWithCommitCount, weeksObserved?: number (default 12),
//         partial?: bool, coverageDays?: number}
function founderExecutionCommitConsistency(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const weeksObserved = numOrNull(fact.weeksObserved) ?? 12;
  const weeksWithCommit = numOrNull(fact.weeksWithCommitCount);
  if (weeksWithCommit === null) {
    return makeMissingClaim({
      topic: TOPIC.EXECUTION_COMMIT_CONSISTENCY,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const partial = Boolean(fact.partial);
  const coverageDays = numOrNull(fact.coverageDays);

  let note = 'measured from the REST events feed, a partial ~90-day substitute for the GraphQL contribution calendar';
  // design's own asked-for window is 12 weeks = 84 days -- below that, the
  // feed did not even cover what THIS criterion asks about, which is a
  // materially worse gap than "a partial substitute for the calendar" and
  // must say so explicitly rather than reuse the generic note.
  if (coverageDays !== null && coverageDays < 84) {
    note =
      coverageDays < 1
        ? `the REST events feed's 100-event page was exhausted by recent activity alone, covering under a day -- far short of the 12-week (84-day) window this signal asks about`
        : `the REST events feed's 100-event page was exhausted by recent activity alone, covering only ~${coverageDays.toFixed(1)} of the 84 days (12 weeks) this signal asks about`;
  }
  const textVerbatim =
    `${weeksWithCommit} of the last ${weeksObserved} weeks had at least one commit` + (partial ? ` (${note}).` : '.');

  // Confidence scales down toward the ACTUAL visibility when coverageDays is
  // known: full 84-day coverage keeps the flat partial value (0.60); every
  // day short of that pulls confidence toward a 0.30 floor -- a claim built
  // from 1 day of visibility is not equally trustworthy as one built from
  // 80 days, even though both are technically "partial".
  // db/schema.sql: claims.base_confidence is numeric(3,2) -- rounded to 2dp
  // here rather than left to Postgres's own silent insert-time rounding, so
  // the value a caller sees in JS is the value that actually lands in the
  // column.
  let baseConfidence = BASE_CONFIDENCE_HARD_FACT;
  if (partial) {
    baseConfidence =
      coverageDays === null
        ? 0.60
        : Math.round(Math.max(0.30, Math.min(0.60, 0.30 + 0.30 * (coverageDays / 84))) * 100) / 100;
  }

  return makeClaim({
    topic: TOPIC.EXECUTION_COMMIT_CONSISTENCY,
    textVerbatim,
    value: { weeks_with_commit: weeksWithCommit, weeks_observed: weeksObserved, partial, coverage_days: coverageDays },
    baseConfidence,
    tier: tierForSource('github_api', ctx && ctx.identityConfidence),
    quoteVerbatim: null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.execution.live_product -- E4 (0.100), source tavily_extract |
// github_api. HTTP liveness probe, classified live / soft_404 /
// placeholder / could_not_verify. design §7.1: a client-rendered SPA that
// fails extraction is 'could_not_verify', NEVER treated as "project is
// dead" -- a false red flag costs more than a missed signal.
// fact: {..., status: 'live'|'soft_404'|'placeholder'|'could_not_verify',
//         source?: 'tavily_extract'|'github_api'}
const LIVE_PRODUCT_STATUSES = new Set(['live', 'soft_404', 'placeholder', 'could_not_verify']);
const LIVE_PRODUCT_BASE_CONFIDENCE = Object.freeze({
  live: 0.90,
  soft_404: 0.70,
  placeholder: 0.70,
  could_not_verify: 0.50,
});

function founderExecutionLiveProduct(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const status = fact.status;
  if (!LIVE_PRODUCT_STATUSES.has(status)) {
    return makeMissingClaim({
      topic: TOPIC.EXECUTION_LIVE_PRODUCT,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const source = fact.source === 'github_api' ? 'github_api' : 'tavily_extract';
  return makeClaim({
    topic: TOPIC.EXECUTION_LIVE_PRODUCT,
    textVerbatim: `Artifact URL liveness probe classified as '${status}'.`,
    value: { status },
    baseConfidence: LIVE_PRODUCT_BASE_CONFIDENCE[status],
    tier: tierForSource(source, ctx && ctx.identityConfidence),
    quoteVerbatim: null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.execution.external_usage -- E5 (0.080), source github_api.
// design §3: forkCount, dependents, release download counts -- "measured
// usage, never stars" (SIG-014). Stars are deliberately not accepted as a
// field here at all, not merely unused, so a caller cannot smuggle them in.
// fact: {..., forkCount?, dependentsCount?, releaseDownloadCount?}
function founderExecutionExternalUsage(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const forkCount = numOrNull(fact.forkCount);
  const dependentsCount = numOrNull(fact.dependentsCount);
  const releaseDownloadCount = numOrNull(fact.releaseDownloadCount);

  if (forkCount === null && dependentsCount === null && releaseDownloadCount === null) {
    return makeMissingClaim({
      topic: TOPIC.EXECUTION_EXTERNAL_USAGE,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const parts = [];
  if (forkCount !== null) parts.push(`${forkCount} fork${forkCount === 1 ? '' : 's'}`);
  if (dependentsCount !== null) parts.push(`${dependentsCount} dependent${dependentsCount === 1 ? '' : 's'}`);
  if (releaseDownloadCount !== null) {
    parts.push(`${releaseDownloadCount} release download${releaseDownloadCount === 1 ? '' : 's'}`);
  }

  return makeClaim({
    topic: TOPIC.EXECUTION_EXTERNAL_USAGE,
    textVerbatim: `Measured external usage: ${parts.join(', ')}. Stars are deliberately excluded (design §3, SIG-014 -- vanity, never weighted).`,
    value: {
      fork_count: forkCount,
      dependents_count: dependentsCount,
      release_download_count: releaseDownloadCount,
    },
    baseConfidence: BASE_CONFIDENCE_HARD_FACT,
    tier: tierForSource('github_api', ctx && ctx.identityConfidence),
    quoteVerbatim: null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.execution.provenance -- E7 (0.060), source github_api. design
// §5.3's anomaly triple: repo.createdAt vs earliest-commit vs
// account.createdAt, written into claims.value verbatim as documented.
// fact: {..., repoCreatedAt, firstCommitAt, accountCreatedAt}
function classifyProvenanceAnomaly({ repoCreatedAt, firstCommitAt, accountCreatedAt }) {
  const repoCreated = Date.parse(repoCreatedAt);
  const firstCommit = Date.parse(firstCommitAt);
  const accountCreated = Date.parse(accountCreatedAt);
  if (![repoCreated, firstCommit, accountCreated].every(Number.isFinite)) return 'none';
  if (repoCreated < accountCreated) return 'repo_predates_account';
  if (firstCommit < repoCreated) return 'commits_predate_repo';
  return 'none';
}

function founderExecutionProvenance(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const repoCreatedAt = nonEmptyString(fact.repoCreatedAt);
  const firstCommitAt = nonEmptyString(fact.firstCommitAt);
  const accountCreatedAt = nonEmptyString(fact.accountCreatedAt);

  if (!repoCreatedAt || !firstCommitAt || !accountCreatedAt) {
    return makeMissingClaim({
      topic: TOPIC.EXECUTION_PROVENANCE,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const anomaly = classifyProvenanceAnomaly({ repoCreatedAt, firstCommitAt, accountCreatedAt });

  return makeClaim({
    topic: TOPIC.EXECUTION_PROVENANCE,
    textVerbatim: `Repository created ${repoCreatedAt}; earliest commit ${firstCommitAt}; account created ${accountCreatedAt} (anomaly: ${anomaly}).`,
    value: { repo_created_at: repoCreatedAt, first_commit_at: firstCommitAt, account_created_at: accountCreatedAt, anomaly },
    baseConfidence: BASE_CONFIDENCE_HARD_FACT,
    tier: tierForSource('github_api', ctx && ctx.identityConfidence),
    quoteVerbatim: null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.expertise.vertical_tenure -- X1 (0.09375), source tavily_extract.
// design §3: personal site /about, /cv -- STATED tenure, VERBATIM (§3:
// "all text is stored verbatim"). fact: {..., quoteVerbatim}
function founderExpertiseVerticalTenure(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const quote = nonEmptyString(fact.quoteVerbatim);
  if (!quote) {
    return makeMissingClaim({
      topic: TOPIC.EXPERTISE_VERTICAL_TENURE,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  return makeClaim({
    topic: TOPIC.EXPERTISE_VERTICAL_TENURE,
    textVerbatim: quote,
    value: null,
    baseConfidence: BASE_CONFIDENCE_TEXT_SIGNAL,
    tier: tierForSource('tavily_extract', ctx && ctx.identityConfidence),
    quoteVerbatim: quote,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.expertise.insight_specificity -- X2 (0.075), source
// tavily_extract | hn_algolia. design §3: blog posts and the HN comment
// corpus, verbatim. fact: {..., quoteVerbatim, source?: 'hn_algolia'|'tavily_extract'}
function founderExpertiseInsightSpecificity(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const quote = nonEmptyString(fact.quoteVerbatim);
  if (!quote) {
    return makeMissingClaim({
      topic: TOPIC.EXPERTISE_INSIGHT_SPECIFICITY,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const source = fact.source === 'hn_algolia' ? 'hn_algolia' : 'tavily_extract';
  return makeClaim({
    topic: TOPIC.EXPERTISE_INSIGHT_SPECIFICITY,
    textVerbatim: quote,
    value: null,
    baseConfidence: BASE_CONFIDENCE_TEXT_SIGNAL,
    tier: tierForSource(source, ctx && ctx.identityConfidence),
    quoteVerbatim: quote,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.expertise.unasked_work -- X6 (0.075), source github_api |
// tavily_extract. design §3: substantial work predating any funding --
// repo history (a date-based structured fact, github_api) OR a site
// changelog entry (a verbatim quote, tavily_extract). Either is accepted;
// a real quote takes precedence over a bare date when both are present,
// since a verbatim excerpt is strictly more informative than a date alone.
// fact: {..., quoteVerbatim?, earliestArtifactDate?, source?}
function founderExpertiseUnaskedWork(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const quote = nonEmptyString(fact.quoteVerbatim);
  const earliestDate = nonEmptyString(fact.earliestArtifactDate);

  if (!quote && !earliestDate) {
    return makeMissingClaim({
      topic: TOPIC.EXPERTISE_UNASKED_WORK,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const source = fact.source === 'github_api' ? 'github_api' : 'tavily_extract';
  const textVerbatim = quote || `Earliest dated work found predates any funding event: ${earliestDate}.`;

  return makeClaim({
    topic: TOPIC.EXPERTISE_UNASKED_WORK,
    textVerbatim,
    value: earliestDate ? { earliest_artifact_date: earliestDate } : null,
    baseConfidence: quote ? BASE_CONFIDENCE_TEXT_SIGNAL : BASE_CONFIDENCE_HARD_FACT,
    tier: tierForSource(source, ctx && ctx.identityConfidence),
    quoteVerbatim: quote || null,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// founder.leadership.written_communication -- L5 (0.060), source
// hn_algolia | tavily_extract. design §3: Show HN post text, the author's
// own replies in their own thread, the homepage stranger-test -- all
// verbatim. fact: {..., quoteVerbatim, source?: 'hn_algolia'|'tavily_extract'}
function founderLeadershipWrittenCommunication(fact, ctx) {
  if (!hasUsableAttempt(fact)) return null;

  const quote = nonEmptyString(fact.quoteVerbatim);
  if (!quote) {
    return makeMissingClaim({
      topic: TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION,
      sourceUrl: fact.sourceUrl ?? null,
      rawSignalRef: fact.rawSignalRef,
    });
  }

  const source = fact.source === 'hn_algolia' ? 'hn_algolia' : 'tavily_extract';
  return makeClaim({
    topic: TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION,
    textVerbatim: quote,
    value: null,
    baseConfidence: BASE_CONFIDENCE_TEXT_SIGNAL,
    tier: tierForSource(source, ctx && ctx.identityConfidence),
    quoteVerbatim: quote,
    sourceUrl: fact.sourceUrl ?? null,
    rawSignalRef: fact.rawSignalRef,
  });
}

// PRODUCERS -- topic slug -> producer function. Lets a caller (or a test)
// iterate "every slug in §5.1" without hand-maintaining a second list that
// can drift from TOPIC.
const PRODUCERS = Object.freeze({
  [TOPIC.EXECUTION_MERGED_PR_FOREIGN]: founderExecutionMergedPrForeign,
  [TOPIC.EXECUTION_COMMIT_CONSISTENCY]: founderExecutionCommitConsistency,
  [TOPIC.EXECUTION_LIVE_PRODUCT]: founderExecutionLiveProduct,
  [TOPIC.EXECUTION_EXTERNAL_USAGE]: founderExecutionExternalUsage,
  [TOPIC.EXECUTION_PROVENANCE]: founderExecutionProvenance,
  [TOPIC.EXPERTISE_VERTICAL_TENURE]: founderExpertiseVerticalTenure,
  [TOPIC.EXPERTISE_INSIGHT_SPECIFICITY]: founderExpertiseInsightSpecificity,
  [TOPIC.EXPERTISE_UNASKED_WORK]: founderExpertiseUnaskedWork,
  [TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION]: founderLeadershipWrittenCommunication,
});

module.exports = {
  TOPIC,
  PRODUCERS,
  assertClaimWellFormed,
  tierForSource,
  MISSING_TEXT_VERBATIM,
  founderExecutionMergedPrForeign,
  founderExecutionCommitConsistency,
  founderExecutionLiveProduct,
  founderExecutionExternalUsage,
  founderExecutionProvenance,
  founderExpertiseVerticalTenure,
  founderExpertiseInsightSpecificity,
  founderExpertiseUnaskedWork,
  founderLeadershipWrittenCommunication,
};
