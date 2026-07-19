# 08 · Founder Intake — Implementation Plan

> Design: [`design.md`](design.md) rev.2 (all 19 spec-review findings folded in).
> Frontend: **already built and imported** into `web/` — contracts frozen, so the backend is the
> only thing between here and a working demo of this feature.
> Written 2026-07-19 ~10:30 Minsk, ~5.5 h to deadline, one of three parallel terminals.
>
> Conventions inherited from features 02/03/04/07, not re-litigated here: logic lives in
> `lib/f08/*.js` with `node --test lib/f08/*.js` (glob form — the directory form fails
> repo-wide); n8n Code nodes cannot `require()` from this repo, so anything destined for one is
> **self-contained CommonJS with zero imports**, pasted verbatim behind a
> `// SOURCE OF TRUTH: lib/f08/<file>.js` header; parallel branches reconverge through an
> explicit `Merge` node; `gpt-5.6-luna` rejects `temperature: 0` — omit the parameter.

## Stages and parallelism

```
S0 ═══ A: infra prereqs (devops)        ║  B: AI agent specs (ai-agent-builder)
       ─────────────────────────────────╨──────────────────────────────────────
S1 ═══ lib/f08 pure logic + unit tests (backend-developer)      ← needs S0-B schemas
       ─────────────────────────────────────────────────────────────────────────
S2 ═══ n8n workflows (n8n-requirements-orchestrator → n8n-workflow-builder)
       ─────────────────────────────────────────────────────────────────────────
S3 ═══ end-to-end wiring against the real frontend
       ─────────────────────────────────────────────────────────────────────────
S4 ═══ QA gate (qa-engineer, independent)
S5 ═══ close (done.md, README rewrite, commit)
```

**S0-A and S0-B run in parallel** — different files, no shared state. Everything after S0 is
sequential: S1 produces the code S2 pastes into Code nodes, S2 produces the endpoints S3
exercises, S4 attacks what S3 proves.

---

## S0-A · Infra prerequisites — @devops

Both are operational prerequisites the design calls out; neither is schema.

**T1. Create the Storage bucket.** `POST /storage/v1/bucket` with
`{"name":"decks","public":false}`, service-role key from `infra/supabase/.env`. Verify with
`GET /storage/v1/bucket` returning the bucket (it currently returns `[]`).
Then add the call to the cold-start sequence in `CLAUDE.md` §Commands — `db/apply.sh` does not
create it, so a fresh machine would otherwise have no bucket and every intake would 404.
**AC:** bucket listed; a test upload and delete round-trips; cold-start docs updated.

