// lib/f08/validate.test.js
//
// Acceptance tests for lib/f08/validate.js, per docs/backlog/
// 08-founder-intake-interview/plan.md T5. Run with: node --test lib/f08/*.js
// (glob form -- the directory form fails with MODULE_NOT_FOUND on Node
// v22.19.0).
//
// This file MAY require() -- only lib/f08/validate.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
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
  LIMITS,
} = require('./validate.js');

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const SMALL_PDF_BASE64 = Buffer.from('%PDF-1.4 minimal fixture').toString('base64');

function validPayload(overrides = {}) {
  return {
    intake_submission_id: VALID_UUID,
    company_name: 'Acme Robotics',
    contact_email: 'Founder@Acme.dev',
    deck: { filename: 'acme-deck.pdf', mime: 'application/pdf', base64: SMALL_PDF_BASE64 },
    artifact_links: [],
    extra_files: [],
    ...overrides,
  };
}

describe('safeWebUrl -- ported from reporting.ts', () => {
  test('rejects a URL with embedded credentials', () => {
    assert.equal(safeWebUrl('https://attacker.com@legit.com/'), null);
  });

  test('rejects a SCHEMELESS credentialed URL too (bare-host fallback path)', () => {
    assert.equal(safeWebUrl('attacker.com@legit.com/'), null);
  });

  test('rejects javascript: and other non-http(s) schemes', () => {
    assert.equal(safeWebUrl('javascript:alert(1)'), null);
    assert.equal(safeWebUrl('data:text/html,hi'), null);
  });

  test('accepts a bare host by prepending https://', () => {
    assert.equal(safeWebUrl('github.com/acme/core'), 'https://github.com/acme/core');
  });

  test('accepts a normal https URL unchanged in substance', () => {
    assert.equal(safeWebUrl('https://example.com/path'), 'https://example.com/path');
  });
});

describe('sanitizeFilename -- ported from reporting.ts', () => {
  test('strips path traversal and separators from "../../etc/passwd"', () => {
    const sanitized = sanitizeFilename('../../etc/passwd');
    assert.ok(!sanitized.includes('..'));
    assert.ok(!sanitized.includes('/'));
  });

  test('strips CR/LF (header-injection defense)', () => {
    const sanitized = sanitizeFilename('deck.pdf\r\nX-Injected: true');
    assert.ok(!sanitized.includes('\r'));
    assert.ok(!sanitized.includes('\n'));
  });

  test('caps length', () => {
    const sanitized = sanitizeFilename('a'.repeat(500) + '.pdf');
    assert.ok(sanitized.length <= LIMITS.FILENAME_MAX);
  });
});

describe('inferArtifactKind -- lovable-brief.md §6.4 table', () => {
  test('github.com/<owner>/<repo> -> github_repo', () => {
    assert.equal(inferArtifactKind('https://github.com/acme/core'), 'github_repo');
  });

  test('github.com/<owner> (no repo) -> github_user', () => {
    assert.equal(inferArtifactKind('https://github.com/acme'), 'github_user');
  });

  test('any other valid http(s) URL -> product', () => {
    assert.equal(inferArtifactKind('https://acme.dev'), 'product');
  });

  test('unparseable -> other', () => {
    assert.equal(inferArtifactKind('not a url at all'), 'other');
    assert.equal(inferArtifactKind(''), 'other');
    assert.equal(inferArtifactKind(null), 'other');
  });

  test('bare github.com with no owner -> other (extension beyond the table)', () => {
    assert.equal(inferArtifactKind('https://github.com'), 'other');
  });
});

describe('parseGithubOwnerRepo', () => {
  test('extracts owner and repo, stripping .git', () => {
    assert.deepEqual(parseGithubOwnerRepo('https://github.com/acme/core.git'), { owner: 'acme', repo: 'core' });
  });

  test('owner-only URL has no repo', () => {
    assert.deepEqual(parseGithubOwnerRepo('https://github.com/acme'), { owner: 'acme', repo: null });
  });

  test('non-github URL resolves to nulls', () => {
    assert.deepEqual(parseGithubOwnerRepo('https://acme.dev'), { owner: null, repo: null });
  });
});

