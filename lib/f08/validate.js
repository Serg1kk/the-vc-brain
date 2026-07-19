// lib/f08/validate.js
// SOURCE OF TRUTH: lib/f08/validate.js
//
// Server-side validation for feature 08 (Founder Intake), the backend half of
// the frozen `/webhook/f08-intake-submit` contract -- docs/backlog/
// 08-founder-intake-interview/lovable-brief.md §4.1/§6, design.md §3 step 1.
// The frontend (`web/src/lib/validation.ts`) already enforces the same caps
// client-side; this file is defense-in-depth for the same reason the source
// below states it twice -- a submitter (or feature 10's CLI, which posts to
// this same webhook per design.md §3) can bypass a browser trivially.
//
// `sanitizeFilename` and `safeWebUrl` are a VERBATIM (semantics-preserving)
// port from `internal/other-projects/reporting/lib/deals/submission-
// validation.ts` (Apache-2.0, tdavidson/reporting) -- ported per plan.md T5.
// Everything else here (field caps, artifact-kind inference, the aggregate
// payload validator) is new: reporting's own MIME/extension allowlist for
// attachments is NOT ported, because it does not apply to this product --
// `extra_files` here are deliberately unrestricted by type (lovable-brief.md
// §6.4: "up to 3 files of any type... only PDFs are read automatically in
// this version"), so porting reporting's restrictive allowlist would reject
// input the design explicitly wants accepted.
//
// Self-contained CommonJS, ZERO imports/requires (docs/backlog/TRACKER.md
// hard convention -- n8n Code nodes cannot require() from this repo).

'use strict';

// ============================================================================
// Field caps -- lovable-brief.md §6.2 ("Required fields -- exactly three")
// and §6.4 ("Optional sections"). Every number below traces to that table,
// not invented here.
// ============================================================================

const LIMITS = {
  COMPANY_NAME_MAX: 120,       // §6.2: "required, trim, 1..120 chars"
  EMAIL_MAX: 254,               // §6.2: "<=254 chars" (RFC 5321, same cap reporting.ts uses)
  DECK_MAX_BYTES: 10 * 1024 * 1024,   // §6.2/§6.3: ".pdf only, <=10 MB"
  ARTIFACT_LINKS_MAX: 5,        // §6.4: "up to 5 rows"
  EXTRA_FILES_MAX: 3,           // §6.4: "up to 3 files"
  EXTRA_FILE_MAX_BYTES: 25 * 1024 * 1024, // §6.4: "<=25 MB each"
  FILENAME_MAX: 200,            // reporting.ts's own sanitizeFilename cap, kept verbatim
};

// Stricter than `s.includes('@')`; RFC 5322 is byzantine and not worth fully
// enforcing -- verbatim from reporting.ts.
const EMAIL_RE = /^[^\s<>@,;:\\"[\]()]+@[^\s<>@,;:\\"[\]()]+\.[^\s<>@,;:\\"[\]()]+$/;

// Loose shape check, not a full RFC 4122 validator: `intake_submission_id`
// becomes `applications.id` (uuid PK) verbatim (design.md §3.2), so it only
// needs to be well-formed enough for Postgres to accept it -- rejecting it
// here with a clear `invalid_input` error is better than a raw DB 22P02 for
// the same input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// sanitizeFilename / safeWebUrl -- verbatim port of reporting.ts (Apache-2.0).
// Behaviour intentionally UNCHANGED from the source, including the aggressive
// "collapse any run of the disallowed set to one underscore each" approach --
// this is what the AC ("`../../etc/passwd` sanitised") relies on: replacing
// path separators first, THEN collapsing literal `..`, leaves no `/`, `\` or
// `..` substring in the output under any input, not merely the common cases.
// ============================================================================

// Strip control characters (NUL, CR, LF, etc.), path separators, and
// Windows-reserved punctuation; collapse `..`; cap length. Control-character
// stripping defends against CRLF injection if the filename later flows into
// an HTTP header (e.g. a Storage object's Content-Disposition on download).
function sanitizeFilename(name) {
  return String(name == null ? '' : name)
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, LIMITS.FILENAME_MAX);
}