**T2. Two env vars on the shared n8n service** (`infra/n8n/docker-compose.yml`, already
announced in `docs/backlog/TRACKER.md`):
`N8N_CORS_ALLOW_ORIGIN` (the SPA's dev origin) and `N8N_PAYLOAD_SIZE_MAX=192`.
Restart the container; confirm with `docker exec vcbrain-n8n printenv`.
**AC:** both present; existing workflows (`f02`,`f03`,`f04`,`f07`) still listed and active
afterwards — this is a shared container and a bad restart is everyone's problem.

## S0-B · AI agent specifications — via the `ai-agent-builder` skill

Mandatory route for all product AI logic. Two agents, full artefact set each (input spec,
system prompt, output JSON schema, model choice) into `agents/`.

**T3. `deck-claims-extractor`.** Deck text or page images + `extraction_mode` → claims under
`founder.expertise.*` / `founder.leadership.*` **only** (never `company.*` — 07 owns those).
Hard constraints from design §5: stated values verbatim with their span, **never a derived
metric**; confidence from span presence in the source, **never the model's self-report**;
`extraction_mode` caps confidence; binary/structured extraction, never a 1–10 grade.
**AC:** schema rejects a claim with no span; prompt states the no-computation rule explicitly.

**T4. `gap-question-phraser`.** Selected criteria (id, anchor, weight) + card context →
`{criterion_id, question, why, placeholder}` ×0–3. Mom Test register: past behaviour and
structural facts, never opinions or forecasts. **Never** asks TAM, projections or competitor
lists. Copy must avoid the words interview / assessment / evaluation / screening.
**AC:** output schema matches the frozen contract field-for-field, `placeholder` included.

## S1 · `lib/f08` pure logic + unit tests — @backend-developer

Every item here is a pure function, testable without n8n or the network, and destined to be
pasted into a Code node.

**T5. `validate.js`** — field caps, `sanitizeFilename`, `safeWebUrl` (http/https only, rejects
embedded credentials), artifact-`kind` inference, aggregate payload bounds. Ported verbatim from
`reporting/lib/deals/submission-validation.ts` (Apache-2.0) — **record the attribution in the
file header**.
**AC:** `https://attacker.com@legit.com/` rejected; `../../etc/passwd` sanitised; a 300-char
company name rejected.

**T6. `identity.js`** — resolution order from design §3.1: GitHub from `artifact_links` first,
then email, then create. **This is the one that protects the demo narrative** — without the
GitHub step a radar-discovered founder becomes a second, score-less person on their own
application.
**AC:** a founder with an existing `founder_identities(kind='github')` row resolves to that
founder and gains an email identity, creating no second row.

**T7. `hashing.js`** — content hashes for `raw_signals` / `claims` / `evidence`, all
**including `application_id`** (design §3.2). Use `globalThis.crypto.subtle.digest('SHA-256')`,
not `require('crypto')` — the Code-node sandbox has no `crypto` module.
**AC:** same application + same deck → identical hash (retry dedupes); different application +
same deck → different hash (re-application succeeds instead of raising 23505).

**T8. `gaps.js`** — deterministic criterion selection: read `score_formulas.config.criteria`
(a jsonb **array**, filtered `axis='founder_score' AND active`), keep those whose `neg_src` ⊆
{`deck_parse`,`interview_answer`}, drop those covered, rank by weight, cap at 3.
**Coverage must exclude claims with `verification_status='missing'`** and any `.gap`-suffixed
topic — 07 writes gap markers as claims, and counting one as coverage suppresses exactly the
question worth asking.
**AC:** against the live seeded config returns exactly `[L2, L3, X5]` in that order; a `missing`
claim on `founder.leadership.first_customers` does **not** suppress L2.

**T9. `completeness.js`** — `card_completeness` = covered ÷ reachable weight over the same three
criteria (design §6.1). Distinct from 03's `coverage`; say so in the file header.
**AC:** no answers → 0.0; all three → 1.0; L2 only → 0.505.

## S2 · n8n workflows — `n8n-requirements-orchestrator` → `n8n-workflow-builder`

**T10. `f08-intake-submit`.** Webhook → validate → **upload deck and extra files to Storage,
dropping their base64 from the item immediately** → entities → `applications` (id =
`intake_submission_id`) + `cards` → `raw_signals` → deck cascade (Convert-to-File →
ExtractFromFile → vision fallback → `extraction_mode`) → claims + evidence → `f07-thesis-gate`
`mode:'full'` → status `screening` → `events` (`entity_type='founder'`) → respond with the
frozen §4.1 shape including `gap_questions`.
**AC:** a real PDF returns a populated response; an image-only PDF returns
`warning:'image_only_deck'` with claims still written; the same request sent twice creates
exactly one application.

**T11. `f08-gap-answers`.** Answers → claims (`source_kind='interview'`, `text_verbatim`
word-for-word) + evidence + `raw_signals` **carrying both FKs**; skipped ids recorded;
`interviews.transcript` updated; returns `card_completeness`.
**AC:** an all-skipped submission succeeds and lowers confidence without touching any score.

**T12. `f08-followup`** (GET, does not consume) **and `f08-followup-answers`** (POST, consumes
via `status='completed'`). Token: 32 bytes CSPRNG, **SHA-256 hash stored**, 24 h from
`created_at`.
**AC:** a valid token returns its questions; an expired one returns
`{"valid":false,"reason":"expired"}` with HTTP **200**, not an error status.

**T13. `f08-application-status`** (GET) — status screen after a refresh; `open_questions`
derived from `interviews.transcript`.

## S3 · End-to-end wiring

**T14.** Run the real frontend (`cd web && npm run dev`) against the real workflows. Submit a
real deck through the browser. This is where CORS either works or silently fails — curl cannot
catch it.
**AC:** full path in a browser: `/apply` → questions → status, with rows visible in the database.

## S4 · QA gate — @qa-engineer, independent

**T15.** Adversarial pass. **Do not reuse the developer's tests.** Verify all ten guardrails from
design §10 one by one; attack the token (expired, tampered, replayed, prefetched by GET); force
the image-only and extraction-failed branches; re-apply with the same deck; confirm erasure
reaches every row 08 writes and **confirm the Storage gap is real and disclosed** rather than
assumed. Output `qa-report-08.md` and a verdict.

## S5 · Close

**T16.** `done.md` for downstream feature 11 (demo data + ethics), stating the honest limits.
**T17.** Rewrite the feature README body — it still describes the superseded full-cycle plan
(voice, real email, chat interview) and contradicts its own header.
**T18.** Final commit via @devops; update the status row in `docs/backlog/TRACKER.md`.

## Time budget

| Stage | Estimate |
|---|---|
| S0 (parallel) | 25 min |
| S1 | 45 min |
| S2 | 90 min |
| S3 | 30 min |
| S4 | 45 min |
| S5 | 20 min |
| | **~4 h**, against ~5.5 h remaining |

**Cut order — superseded by rev.2 below. Do not use the version that was here.**

---

# rev.2 — amendments from plan review

> An adversarial plan review returned **CHANGES REQUIRED**: 3 blockers, 9 majors, 6 minors.
> Every finding below was verified against the live system before being accepted. Amendments
> supersede the sections above where they conflict.

## New tasks

**T0 · Response contract (BLOCKER, must land before T10).** All four existing f0x webhooks use
`responseMode:"lastNode"` and there is **no `respondToWebhook` node anywhere in the repo** —
verified. That mode can only emit HTTP 200, and the built frontend keys every error off
`!res.ok`. So an error would be parsed as success, written into `sessionStorage`, and then throw
a `TypeError` on the next line — **none of the five frozen error codes could ever reach the UI.**
All f08 webhooks use `responseMode:"responseNode"` with explicit Respond nodes: 200 · 400
`invalid_email`/`unsupported_file_type` · 413 `deck_too_large` · 429 `rate_limited` · 500
`internal`, plus a catch-all error branch each. `f08-followup` keeps 200 for an invalid token —
that is the contract, not an error.
**AC:** curl each path; assert status **and** body shape.

**T19 · `f08-followup-create` (producer for T12).** Without it T12 ships untestable and T15's
token attacks have no target — the manager-side producer lives in feature 09, which is not
built. Minimal: `application_id` + optional note → questions via T8/T4 → `interviews` row +
token → returns the link. That link is also the mocked-email artefact STUB-001 promises, so it
pays for itself twice.

**T20 · Recompute the founder score after answers (MAJOR).** Nothing currently triggers it, so
the feature's headline claim is never demonstrated: a deck-less founder legitimately scores
`insufficient_evidence` *because* L2/L3/X5 are unreachable, 08 writes exactly the claims that
close them, and then nobody re-scores. Verified: `scores` holds `founder_score`, `market`,
`idea_vs_market`, `thesis_fit` — and **no `founder` axis rows at all**. `f08-gap-answers` calls
`f03-score-founder` (`AlkzJ70zET7SiHkn`) for the resolved founder.
**AC:** coverage recorded for the same founder before and after; a rise attributable to L2/L3/X5
credit. `insufficient_evidence` afterwards is a valid outcome — never invent a score.

## Corrections to existing tasks

- **T5 — `URL` is undefined in the n8n Code sandbox.** The "port verbatim from `reporting`"
  instruction actively causes the highest-probability failure in this plan: `reporting` uses
  `new URL()`, and 02's `done.md` records this exact bug swallowing a ReferenceError and
  silently classifying **every** artifact as `kind:'none'` with nothing in the logs. Tests pass
  under `node --test`, production fails invisibly. Reimplement without `URL`; re-run the
  assertions with `globalThis.URL` deleted; sweep for `Buffer`/`require`/`process` too.
  *(Correction already sent to the executing agent mid-flight.)*
- **T9 — arithmetic was wrong.** L2 alone = 0.15/0.29625 = **0.5063 → 0.51** at the column's
  `numeric(3,2)`. Round inside the function, or the API and the stored card disagree.
- **T10 — name the constraint-bearing columns:** `applications.kind='inbound'`,
  `cards.card_type` slug, and the outcome of a **failed Storage upload** (clean 500, nothing
  half-written — the CHECK makes the row literally unwritable without a path).
- **T10 — `artifact_links` is a name collision.** The request field is an array of
  `{url, kind}`; the column is the jsonb object 02 froze. Writing one over the other breaks
  every consumer keying on `source`/`artifact_kind`. Write
  `{source:'intake_form', intake_submission_id, founder_links:[…], deck_filename}`.
- **T10 — the retry must replay, not fail.** A long serial chain under a 90 s client abort makes
  timeout-then-retry *likely*; the retry collides on the PK. On collision, read back and return
  the stored result as a normal 200 — otherwise one timeout strands the founder permanently.
- **T10/T11 — contract fields nobody produces:** `verdict_eta_hours`, `estimated_minutes`,
  `deck.pages`/`chars_extracted` (return **0**, not null, on the `none` branch), and T11's
  `accepted`/`skipped`/`status`.
- **T12 — `asked_by`/`note`/`already_answered` have no home:** `interviews.transcript.meta`.
- **T10/T11 AC — the landmine that has bitten twice:** assert
  `select count(*) from claims c left join evidence e on e.claim_id=c.id where c.card_id=<card>
  and (e.id is null or e.raw_signal_id is null or c.source_kind='public')` returns **0**.
- **T15 — had no acceptance criterion at all**, on the one task marked never-cut. Now:
  `qa-report-08.md` records PASS/FAIL per guardrail for all ten of design §10 plus the four
  token attacks, each with its reproducing command or SQL; a verdict; and every FAIL carrying an
  owner and a decision (fix / disclose in `done.md`).
- **T2 — resolved, not just amended.** The review doubted `N8N_CORS_ALLOW_ORIGIN` is the
  effective mechanism in 2.30.7. Verified by real preflight: `OPTIONS` with
  `Origin: http://localhost:5173` → **204**, `Access-Control-Allow-Origin: http://localhost:5173`,
  `Access-Control-Allow-Methods: OPTIONS, POST`. Per-node `options.allowedOrigins` is not needed.

## Corrected cut order

1. **Vision fallback in T10** — cut first, not last. It is the largest schedule risk inside T10
   (N page-images to a multimodal model inside a 90 s abort) and buys 56–64% accuracy. The part
   the 30% Data criterion rewards is the honest `image_only_deck` declaration, which survives the
   cut. If kept, cap it at ~6 pages.
2. **T12 + T19** — the follow-up pair; manager-initiated, off the main demo path.
3. **T13 — cut LAST.** The old plan cut it first, which was wrong and visibly so on camera:
   verified in the built frontend, the offline fallback derives open questions from
   `savedIntake.gap_questions.length` (`apply.status.tsx:75`) while `clearGapQuestions()` clears
   a *different* key. Without T13, a founder who has just answered all three questions is told
   **"You left 3 questions unanswered."** It is one PostgREST read and the only cut that makes
   the product state a falsehood to the user.

**Never cut:** T6 identity resolution · T8 gap selection · T15's guardrail verification.

## Tripwires

- **S2 is the estimate that blows** — four workflows in 90 minutes is optimistic by roughly half.
  If `f08-intake-submit` has not returned a populated 200 to curl by **T+45 min into S2**, make
  the cuts then, not at T+90.
- **A green 200 from n8n is not evidence the workflow ran.** This build has silently executed
  only some branches of a multi-wire reconvergence while still returning 200. On the first green
  run, check `GET /api/v1/executions/{id}?includeData=true` and confirm every expected node name
  appears in `resultData.runData`.

## Sequencing correction

S1 never depended on S0-B — T5–T9 are pure functions over the seeded config and the request
payload; only T10's extractor node consumes an agent schema. Three lanes were available from
minute zero. *(Already the case in practice: S1 and the n8n requirements spec were dispatched
alongside S0 rather than after it.)* T17 and the skeleton of T16 are likewise independent and
belong in the S2 waiting window, not in a tail scheduled for the moment the clock runs out.
