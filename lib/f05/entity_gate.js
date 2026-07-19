// lib/f05/entity_gate.js
// SOURCE OF TRUTH: lib/f05/entity_gate.js
//
// The entity-resolution gate for feature 05 (Truth-Gap Check & Trust Score),
// design.md SS6 (all subsections). This is the structural guard against the
// >80% false-contradiction rate REFNLI measured when evidence context does
// not actually match the claim's subject (a deck claim checked against a
// page about a similarly-named company): "No `contradicted` verdict may be
// written until the evidence is proven to be about this entity."
//
// Self-contained CommonJS. ZERO imports -- this file's body is pasted
// verbatim into an n8n Code node (plan.md Wave T0's binding rule #3); n8n's
// sandbox cannot require() from the repo (no bind-mount). No Date.now(), no
// Math.random(), no top-level side effects -- every function here is a pure
// function of its arguments except step 3's optional model hook, which is an
// injected async callback the caller supplies.
//
// docs/backlog/05-truth-gap-trust/plan.md, task B2.
//
// ============================================================================
// The four ordered, fail-closed steps (design.md SS6):
//   1. evidence.raw_signal_id carries a founder_id/company_id FK matching the
//      claim's own entity -> resolved by construction.
//   2. else the source's registrable domain matches companies.domain or an
//      entry in companies.aliases.
//   3. else an injected model hook may return an explicit entity_match
//      (verbatim quote + disambiguator) -- THIS STEP IS OWNED BY TASK C1b.
//      applyEntityGate() only defines and validates the hook's CONTRACT; the
//      hook itself is not implemented here and is optional (omit/undefined
//      to skip step 3 entirely and fall straight through to step 4).
//   4. else -> downgrade `contradicted` to `unverified` and produce an
//      auditable `context` evidence row recording that a contradiction
//      candidate failed the gate. The candidate is never silently dropped.
//
// Only CONTRADICTION candidates ever reach this gate. `supports` evidence
// carries no false-accusation risk against a founder and is not gated here
// (design.md SS6.0's entity hierarchy and SS6's >80%-false-contradiction
// citation are both specifically about mistakenly REFUTING a claim against
// the wrong entity -- corroborating the wrong entity is not the failure mode
// this feature exists to prevent, and 04/07 already write unguarded
// `supports` rows on their own claims). Callers must not route `supports`
// candidates through this gate.
//
// ============================================================================
// Integration contract with lib/f05/verifiers.js (deliberately NOT required
// here -- both files must stay zero-import, per plan.md's binding rule):
// on a step-4 downgrade, `contextRowFields` below is the set of fields
// verifiers.buildEvidenceRow() needs to finalise (compute content_hash) and
// insert. Fields are camelCase here to match buildEvidenceRow's own param
// names; the caller (lib/f05/run.js, task B3, which MAY require() freely)
// is what actually wires the two modules together:
//
//   const gate = await applyEntityGate({ claimId, candidate, rawSignal, entity });
//   if (!gate.resolved) {
//     const row = await verifiers.buildEvidenceRow(gate.contextRowFields);
//     // ... INSERT row into `evidence` ...
//   }
// ============================================================================

'use strict';

// ============================================================================
// Registrable-domain (eTLD+1) extraction -- step 2's "registrable domain"
// comparison. Duplicated in this file rather than shared with
// lib/f05/verifiers.js or any other feature's lib/*/normalize.js, because
// every SOURCE-OF-TRUTH file in this repo must stay independently
// zero-import (see lib/f07/hashes.js's header for the identical rationale
// re: duplicating lib/f04/provenance.js's contentHash pattern instead of
// requiring it).
//
// Accepts EITHER a full URL ("https://blog.photoai.com/post") or a bare
// hostname ("photoai.com", the shape companies.domain and companies.aliases
// entries are stored in per the live schema -- see design.md SS6, "the
// source's registrable domain matches companies.domain or an entry in
// companies.aliases"). Reduces to eTLD+1 so a subdomain (blog.photoai.com)
// still matches the bare company domain (photoai.com).
// ============================================================================