describe('validateArtifactLink', () => {
  test('a credentialed URL is rejected (dropped, not stored)', () => {
    assert.equal(validateArtifactLink({ url: 'https://attacker.com@legit.com/' }), null);
  });

  test('an empty row is dropped silently rather than flagged', () => {
    assert.equal(validateArtifactLink({ url: '' }), null);
    assert.equal(validateArtifactLink({ url: '   ' }), null);
    assert.equal(validateArtifactLink({}), null);
  });

  test('a valid github repo link normalizes and classifies', () => {
    assert.deepEqual(validateArtifactLink({ url: 'github.com/acme/core' }), {
      url: 'https://github.com/acme/core',
      kind: 'github_repo',
    });
  });

  test('does not trust a client-supplied kind -- always re-derives it', () => {
    const result = validateArtifactLink({ url: 'https://acme.dev', kind: 'github_repo' });
    assert.equal(result.kind, 'product');
  });
});

describe('validateCompanyName', () => {
  test('a 300-char company name is rejected', () => {
    const error = validateCompanyName('a'.repeat(300));
    assert.equal(error.code, 'invalid_input');
  });

  test('accepts a normal name', () => {
    assert.equal(validateCompanyName('Acme Robotics'), null);
  });

  test('rejects empty/whitespace-only', () => {
    assert.equal(validateCompanyName('   ').code, 'invalid_input');
  });
});

describe('validateEmail', () => {
  test('rejects malformed addresses with invalid_email', () => {
    assert.equal(validateEmail('not-an-email').code, 'invalid_email');
  });

  test('rejects >254 chars', () => {
    const long = 'a'.repeat(250) + '@x.com';
    assert.equal(validateEmail(long).code, 'invalid_email');
  });

  test('accepts a normal address', () => {
    assert.equal(validateEmail('founder@acme.dev'), null);
  });
});

describe('validateDeck', () => {
  test('rejects a non-pdf mime/filename', () => {
    const error = validateDeck({ filename: 'deck.pptx', mime: 'application/vnd.ms-powerpoint', base64: 'AAAA' });
    assert.equal(error.code, 'unsupported_file_type');
  });

  test('rejects a deck over 10 MB', () => {
    const big = Buffer.alloc(LIMITS.DECK_MAX_BYTES + 1024, 0x41).toString('base64');
    const error = validateDeck({ filename: 'deck.pdf', mime: 'application/pdf', base64: big });
    assert.equal(error.code, 'deck_too_large');
  });

  test('accepts a small pdf', () => {
    assert.equal(validateDeck({ filename: 'deck.pdf', mime: 'application/pdf', base64: SMALL_PDF_BASE64 }), null);
  });
});

describe('validateExtraFile', () => {
  test('accepts any mime type (product decision, §6.4)', () => {
    const result = validateExtraFile({ filename: 'demo.mp4', mime: 'video/mp4', base64: 'AAAA' });
    assert.equal(result.mime, 'video/mp4');
  });

  test('drops (does not throw on) an oversized file', () => {
    const big = Buffer.alloc(LIMITS.EXTRA_FILE_MAX_BYTES + 1024, 0x41).toString('base64');
    assert.equal(validateExtraFile({ filename: 'big.zip', mime: 'application/zip', base64: big }), null);
  });

  test('sanitizes the filename', () => {
    const result = validateExtraFile({ filename: '../../etc/passwd', mime: 'text/plain', base64: 'AAAA' });
    assert.ok(!result.filename.includes('..'));
  });
});

describe('base64ByteLength', () => {
  test('matches Buffer.byteLength for a few known strings', () => {
    for (const s of ['', 'QQ==', 'QUE=', 'QUFB', SMALL_PDF_BASE64]) {
      assert.equal(base64ByteLength(s), Buffer.from(s, 'base64').length);
    }
  });
});

