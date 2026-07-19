// lib/f08/hashing.js
// SOURCE OF TRUTH: lib/f08/hashing.js
//
// Content-hash recipes for feature 08 (Founder Intake): `raw_signals`,
// `claims` and `evidence` all carry `content_hash ... UNIQUE` (db/schema.sql),
// and design.md §3.2 fixes the rule that makes retries and re-applications
// behave correctly against that constraint: **every recipe here includes
// `application_id`.**
//
// Why, restated from design.md §3.2 so this file is self-explaining:
// `applications.id := intake_submission_id`, so a RETRY (the frontend
// re-sends the same id by design) collides on the PRIMARY KEY -- that is
// the idempotency mechanism, and this file has nothing to do with it. A
// RE-APPLICATION (the founder applies again, later, with a fresh
// `intake_submission_id`) is deliberately a NEW `applications` row --
// design.md calls this out as preserving "the rejection -> growth -> return
// trajectory" (SIG-025). Without `application_id` in the hash, a founder
// re-applying with the identical deck would compute the SAME content_hash
// as their first application and raise `23505` on every one of
// raw_signals/claims/evidence, failing the whole intake. With it, a RETRY
// (same application_id) still dedupes correctly (idempotent Code-node
// re-execution, not just the DB-level PK collision), while a RE-APPLICATION
// (different application_id) does not collide.

'use strict';

// Hashing mechanism -- CORRECTED (docs/backlog/TRACKER.md, ~10:45 entry,
// "the recorded Code-node sandbox convention is WRONG"): this file
// previously used `globalThis.crypto.subtle.digest(...)`, on the strength
// of the earlier documented convention plus an inference from feature 02's
// `RUNTIME_POLYFILL_JS` (`globalThis.crypto = require('crypto').webcrypto`).
//
// To be precise about what the team lead's live probe actually found (an
// earlier version of this comment overstated it): the webcrypto polyfill
// DOES work --
//   typeof globalThis.crypto.subtle                                -> "undefined" (before)
//   globalThis.crypto = require('crypto').webcrypto; typeof ....subtle -> "object"  (after)
//   await globalThis.crypto.subtle.digest('SHA-256', ...)           -> correct digest
// -- confirmed live in a real Code node. Switching to `createHash` was not
// a "the polyfill is broken" fix; it is a "simpler and already-proven"
// choice: synchronous, no global-mutation/polyfill step to get right, and
// exactly what every already-deployed workflow in this repo (f03, f04, f07)
// already uses. Recorded here precisely because a wrong explanation in a
// file headed SOURCE OF TRUTH is exactly how the original backwards
// convention got established -- the point is not to repeat that.
//
// `require('crypto')` uses the BARE specifier -- confirmed live that
// `require('node:crypto')` (the `node:`-prefixed form some other lib/*.js
// files in this repo use) throws in this sandbox. Requiring a Node
// BUILT-IN module is the sandbox-confirmed exception to the "zero imports"
// hard convention, which is about requiring REPO FILES (genuinely
// impossible, no bind-mount) -- not about built-ins, which
// `NODE_FUNCTION_ALLOW_BUILTIN` in `infra/n8n/docker-compose.yml` allows.
//
// Every hashing function below is therefore SYNCHRONOUS now (`createHash`
// has no async form to begin with) -- callers no longer need to `await`
// them. This is a behavioural change from this file's first version, not
// just a mechanism swap: anything that already called these with `await`
// still works (`await` on a non-promise value is a no-op), but nothing may
// rely on these returning a `Promise` going forward.
const crypto = require('crypto');

// ============================================================================
// sha256Hex / hashFields -- same shape as lib/f04/provenance.js's and
// lib/f07/hashes.js's own sha256Hex/hashFields (both already synchronous,
// both already using this exact `createHash` mechanism -- this file now
// matches them instead of diverging). The join delimiter is this file's
// OWN choice (design.md does not specify one for 08's recipes, same as
// 07's own note about its recipes) -- '::' is used for consistency with
// lib/f02/normalize.js's convention, and is safe here because none of the
// fields hashed below (uuids, criterion ids, topic slugs, caller-supplied
// content keys) can themselves contain '::'.
// ============================================================================

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

const HASH_FIELD_DELIMITER = '::';

function hashFields(...parts) {
  const basis = parts
    .map((part) => (part === null || part === undefined ? '' : String(part)))
    .join(HASH_FIELD_DELIMITER);
  return sha256Hex(basis);
}

// ============================================================================
// contentHash -- the three recipes design.md §3.2 requires. Every one takes
// `application_id` as its first field, by convention, so a reader scanning
// this file top-to-bottom sees the rule applied uniformly rather than
// having to check each recipe individually.
// ============================================================================

const contentHash = {
  // raw_signals.content_hash = sha256(application_id :: source ::
  // content_key). `content_key` is caller-supplied and is whatever
  // discriminates THIS raw signal's content from another one on the same
  // application -- the deck's own base64 (or extracted text) for the
  // `source='deck_parse'` write (design.md §3 step 5), or e.g.
  // `${criterion_id}::${answer_text}` for a `source='interview_answer'`
  // gap-answer write (design.md §7/§8). Not pre-hashed by this file: it is
  // joined into the same delimited basis as every other field, which is
  // simpler and no less collision-resistant than hashing it twice.
  rawSignal({ application_id, source, content_key }) {
    return hashFields(application_id, source, content_key);
  },

  // claims.content_hash = sha256(application_id :: card_id :: topic ::
  // item_key). `item_key` defaults to '_' for singleton topics -- same
  // convention lib/f07/hashes.js's claim() recipe and lib/f04/provenance.js's
  // both already use, kept for consistency even though none of 08's own
  // founder.expertise.*/founder.leadership.* topics are currently
  // multi-row-per-application.
  claim({ application_id, card_id, topic, item_key }) {
    return hashFields(application_id, card_id, topic, item_key == null || item_key === '' ? '_' : item_key);
  },

  // evidence.content_hash = sha256(application_id :: claim_id :: relation ::
  // raw_signal_id). lib/f07/hashes.js's evidence() recipe omits
  // raw_signal_id because 07 writes exactly one supporting row per claim
  // (claim_id, relation) is already unique there. 08 additionally includes
  // raw_signal_id: an image-only deck (design.md §5) writes a `missing`
  // claim WITH evidence (tier='missing') for every expected topic on the
  // SAME `raw_signals` row, and a later gap-answer can add a second,
  // interview-sourced evidence row for a topic the deck already produced a
  // missing-marker for -- both would otherwise land on the same
  // (claim_id, relation='supports') pair. Discriminating on raw_signal_id
  // keeps that case from a spurious 23505 without changing behaviour for
  // the common single-evidence-per-claim case.
  evidence({ application_id, claim_id, relation, raw_signal_id }) {
    return hashFields(application_id, claim_id, relation, raw_signal_id);
  },
};

module.exports = {
  sha256Hex,
  hashFields,
  contentHash,
};