// Common two-label public suffixes (co.uk, com.au, ...) where the
// registrable domain is the LAST THREE labels, not the last two. Same short,
// deliberately-not-exhaustive list as lib/f02/normalize.js's
// TWO_LABEL_SUFFIX_SECOND_LEVEL / lib/f04/provenance.js's
// TWO_LABEL_PUBLIC_SUFFIXES -- a full public-suffix-list dependency is out of
// scope for a zero-import file, and this project's candidate pool (pre-seed
// startups, `.example`/`.com`/`.ai`/`.io`-style domains) rarely needs more.
const TWO_LABEL_PUBLIC_SUFFIXES = Object.freeze([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'co.in', 'co.jp', 'co.kr', 'com.br', 'com.mx',
]);

function hostFromUrlOrHost(urlOrHost) {
  if (!urlOrHost) return null;
  let raw = String(urlOrHost).trim().toLowerCase();
  if (!raw) return null;
  if (!raw.includes('://')) raw = 'http://' + raw;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch (_e) {
    return null;
  }
  if (host.startsWith('www.')) host = host.slice(4);
  return host || null;
}

// registrableDomain(urlOrHost) -> eTLD+1, or null for empty/unparseable
// input or a bare host with no dot at all (e.g. "localhost").
function registrableDomain(urlOrHost) {
  const host = hostFromUrlOrHost(urlOrHost);
  if (!host || !host.includes('.')) return null;
  const labels = host.split('.');
  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join('.');
    if (TWO_LABEL_PUBLIC_SUFFIXES.indexOf(lastTwo) !== -1) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

// domainMatchesEntity(sourceUrl, entity) -> the matched registrable domain
// string, or null. entity.companyDomain and each entry of
// entity.companyAliases are themselves normalised through registrableDomain()
// before comparing, so a domain stored with a stray "www." or different
// casing still matches.
function domainMatchesEntity(sourceUrl, entity) {
  const candidateDomain = registrableDomain(sourceUrl);
  if (!candidateDomain) return null;

  const companyDomain = registrableDomain(entity && entity.companyDomain);
  if (companyDomain && companyDomain === candidateDomain) return companyDomain;

  const aliases = entity && Array.isArray(entity.companyAliases) ? entity.companyAliases : [];
  for (let i = 0; i < aliases.length; i++) {
    const aliasDomain = registrableDomain(aliases[i]);
    if (aliasDomain && aliasDomain === candidateDomain) return aliasDomain;
  }
  return null;
}

// ============================================================================
// applyEntityGate -- the four ordered steps.
//
// Params:
//   claimId:   uuid -- the claim the candidate contradicts, carried through
//              into contextRowFields.claimId on a step-4 downgrade.
//   candidate: {
//     sourceUrl: string|null,  -- the contradicting evidence's own source_url
//     quote:     string,       -- verbatim finding text (found_reality); also
//                                 what becomes quote_verbatim on downgrade
//     tier:      'documented'|'discovered'|'inferred'|'missing' -- the
//                                 candidate's OWN evidence tier, passed
//                                 through unchanged (the gate governs WHETHER
//                                 a contradiction may stand, not what tier the
//                                 underlying evidence carries)
//   }
//   rawSignal: { id, founderId, companyId } | null -- the raw_signals row the
//              candidate evidence was resolved through via evidence
//              .raw_signal_id (SS2.1). null when no raw_signal is reachable
//              (step 1 then simply does not resolve; step 2 is still tried).
//   entity:    {
//     founderId:      uuid|null, -- the CLAIM's own founder (from its card)
//     companyId:      uuid|null, -- the CLAIM's own company (from its card)
//     founderName:    string|null (optional, for a human-readable disambiguator)
//     companyName:    string|null (optional, ditto)
//     companyDomain:  string|null,
//     companyAliases: string[]|undefined,
//   }
//   matchWithLlm: optional async (candidate, entity) => { quote, disambiguator }
//              | null -- step 3's hook. THIS IS THE C1b-OWNED INTERFACE: when
//              omitted/undefined, step 3 is skipped entirely and the gate
//              falls straight to step 4. When supplied, applyEntityGate only
//              validates the STRUCTURAL shape of what it returns (both
//              fields present and non-empty) -- verifying the quote is truly
//              verbatim against the model's own source text is the agent's
//              own constrained-generation responsibility (design.md SS11.1:
//              "may only answer from a supplied quote"), not re-derived here
//              because this module has no access to that source text.
//
// Returns (always synchronously-shaped, but the function itself is async
// because step 3's hook may be):
//   {
//     resolved:        boolean,
//     entityMatch:     { resolved_by, quote, disambiguator } | null,  -- §6.1
//     downgradedTo:    'unverified' | null,
//     contextRowFields: null | {
//       claimId, relation: 'context', tier, quoteVerbatim, sourceUrl,
//       rawSignalId, checkId: 'entity_gate', candidateKey,
//     },
//   }
// ============================================================================

function resolvedResult(resolvedBy, quote, disambiguator) {
  return {
    resolved: true,
    entityMatch: { resolved_by: resolvedBy, quote: quote, disambiguator: disambiguator },
    downgradedTo: null,
    contextRowFields: null,
  };
}

async function applyEntityGate(params) {
  const claimId = params && params.claimId;
  const candidate = (params && params.candidate) || {};
  const rawSignal = (params && params.rawSignal) || null;
  const entity = (params && params.entity) || {};
  const matchWithLlm = params && params.matchWithLlm;

  // ---- Step 1: raw_signal_id FK resolution -------------------------------
  // Only an EXACT match resolves by construction. A raw_signal carrying a
  // conflicting FK (present, but pointing at a DIFFERENT founder/company than
  // this claim) does not fail the gate outright here -- it simply does not
  // resolve at step 1, and falls through to step 2's domain check, which may
  // still legitimately confirm the same entity by a different route. This is
  // the conservative reading: design.md SS6 lists exactly one condition for
  // step 1 to resolve ("carries a founder_id/company_id FK"), and does not
  // specify an early-fail branch for a mismatching FK, so this file does not
  // invent one.
  if (rawSignal) {
    if (rawSignal.founderId && entity.founderId && rawSignal.founderId === entity.founderId) {
      return resolvedResult('raw_signal_fk', candidate.quote, entity.founderName || entity.founderId);
    }
    if (rawSignal.companyId && entity.companyId && rawSignal.companyId === entity.companyId) {
      return resolvedResult('raw_signal_fk', candidate.quote, entity.companyName || entity.companyId);
    }
  }

  // ---- Step 2: registrable-domain match -----------------------------------
  const matchedDomain = domainMatchesEntity(candidate.sourceUrl, entity);
  if (matchedDomain) {
    return resolvedResult('domain', candidate.quote, matchedDomain);
  }

  // ---- Step 3: injected model hook (owned by task C1b; optional here) ----
  if (typeof matchWithLlm === 'function') {
    const llmResult = await matchWithLlm(candidate, entity);
    if (
      llmResult &&
      typeof llmResult.quote === 'string' && llmResult.quote.trim() &&
      typeof llmResult.disambiguator === 'string' && llmResult.disambiguator.trim()
    ) {
      return resolvedResult('llm_quote', llmResult.quote, llmResult.disambiguator);
    }
    // A hook that returned null/undefined/malformed output means "the model
    // could not resolve it" -- falls through to step 4, same as no hook at
    // all. This is NOT an error: an honest "no match" is exactly what step 4
    // exists to record.
  }

  // ---- Step 4: downgrade + auditable context row -------------------------
  // The candidate is never silently dropped -- contextRowFields carries the
  // candidate's own text into quote_verbatim (SS10.1: "for entity-gate-
  // failure rows the candidate text itself, which also goes in
  // quote_verbatim"), so the attempt remains queryable even though it may
  // never become a `contradicted` verdict.
  return {
    resolved: false,
    entityMatch: null,
    downgradedTo: 'unverified',
    contextRowFields: {
      claimId: claimId,
      relation: 'context',
      tier: candidate.tier,
      quoteVerbatim: candidate.quote,
      sourceUrl: candidate.sourceUrl == null ? null : candidate.sourceUrl,
      rawSignalId: rawSignal ? rawSignal.id : null,
      checkId: 'entity_gate',
      // candidateKey is the candidate's own text (SS10.1) -- this is what
      // keeps two DIFFERENT failed candidates on the SAME claim from
      // colliding on content_hash once verifiers.buildEvidenceRow() hashes
      // this row (claim_id + relation='context' + check_id='entity_gate'
      // alone would be identical across every failed candidate on a claim).
      candidateKey: candidate.quote,
    },
  };
}

module.exports = {
  applyEntityGate,
  domainMatchesEntity,
  registrableDomain,
};