describe('validateIntakePayload -- aggregate entry point', () => {
  test('a fully valid payload passes and is normalized', () => {
    const result = validateIntakePayload(validPayload());
    assert.equal(result.ok, true);
    assert.equal(result.value.contact_email, 'founder@acme.dev'); // lowercased
    assert.equal(result.value.company_name, 'Acme Robotics');
  });

  test('a 300-char company name rejects the whole payload', () => {
    const result = validateIntakePayload(validPayload({ company_name: 'a'.repeat(300) }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_input');
  });

  test('a missing/invalid intake_submission_id rejects the payload', () => {
    const result = validateIntakePayload(validPayload({ intake_submission_id: 'not-a-uuid' }));
    assert.equal(result.ok, false);
  });

  test('an empty artifact-link row is dropped silently, not flagged', () => {
    const result = validateIntakePayload(
      validPayload({ artifact_links: [{ url: '' }, { url: 'https://github.com/acme/core' }] })
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.artifact_links.length, 1);
    assert.equal(result.value.artifact_links[0].kind, 'github_repo');
  });

  test('a credentialed artifact link is dropped, not surfaced as an error', () => {
    const result = validateIntakePayload(
      validPayload({ artifact_links: [{ url: 'https://attacker.com@legit.com/' }] })
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.artifact_links.length, 0);
  });

  test('artifact_links beyond the cap of 5 are silently truncated', () => {
    const links = Array.from({ length: 8 }, (_, i) => ({ url: `https://example${i}.com` }));
    const result = validateIntakePayload(validPayload({ artifact_links: links }));
    assert.equal(result.ok, true);
    assert.equal(result.value.artifact_links.length, LIMITS.ARTIFACT_LINKS_MAX);
  });

  test('extra_files beyond the cap of 3 are silently truncated', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.txt`, mime: 'text/plain', base64: 'AAAA' }));
    const result = validateIntakePayload(validPayload({ extra_files: files }));
    assert.equal(result.ok, true);
    assert.equal(result.value.extra_files.length, LIMITS.EXTRA_FILES_MAX);
  });

  test('missing deck rejects with unsupported_file_type', () => {
    const result = validateIntakePayload(validPayload({ deck: undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unsupported_file_type');
  });
});

// ============================================================================
// Proves this file does not depend on the `URL` global -- team-lead
// correction, mid-flight: `URL` is undefined in this project's n8n
// Code-node sandbox (confirmed live, docs/backlog/02-sourcing-radar/
// done.md's carried-risk section -- a swallowed ReferenceError from a
// missing `URL` silently classified every artifact as `kind:'none'`, with
// nothing in the logs). `node --test` runs on real Node, where `URL`
// exists natively, so the earlier version of this file (which DID use
// `new URL()`) passed every one of the 41 tests above while still being
// broken in production -- exactly the failure mode this block exists to
// rule out. Deleting `globalThis.URL` and re-running the same assertions
// is the only way `node --test` can actually catch that class of bug.
// ============================================================================

describe('validate.js does not depend on the URL global', () => {
  test('every URL-touching export still behaves correctly with globalThis.URL deleted', () => {
    const originalUrl = globalThis.URL;
    const hadUrl = Object.prototype.hasOwnProperty.call(globalThis, 'URL');
    delete globalThis.URL;
    try {
      assert.equal(typeof globalThis.URL, 'undefined', 'test setup failed to actually remove URL');

      assert.equal(safeWebUrl('https://attacker.com@legit.com/'), null);
      assert.equal(safeWebUrl('attacker.com@legit.com/'), null);
      assert.equal(safeWebUrl('javascript:alert(1)'), null);
      assert.equal(safeWebUrl('github.com/acme/core'), 'https://github.com/acme/core');
      assert.equal(safeWebUrl('https://example.com/path'), 'https://example.com/path');

      assert.equal(inferArtifactKind('https://github.com/acme/core'), 'github_repo');
      assert.equal(inferArtifactKind('https://github.com/acme'), 'github_user');
      assert.equal(inferArtifactKind('https://acme.dev'), 'product');
      assert.equal(inferArtifactKind('not a url at all'), 'other');
      assert.equal(inferArtifactKind('https://github.com'), 'other');

      assert.deepEqual(parseGithubOwnerRepo('https://github.com/acme/core.git'), { owner: 'acme', repo: 'core' });

      assert.deepEqual(validateArtifactLink({ url: 'github.com/acme/core' }), {
        url: 'https://github.com/acme/core',
        kind: 'github_repo',
      });
      assert.equal(validateArtifactLink({ url: 'https://attacker.com@legit.com/' }), null);

      const payloadResult = validateIntakePayload(
        validPayload({ artifact_links: [{ url: 'https://github.com/acme/core' }] })
      );
      assert.equal(payloadResult.ok, true);
      assert.equal(payloadResult.value.artifact_links[0].kind, 'github_repo');
    } finally {
      if (hadUrl) globalThis.URL = originalUrl;
    }
  });
});