// ============================================================================
// parseAbsoluteHttpUrl -- a manual regex/string URL parser. NOT `new URL()`.
//
// `URL` is undefined in this project's n8n Code-node sandbox -- confirmed
// live, not speculative: docs/backlog/02-sourcing-radar/done.md's carried-
// risk section and docs/backlog/02-sourcing-radar/tracker.md (~07:40) both
// record the incident. `parseArtifactUrl`'s own `try/catch` swallowed the
// `ReferenceError` from the missing global, and **every artifact silently
// classified as `kind:'none'` with nothing in the logs** -- an environment
// defect degraded into a plausible-looking wrong answer, invisible to
// `node --test` (which runs on real Node, where `URL` exists) and only
// found live, after deploy. The team lead's correction to this task
// (docs/backlog/08-founder-intake-interview/plan.md, "T5 -- URL is
// undefined in the n8n Code sandbox") is explicit: reimplement without
// `URL` rather than lean on a Code-node polyfill block existing correctly
// in every node that pastes this file.
//
// This function is deliberately written with NO try/catch anywhere: every
// branch is a plain string/regex operation (`String.prototype.trim`,
// `RegExp.prototype.exec`, `Array.prototype.filter`, ...) that cannot throw
// on well-formed JS input, so there is no ReferenceError-shaped failure
// mode left to swallow. A `null` return here always means "this input is
// not a safe http(s) URL", never "an environment global was missing".
//
// parseAbsoluteHttpUrl(input) -> null | {
//   scheme: 'http' | 'https',
//   hostRaw: string,       // lowercased, MAY still carry a leading 'www.'
//   hostNoWww: string,     // lowercased, 'www.'-stripped -- for host comparisons
//   pathSegments: string[],// non-empty path segments, taken BEFORE any '?'/'#'
//   normalized: string,    // scheme://authority + remainder ('/' if the
//                          // remainder was empty, matching `new URL().
//                          // toString()`'s own convention)
// }
function parseAbsoluteHttpUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  // RFC 3986 scheme grammar: ALPHA *(ALPHA / DIGIT / "+" / "-" / ".") ":".
  // Only treat input as "already carries a scheme" when this matches --
  // lovable-brief.md §6.4's placeholder (`github.com/you/project`) has none,
  // so bare hosts fall through to the `https://` prefix below, same as the
  // original ported behaviour.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;

  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(candidate);
  if (!m) return null; // no "scheme://authority" shape at all, even after prepending

  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  const authority = m[2];
  const remainder = m[3]; // path + optional query + optional fragment, verbatim

  if (!authority) return null; // empty host, e.g. "https:///path"

  // authority = [userinfo '@'] host [':' port]. Userinfo cannot itself
  // contain an unencoded '@', so ANY '@' here means embedded credentials --
  // reject outright (lovable-brief.md §6.4: "Reject URLs containing
  // credentials"). This file never tries to recover a "clean" host out of
  // a credentialed authority; the whole row is invalid.
  if (authority.indexOf('@') !== -1) return null;

  const colonIndex = authority.indexOf(':');
  const hostPart = colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  const portPart = colonIndex === -1 ? '' : authority.slice(colonIndex + 1);
  if (portPart && !/^\d+$/.test(portPart)) return null; // malformed port

  // Standard DNS hostname charset only -- rejects whitespace/garbage that
  // would otherwise be silently accepted as a "host" (e.g. "not a url at
  // all" has no '/', '?', '#', or '@', so it would parse as an authority
  // with no other check catching it).
  if (!/^[a-zA-Z0-9.-]+$/.test(hostPart)) return null;

  const hostRaw = hostPart.toLowerCase();
  const hostNoWww = hostRaw.startsWith('www.') ? hostRaw.slice(4) : hostRaw;

  const pathOnly = remainder.split(/[?#]/)[0] || '';
  const pathSegments = pathOnly.split('/').filter(Boolean);

  return {
    scheme,
    hostRaw,
    hostNoWww,
    pathSegments,
    normalized: `${scheme}://${authority}${remainder || '/'}`,
  };
}

// Accept only http(s) URLs. Rejects `javascript:`, `data:`, `file:`,
// `vbscript:`, etc. Returns the normalized URL string on success, null on
// failure. Also rejects URLs with embedded credentials
// (`https://user:pass@host/`) -- a submitter could pass
// `https://attacker.com@legit.com/`, which a naive parser reads as a
// request to `legit.com` with username `attacker.com` -- visually
// deceptive in any UI that renders the raw URL. lovable-brief.md §6.4
// calls this out explicitly.
//
// The ORIGINAL ported `reporting.ts` version (`check(input) ?? check(
// \`https://${input}\`)`, backed by `new URL()`) has a real bug worth
// recording even though this file no longer contains that code: it retries
// the https:// prefix on ANY null from the first attempt, including a null
// caused by a REJECTION (embedded credentials), not only a parse failure.
// For `https://attacker.com@legit.com/` that means the first parse
// correctly rejects on the credentials, but the retry then parses
// `https://https://attacker.com@legit.com/`, in which the credentials fall
// out of authority position entirely and the retry's own check passes --
// the exact bypass the function exists to prevent. `parseAbsoluteHttpUrl`
// above parses the raw input exactly ONCE (falling back to the https://
// prefix only when the raw string does not parse as an absolute URL AT
// ALL) and is not vulnerable to this class of bug by construction.
function safeWebUrl(input) {
  const parsed = parseAbsoluteHttpUrl(input);
  return parsed ? parsed.normalized : null;
}

// ============================================================================
// Artifact-kind inference -- lovable-brief.md §6.4's table. The client infers
// `kind` too (so the founder is never asked to choose it, per that section),
// but the client-supplied value is NOT trusted here: `validateArtifactLink`
// below re-derives it from the URL itself, the same "an admin can typo a URL
// just as easily as anyone else" defense-in-depth reporting.ts's own header
// comment argues for.
//
// | Pattern                          | kind          |
// |-----------------------------------|---------------|
// | github.com/<owner>/<repo>        | github_repo   |
// | github.com/<owner> (no repo)     | github_user   |
// | any other valid http(s) URL      | product       |
// | unparseable                      | other         |
//
// Two extensions beyond that literal table, both folding into `other`
// rather than a contradiction of it: a bare `github.com` URL with NO path
// segment at all (neither a repo nor a user link -- the same "nothing
// useful here" case lib/f02/normalize.js's `parseArtifactUrl` calls
// `kind:'none'`, folded here because this contract's enum has no separate
// `none` slot); and anything `parseAbsoluteHttpUrl` rejects for a SECURITY
// reason (embedded credentials), not only a genuine parse failure -- this
// function is a classifier, not a gate, and the gate (`validateArtifactLink`
// below) drops such rows before storage regardless of what they'd classify
// as here.
function inferArtifactKind(url) {
  const parsed = parseAbsoluteHttpUrl(url);
  if (!parsed) return 'other';
  if (parsed.hostNoWww !== 'github.com') return 'product';
  if (parsed.pathSegments.length === 0) return 'other';
  if (parsed.pathSegments.length === 1) return 'github_user';
  return 'github_repo';
}

// Parses the owner and repo out of a github.com URL that inferArtifactKind
// already classified as github_repo/github_user -- kept separate from
// inferArtifactKind (which only classifies) because lib/f08/identity.js
// needs the owner string itself, not just the kind label, and duplicates
// this same small parser rather than requiring this file (zero-imports
// constraint; see that file's header for the established repo pattern).
function parseGithubOwnerRepo(url) {
  const parsed = parseAbsoluteHttpUrl(url);
  if (!parsed || parsed.hostNoWww !== 'github.com' || parsed.pathSegments.length === 0) {
    return { owner: null, repo: null };
  }
  const owner = parsed.pathSegments[0];
  const repo = parsed.pathSegments.length >= 2 ? parsed.pathSegments[1].replace(/\.git$/i, '') : null;
  return { owner, repo };
}

// Validates + normalizes ONE `artifact_links` row -> `{url, kind}` on
// success, or `null` to signal "drop this row" (lovable-brief.md §6.4:
// "Empty rows are dropped silently, not flagged" -- extended here to cover
// any row this backend cannot turn into a safe http(s) URL: a credentialed
// URL is explicitly REJECTED per §6.4, and a genuinely unparseable one
// cannot be safely stored or linked to either. Both fail the SAME
// `safeWebUrl` check, and both are therefore dropped the same way -- non-
// blocking, since links are optional and the field has no error code of its
// own in §4.5. Note: this means `kind:'other'` from `inferArtifactKind`
// above can only survive INTO the stored payload for the one case that
// really is a valid, safe URL just not a useful one -- a bare `github.com`
// with no owner (see the comment above). `inferArtifactKind` itself is
// still exported standalone because a genuinely-unparseable string is worth
// classifying for diagnostics/tests even though it never reaches storage.
function validateArtifactLink(item) {
  const rawUrl = item && typeof item === 'object' ? item.url : item;
  if (rawUrl === null || rawUrl === undefined) return null;
  const trimmed = String(rawUrl).trim();
  if (!trimmed) return null; // empty row -- dropped silently, not flagged

  const normalized = safeWebUrl(trimmed);
  if (!normalized) return null; // bad scheme, embedded credentials, or unparseable -- dropped

  return { url: normalized, kind: inferArtifactKind(normalized) };
}

// ============================================================================
// Per-field validators. Each returns `null` on success or `{code, message}`
// on failure, matching lovable-brief.md §4.5's error shape so a caller can
// surface it directly.
// ============================================================================

function validateCompanyName(companyName) {
  const trimmed = String(companyName == null ? '' : companyName).trim();
  if (!trimmed) {
    return { code: 'invalid_input', message: 'Company name is required.' };
  }
  if (trimmed.length > LIMITS.COMPANY_NAME_MAX) {
    return { code: 'invalid_input', message: `Company name must be ${LIMITS.COMPANY_NAME_MAX} characters or fewer.` };
  }
  return null;
}

// `invalid_email` is one of §4.5's frozen known codes -- used verbatim here,
// not the generic `invalid_input` this file uses for caps §4.5 leaves unnamed.
function validateEmail(email) {
  const trimmed = String(email == null ? '' : email).trim();
  if (!trimmed) {
    return { code: 'invalid_email', message: 'Contact email is required.' };
  }
  if (trimmed.length > LIMITS.EMAIL_MAX) {
    return { code: 'invalid_email', message: `Email must be ${LIMITS.EMAIL_MAX} characters or fewer.` };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { code: 'invalid_email', message: 'Enter a valid email address.' };
  }
  return null;
}

// Estimates decoded byte size from a base64 string without actually
// decoding it (n8n's Code-node sandbox has `Buffer`, but this file avoids
// depending on it so the same logic is portable to a plain browser/test
// context too): 3 bytes per 4 base64 chars, minus '=' padding.
function base64ByteLength(base64) {
  const s = String(base64 == null ? '' : base64);
  const len = s.length;
  if (len === 0) return 0;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function validateDeck(deck) {
  if (!deck || typeof deck !== 'object') {
    return { code: 'unsupported_file_type', message: 'A deck file is required.' };
  }
  const filename = String(deck.filename == null ? '' : deck.filename).trim();
  const mime = String(deck.mime == null ? '' : deck.mime).trim().toLowerCase();
  const isPdfMime = mime === 'application/pdf';
  const isPdfName = /\.pdf$/i.test(filename);
  if (!isPdfMime && !isPdfName) {
    return { code: 'unsupported_file_type', message: 'The deck must be a PDF file.' };
  }
  if (!deck.base64 || typeof deck.base64 !== 'string') {
    return { code: 'unsupported_file_type', message: 'A deck file is required.' };
  }
  if (base64ByteLength(deck.base64) > LIMITS.DECK_MAX_BYTES) {
    return { code: 'deck_too_large', message: 'The deck must be 10 MB or smaller.' };
  }
  return null;
}

// Extra files are NOT validated by type (product decision, §6.4: "any
// type"). An oversized one is dropped rather than failing the whole
// submission -- consistent with the non-blocking treatment of every other
// optional-array row in this file (empty/invalid artifact links).
function validateExtraFile(file) {
  if (!file || typeof file !== 'object') return null; // drop malformed row
  if (typeof file.base64 !== 'string' || !file.base64) return null; // drop, no content
  if (base64ByteLength(file.base64) > LIMITS.EXTRA_FILE_MAX_BYTES) return null; // drop, too large
  return {
    filename: sanitizeFilename(file.filename || 'file'),
    mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream',
    base64: file.base64,
  };
}

// ============================================================================
// validateIntakePayload -- the aggregate entry point, design.md §3 step 1.
// Runs the required-field checks in a fixed order and returns the FIRST
// blocking error (the §4.5 contract carries exactly one error object per
// response); optional arrays are filtered/capped silently and never block.
// ============================================================================

function validateIntakePayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};

  const submissionId = String(p.intake_submission_id == null ? '' : p.intake_submission_id).trim();
  if (!submissionId || !UUID_RE.test(submissionId)) {
    return { ok: false, error: { code: 'invalid_input', message: 'intake_submission_id must be a uuid.' } };
  }

  const companyNameError = validateCompanyName(p.company_name);
  if (companyNameError) return { ok: false, error: companyNameError };

  const emailError = validateEmail(p.contact_email);
  if (emailError) return { ok: false, error: emailError };

  const deckError = validateDeck(p.deck);
  if (deckError) return { ok: false, error: deckError };

  const artifactLinksIn = Array.isArray(p.artifact_links) ? p.artifact_links : [];
  const artifactLinks = artifactLinksIn
    .map(validateArtifactLink)
    .filter((row) => row !== null)
    .slice(0, LIMITS.ARTIFACT_LINKS_MAX);

  const extraFilesIn = Array.isArray(p.extra_files) ? p.extra_files : [];
  const extraFiles = extraFilesIn
    .map(validateExtraFile)
    .filter((row) => row !== null)
    .slice(0, LIMITS.EXTRA_FILES_MAX);

  return {
    ok: true,
    value: {
      intake_submission_id: submissionId,
      company_name: String(p.company_name).trim().slice(0, LIMITS.COMPANY_NAME_MAX),
      contact_email: String(p.contact_email).trim().toLowerCase(),
      deck: {
        filename: sanitizeFilename(p.deck.filename || 'deck.pdf'),
        mime: 'application/pdf',
        base64: p.deck.base64,
      },
      artifact_links: artifactLinks,
      extra_files: extraFiles,
    },
  };
}

module.exports = {
  LIMITS,
  EMAIL_RE,
  UUID_RE,
  sanitizeFilename,
  safeWebUrl,
  inferArtifactKind,
  parseGithubOwnerRepo,
  validateArtifactLink,
  validateCompanyName,
  validateEmail,
  validateDeck,
  validateExtraFile,
  base64ByteLength,
  validateIntakePayload,
};
