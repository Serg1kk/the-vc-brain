# 02 · Sourcing Radar — Independent QA Report

> **Two re-check rounds appended below the original report — see "RE-CHECK ROUND" and
> "ROUND 3" and the final `GATE:` line at the very bottom of the file.** The original report
> (everything from "## 0. Moving-target disclosure" through the first "GATE: FAILED") and the
> round-2 re-check are left completely unedited as the historical record of each pass. Do not
> average the three verdicts — the LAST `GATE:` line in the file is the current one.

> Adversarial pass, per `plan.md` Task 11. Developer tests (`node --test lib/f02/*.test.js`)
> were **not** used as evidence anywhere below — every finding is from a probe I wrote and
> executed myself, against the live DB (`postgresql://postgres.<tenant>@localhost:54322/postgres`),
> a disposable isolated Postgres database on the same instance (`qa_repro_02`, created and
> dropped during this session), the live n8n instance (`http://localhost:5678`,
> `http://localhost:5678/api/v1`), and real third-party HTTP endpoints (HN Algolia, GitHub,
> LinkedIn, live Show HN sites).

## 0. Moving-target disclosure (read this first)

This audit ran concurrently with active development. Mid-session the orchestrator added
`lib/f02/ethics.js`, an opt-out gate in `write.js`, a robots-gated crawl in `run.js --live`, and
`writeEvents()` — all **after** I had already read the original `write.js`/`run.js`. I re-read
every file before assessing it, and section 4 (robots.txt) and section 6 (opt-out) below assess
the code **as it exists at report time**, not the earlier snapshot. Separately, live database row
counts changed substantially during this session from causes outside my own commands (founders
26→ vs. 8 at session start, applications 81 vs. 30, new event types `thesis_gate_insufficient_evidence`
appearing) — consistent with the orchestrator running additional live scans in parallel. Every
finding below states the exact command/query that produced it and the observed row counts at that
moment, so it is independently re-verifiable regardless of what else is happening in the shared DB.
Any test data I created for reproduction (a synthetic founder `qa-purge-probe-handle`, two
temporary `opt_out_at` sets on `ayuhito`, one throwaway Postgres database `qa_repro_02`) was
cleaned up — details in each section.

---

## CRITICAL — Feature 02's entire DB surface (Tasks 5–6) is not in `db/schema.sql` / `db/seed.sql` / `db/tests/smoke.sql`

**Tracker says:** Task 5 "done ... seed +7 metrics; view w/ `obscurity_basis` ... verified
independently"; Task 6 "done ... 5 assertions, id range `02f00001-…` ... smoke green with
03/04/07 blocks present."

**What I found:** none of it is in the git-tracked files that `db/apply.sh` actually reads.

```
$ grep -n "radar_candidates\|CREATE.*VIEW" db/schema.sql
(no output)
$ grep -n "hn_karma\|gh_notable_followers\|hn_author_replies" db/seed.sql
(no output)
$ grep -n "02f00001" db/tests/smoke.sql
(no output)
$ git log --oneline -- db/schema.sql db/seed.sql db/tests/smoke.sql | head -1
3ae789f feat(db): feature 04 signal sources + two cross-cutting fixes
```

`db/schema.sql` and `db/seed.sql` have not been touched since feature 04's commit. Feature 02's
view and seven `metric_kinds` rows exist **only because someone ran SQL directly against the live
Supavisor-fronted Postgres instance**, bypassing the two files `db/apply.sh` applies. Confirmed the
objects are real and correct in the *running* database:

```
$ psql "$DATABASE_URL" -c "select table_name from information_schema.views where table_name='radar_candidates';"
 radar_candidates
(1 row)
$ psql "$DATABASE_URL" -c "select slug from metric_kinds order by slug;"
 gh_commit_weeks, gh_dependents, gh_followers, gh_forks, gh_merged_prs, gh_notable_followers,
 gh_stars, hn_author_replies, hn_comments, hn_karma, hn_points, site_updated   (12 rows)
```

Then I proved this is **not reproducible from git alone**, without touching the shared live
database, by creating an isolated database on the same Postgres instance and applying only the
committed files:

```
$ psql "$DATABASE_URL" -c "CREATE DATABASE qa_repro_02;"
CREATE DATABASE
$ DATABASE_URL="postgresql://postgres.<tenant>:<pw>@localhost:54322/qa_repro_02" ./db/apply.sh
==> Applying schema: .../db/schema.sql
... (ends at Task 9 — feature 01's enforcement layer, no VIEW)
==> Applying seed data: .../db/seed.sql
INSERT 0 5 / INSERT 0 6 / INSERT 0 3 / INSERT 0 5 / INSERT 0 2
==> Done.
$ psql ".../qa_repro_02" -c "select table_name from information_schema.views where table_name='radar_candidates';"
(0 rows)
$ psql ".../qa_repro_02" -c "select slug from metric_kinds order by slug;"
 gh_commit_weeks, gh_merged_prs, gh_stars, hn_points, site_updated   (5 rows -- feature 02's 7 rows absent)
```

Dropped `qa_repro_02` after the test (`DROP DATABASE qa_repro_02;`, confirmed).

**Why this is Critical, not cosmetic:** `db/tests/smoke.sql` was likewise never touched, so Task 6's
claimed "5 assertions, id range `02f00001-…`" do not exist in the file the project's own quality
gate runs (`psql -f db/tests/smoke.sql`). And this project's own `CLAUDE.md` documents a
**mandatory cold-start reset procedure** (`docker compose down -v && rm -rf .../data && docker
compose up -d --wait && ./db/apply.sh`) as the standard way to prove the schema is reproducible —
feature 01 did this exact proof as Task 10/11 of its own plan. Running that exact procedure today
would **silently delete the entire feature-02 DB surface**: the `radar_candidates` view feature 09
is meant to read, and 7 of 12 `metric_kinds` rows, including the two (`hn_karma`,
`gh_notable_followers`) the obscurity formula depends on. Design §6.4 states explicitly: "The VIEW,
however, is DDL and lands in `db/schema.sql`" — it does not. Task 5's own acceptance criterion
("`./db/apply.sh` twice in a row is idempotent; the view returns rows for a seeded founder")
is unmet on the file `db/apply.sh` actually applies.

**Repro:** any of the three greps above, or the isolated-database sequence, against the current
`main` working tree.

**Verdict: FAIL.** This alone is gate-blocking — it is not a demo-day risk, it is a "the feature does
not exist after a clean checkout + apply" risk, and it means Tasks 5 and 6 cannot honestly be
marked "done."

---

## Mandatory case 1 — Idempotency (re-run every fixture's `--write` twice)

Ran all four fixtures, `--write` twice each, counting all nine tables before/after/after-again.
Full transcript (abridged to the counters that matter; `t=1` is write #1, `t=2` is the identical
retry):

| Fixture | raw_signals Δt2 | metric_obs Δt2 | founders Δt2 | companies Δt2 | cards Δt2 | claims Δt2 | evidence Δt2 | applications Δt2 |
|---|---|---|---|---|---|---|---|---|
| user-artifact | 0 | 0 | 0 | 0 | 0 | **+1** | **+1** | **+1** |
| org-artifact | 0 | 0 | 0 | 0 | 0 | **+1** | **+1** | **+1** |
| product-url | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **+1** |
| threaded-artifact | 0 | 0 | 0 | 0 | 0 | **+2** | **+2** | **+1** |

For claims/evidence, the delta on the identical retry matches **exactly** the count of
`[missing]`-tier claims that fixture produces (checked independently via a dry run,
`grep -c '\[missing\]'`): user=1, org=1, product=0, threaded=2. This is the documented exception
(`claims.content_hash` is nullable specifically for missing-marker claims, no idempotent
select-back is possible on NULL). **Confirmed: this is the only source of claims/evidence
non-idempotency** — I did not find any other duplicate claim/evidence row across any fixture.

**`raw_signals`, `metric_observations`, `founders`, `companies` (when domain is set), `cards`,
`founder_identities`: fully idempotent** across all four fixtures, both writes. PASS.

### Finding A (Major) — `applications` duplicates on every single retry, unboundedly

Not literally one of the seven tables named in the brief, but squarely inside the spirit of "a
re-run is a no-op, not a double-count" (design §6.1) and worth flagging because it is severe and
100% reproducible: `applications` has no unique constraint and no dedup logic at all
(`write.js` step 3: "No unique constraint on `applications` at all -- every call inserts a new
row"). Every one of my 8 write calls above created exactly **one new `applications` row**, with no
exception, confirmed by the counters in each run's JSON output (`"created":{"application":true,...}`
every time) and independently by DB row counts. This was not limited to my own test runs — before I
touched anything, pre-existing dev-session data already showed the same pattern from Task 9/10
development:

```
$ psql "$DATABASE_URL" -c "select a.kind, c.name, count(*) from applications a join companies c on c.id=a.company_id group by 1,2 order by 3 desc limit 5;"
 radar_activated | safehttp   | 8
 radar_activated | puffinsoft | 6
 radar_activated | rewindcup  | 5
 radar_activated | colibri    | 4
```
(taken at session start, before any of my writes). By the time I finished, unrelated further live
activity (not mine — see §0) had pushed these to `rewindcup=10`, `safehttp=10`, `puffinsoft=8`,
`colibri=6` — i.e. the pattern reproduces on data I never touched, under what looks like
independent, real `--live` runs, not just my synthetic replay loop.

Consequence: the `cards` row (what 03 actually reads) is created once and its `application_id`
is **never updated** on subsequent runs, so every application row after the first is a permanent,
un-referenced duplicate that nothing points back to except `applications.company_id`. This
directly undermines the "re-run of the same window is a no-op" claim design §6.1 makes as a general
principle, inflates whatever funnel/demo counters read `count(applications)`, and — because 07's
gate is invoked once per `applications` row created (per design §5.5(a)) — means a naive retry (the
exact scenario Task 7's own acceptance criterion is about) re-triggers a real gate evaluation every
time, not a no-op.

`write.js`'s own comment rationalizes this as matching "01/design.md's own 're-application = new
row' stance" — but that stance is about a founder genuinely re-applying later with a new deck; it
was never meant to license a tier-0 scan re-observing the *same* Show HN post within the *same*
scan window minting a fresh `applications` row every time, which is what actually happens here.

**Repro:** `node lib/f02/run.js --recorded db/fixtures/recorded/product-url --write` twice; observe
`created.application: true` both times; `select count(*) from applications where company_id =
(select id from companies where normalized_name='rewindcup')` grows by 1 per call.

### Finding B (Major) — `companies` duplicates for real, under the documented race window

`write.js`'s own comment for the domain-less company path (the majority path: every GitHub-repo
artifact canonicalizes to `domain=null` since `github.com` is a generic host) says: "That leaves a
genuine (small) race window between the SELECT and the INSERT... accepted per the coordinator's
explicit... ruling, and flagged via `warnings[]`." I checked whether this theoretical, "accepted"
risk has actually fired in the live data — it has, repeatedly, for 3 of the ~14 distinct radar
companies present at session start:

```
$ psql "$DATABASE_URL" -c "select normalized_name, domain, count(*) from companies group by 1,2 having count(*) > 1 order by 3 desc;"
 safehttp                                    |        | 4
 getting glm 5.2 running on my slow computer |        | 2
 puffinsoft                                  |        | 2
```
(unchanged after ~50 minutes of further live activity by the orchestrator — no new dup names
appeared, but the existing three did not self-heal either, since nothing purges/merges them).

For `puffinsoft` specifically, the two rows were created **103ms apart**
(`2026-07-19 03:28:04.612868` / `.715858`) — a textbook lost-update race on the check-then-insert
(`selectOne` by `normalized_name`, then `insertAlways`) pattern `write.js` uses when `domain` is
null. Consequence, confirmed live: the `cards` row for G3819 points at only **one** of the two
`puffinsoft` company rows; 7 of 8 `applications` rows for "puffinsoft" point at the card's company
id, 1 points at the orphan — meaning that one application (and whatever raw signals/claims a
concurrent enrichment run attached to the *other* company id) is invisible to anything joining
through the card. For `safehttp`, the four rows split into pairs 6 seconds and 0.14 seconds apart
respectively — not all four are explainable by a tight race alone, which suggests the check-then-
insert dedup fails more broadly than just "two requests land within the same millisecond," e.g.
under ordinary overlapping/parallel agent-driven invocations (exactly the architecture this
project's own CLAUDE.md mandates — "independent stages → run parallel subagents").

```
$ psql "$DATABASE_URL" -c "select id, name, domain, created_at from companies where normalized_name='safehttp' order by created_at;"
 c9727fc5... | safehttp |  | 2026-07-19 03:26:24.730911+00
 489619b5... | safehttp |  | 2026-07-19 03:26:30.102899+00   (5.4s later)
 e3c0b99b... | safehttp |  | 2026-07-19 03:27:58.296519+00
 c0cfba43... | safehttp |  | 2026-07-19 03:27:58.438415+00   (0.14s later)
```

**Verdict on Case 1: mostly PASS**, but with two real, live-reproduced duplicate-row findings
(`companies` — literally on the mandated table list; `applications` — not on the list but squarely
within the mandate's intent), neither of which is the documented missing-marker-claims exception.

---

## Mandatory case 2 — Organization artefact does not invent a founder

```
$ psql "$DATABASE_URL" -c "select count(*) from founder_identities fi join cards c on c.founder_id=fi.founder_id join claims cl on cl.card_id=c.id where fi.kind='hn' and fi.value='G3819' and cl.topic in ('founder.execution.merged_pr_foreign','founder.execution.commit_consistency');"
 0
```
Confirmed: G3819 has a `founders` row (correct per design §5.0 rule 0(b) — every candidate gets
one) and an `hn` identity, but **no `github` identity** and **zero** E1/E3 claims, even though
`puffinsoft`'s (the organization's) own merged-PR and push-event data was fetched and persisted as
`raw_signals` (recorded for replay completeness, per `pipeline.js`'s own comment). The company row
for the card is `puffinsoft`, not `G3819`. This is exactly right — `personLinked` in `pipeline.js`
correctly gates E1/E3 on `crossPlatformLinked && ghUser.type === 'User'`, and org-artifact's
`crossPlatformLinked` is `false` by construction (identity.js tier 3).

**Verdict: PASS.**

---

## Mandatory case 3 — Handle mismatch resolves without fuzzy matching

```
$ psql "$DATABASE_URL" -c "select fi.kind, fi.value, fi.confidence, fi.discovered_via from founder_identities fi where fi.founder_id = (select founder_id from founder_identities where kind='hn' and value='vforno');"
 hn     | vforno    |      |
 github | JustVugg  | 0.85 | showhn_declared_artifact
```
Confirmed live in the DB: `vforno` → `JustVugg` lands at tier 2, confidence 0.85,
`discoveredVia='showhn_declared_artifact'`, exactly as specified.

Independent, sound grep across the **entire** shipped source tree (not the dev test's own
comment-stripped copy):
```
$ grep -rniE "levenshtein|jaro|bigram|trigram|dice.?coeff|edit.?distance|soundex" lib/f02/ --include="*.js" | grep -v test.js
(no output, exit 1)
```

**I also did what the brief asked and checked whether the dev test's own comment-stripping is
sound — it is not**, though it happens not to hide anything material today. The dev test in
`identity.test.js` strips comments with `.replace(/\/\/[^\n]*/g, '')` before asserting no fuzzy
terms appear. That regex does not understand string literals, so it treats the `//` **inside a
string literal** (`'http://' + raw`, in `identity.js`'s `canonicalDomainForBlogMatch`) as a comment
marker and deletes the rest of that source line:

```
$ node -e '
const fs=require("fs");
const src=fs.readFileSync("lib/f02/identity.js","utf8");
const codeOnly=src.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
console.log(codeOnly.split("\n").slice(68,74).join("\n"));
'
  let raw = String(urlOrHost).trim().toLowerCase();
  if (!raw) return null;
  if (!raw.includes(':
                                          <- rest of the real line silently deleted

  let host;
```
`raw = 'http://' + raw;` — a benign scheme-prepend — vanishes from what the "no fuzzy matching"
assertion actually scans. In this specific file the deleted code happens to be harmless, so the
assertion's conclusion (no fuzzy matcher present) is correct today, verified independently by my
own sound grep above. But the mechanism is unsound: any real code placed on the **same line** after
a `//`-containing string literal (a URL, a protocol-relative path, an inline comment about a URL)
would be silently excised from what the test inspects, so this specific assertion could pass a
future regression where a fuzzy-match call sits downstream of a `://` on one line. This is exactly
the class of self-confirming test the brief warned about — it asserts against its own (flawed)
transformation of the implementation, not against the implementation.

**Verdict: PASS** on the actual requirement (no fuzzy matching exists, confirmed by my own
independent grep and by the live DB result), **with a Minor finding** on the soundness of the
regression test that is supposed to guard it going forward.

---

## Mandatory case 4 — robots.txt

This mechanism did not exist earlier in the session; the orchestrator built `lib/f02/ethics.js`
mid-audit after confirming its absence. I re-read the new code and ran my own probes against it,
distinct from the dev's own `ethics.test.js` cases.

### 4a. Parser correctness — my own edge cases (all against `parseRobotsTxt`/`isCrawlAllowed`)

```
empty-disallow-then-real-disallow:                      {"allowed":false,"rule":"/private","reason":"disallowed"}
3-way shared group (agent in the middle of 3 UA lines):  {"allowed":false,"rule":"/secret","reason":"disallowed"}
exact-agent group after a closed wildcard group
  must NOT inherit the wildcard's rules:                 {"allowed":true,"rule":null,"reason":"no_matching_disallow"}   -- correct
longest-match Allow overrides shorter Disallow:           {"allowed":true,"rule":"/docs/public","reason":"allow_overrides"} -- correct
longest-match Disallow wins when Allow is shorter/absent: {"allowed":false,"rule":"/docs","reason":"disallowed"}         -- correct
$ anchor, exact match:                                    blocked  -- correct
$ anchor + query string appended:                         allowed  -- correct (RFC: $ anchors end-of-path, query differs)
$ anchor, non-exact prefix (/file.phpxyz):                allowed  -- correct
CRLF line endings:                                        parsed correctly
BOM at start of file:                                     parsed correctly (JS .trim() eats U+FEFF)
UA case-insensitivity ("Vcbrain-Radar" vs "vcbrain-radar"): matched correctly
wildcard mid-pattern (/a*z vs /aXXXz, /a):                correct on both
literal "?" in a Disallow pattern vs a real query string: matched correctly (escaped, not treated as wildcard)
```
All of the above: **correct.** I could not break the core matcher with any of my own cases.

### 4b. Unicode Disallow patterns never match (Minor, live-reproducible)

```
$ node -e '... isCrawlAllowed("User-agent: *\nDisallow: /café\n", "https://x.example/café", "*") ...'
{"allowed":true,"rule":null,"reason":"no_matching_disallow"}
```
`new URL(url).pathname` always percent-encodes non-ASCII characters, but the pattern from
`Disallow: /café` is compiled and matched **raw** (never percent-encoded first). A robots.txt that
writes non-ASCII paths literally (not percent-encoded) can never actually block anything for that
path. Low real-world impact for this project's English-language target sites, but a genuine parser
gap.

### 4c. Any HTTP-200 body is treated as authoritative robots.txt — no content-type/shape check
(Minor–Major; this is the exact "robots.txt that is actually an HTML error page served with status
200" case named in the brief)

Found **live**, on a real Show HN artifact pulled from HN Algolia's current front page
(`q3edit.com`, an SPA with a catch-all route that serves its own `index.html` for `/robots.txt`,
HTTP 200):
```
$ curl -s -o /dev/null -w "%{http_code}\n" -A vcbrain-radar https://q3edit.com/robots.txt
200
$ node -e '... checkRobots("https://q3edit.com/", realFetch, "vcbrain-radar") ...'
{"allowed":true,"checked":true,"status":200,"rule":null,"reason":"no_matching_disallow"}
```
Harmless here (the HTML page's text does not happen to contain a line that parses as a directive),
but I constructed the adversarial version to show the failure mode is real and reachable, not
theoretical:
```js
// A plausible SPA 404/catch-all page that quotes its own crawler policy in prose/a code sample --
// e.g. a "how to reach us / our crawler policy" blurb, or a docs snippet.
const fakeBody = `<html><body><h1>Page not found</h1>
<p>Here is what we send in our own robots.txt:</p>
<pre>
User-agent: *
Disallow: /
</pre></body></html>`;
```
```
$ node -e '... checkRobots("https://spa-demo2.example/some/deep/page", fetchFn_returning(fakeBody), "vcbrain-radar") ...'
{"allowed":false,"checked":true,"status":200,"rule":"/","reason":"disallowed"}
```
`checkRobots` has no Content-Type check and no "does this look like a robots.txt" sanity gate
(e.g. requiring the first meaningful line to be `User-agent:`) before parsing a 200 body as
directives. This particular failure direction (false block) is the direction the code's own header
comment says it prefers ("a false skip costs us one candidate, a false crawl costs the lawful
basis") — so it is not unsafe by the design's own risk framing — but it means the persisted
`crawl_skipped_robots` reason ("disallowed") can be **factually wrong** (there was no real
robots.txt at all), which cuts against §7's "showing the function is worth more than a paragraph
claiming it" framing: the function can fire on hallucinated input and the resulting audit trail
would misrepresent why a legitimate, consenting candidate was skipped. It also directly contradicts
the *other* stated design goal (SCOPE-007, "open door first for everyone") by silently dropping
sites whose owners published no crawling restriction at all.

### 4d. UA mismatch between the robots check and the actual crawl (Major — directly answers the orchestrator's probe 3)

`run.js`'s own comment claims: *"The UA we present to robots.txt AND to the site. Must be the same
string in both places -- checking robots as one agent and crawling as another is the exact
bad-faith pattern the EDPB guidance treats as ignoring the signal."* This is **false for the actual
site crawl**. `ROBOTS_UA = 'vcbrain-radar'` is used for exactly two things: (1) the `fetch()` call
to `{origin}/robots.txt` itself, and (2) selecting which robots.txt *group* applies
(`parseRobotsTxt(text, userAgent)`). The actual page content crawl — `/map` and `/extract` — is
**delegated entirely to Tavily's remote infrastructure**:
```js
siteExtract = await tavilyPost('/extract', { urls: targets, extract_depth: 'basic', format: 'markdown', include_usage: true }, tavilyKey);
```
Neither the `/map` nor the `/extract` request body contains a `user_agent` field or anything
resembling `vcbrain-radar` — confirmed by reading both call sites in full. The HTTP request that
actually fetches the target page's HTML is issued by Tavily's own crawler infrastructure, under
whatever identity Tavily itself presents (unknown to, and uncontrolled by, this codebase). So: our
own robots.txt check, performed as `vcbrain-radar`, has **no bearing on what actually crawls the
site** — we check as one agent and a completely different, third-party agent does the fetching.
That is precisely the bad-faith pattern the comment two lines above it says this file avoids. (The
robots-*skip* path is still correct and valuable — if `checkRobots` says disallowed, we correctly
never call Tavily at all, so a real disallow-all robots.txt does stop the crawl. The gap is only
that an *allowed* verdict under `vcbrain-radar` does not actually govern what Tavily does.)

### 4e. `checked` flag is not persisted on the allowed path

The `checked:false` (fetch-failed, "could not verify") case is handled correctly in memory —
`allowed:true, checked:false` never gets treated as a verified allow anywhere I could find (the
branch condition is `if (!robots.allowed)`, which is agnostic to `checked`, by design). But the
distinction is **never written to the database on the allowed path** — `crawlSkippedEvent()` is
only constructed inside the `!robots.allowed` branch; a verified-allowed crawl and an
unreachable-robots.txt-so-we-proceeded-anyway crawl produce byte-identical persisted evidence (a
`tavily_extract` raw signal with no robots-check provenance attached). So the ethics/traceability
claim holds for skips but is asymmetric: only refusals are recorded, "we tried to check and
couldn't, so we went ahead" is not distinguishable after the fact from "we confirmed permission."

### 4f. Skip *is* actually persisted (I re-verified independently; earlier absence claim from the orchestrator's first message is now resolved)

```
$ psql "$DATABASE_URL" -tAc "select count(*) from events;"     # 25
$ node -e '... checkRobots("https://www.linkedin.com/in/some-random-qa-probe-handle", realFetch, "vcbrain-radar") ...
     then crawlSkippedEvent(url, robots), then writeEvents([ev]) ...'
checkRobots result: {"allowed":false,"checked":true,"status":200,"rule":"/","reason":"disallowed"}
writeEvents result: {"written":1}
$ psql "$DATABASE_URL" -tAc "select count(*) from events;"     # 26
$ psql "$DATABASE_URL" -c "select event_type, payload from events where event_type='crawl_skipped_robots';"
 crawl_skipped_robots | {"url": "https://www.linkedin.com/in/some-random-qa-probe-handle", "rule": "/", "reason": "disallowed", "checked": true}
```
`writeEvents()` is exported from `write.js` **and** imported/called from `run.js`'s `main()` under
`--write` (`const { checkRobots, crawlSkippedEvent } = require('./ethics.js')`, `const {
applyWriteSet, writeEvents } = require('./write.js')`, line ~529: `await writeEvents(ledger)`).
Confirmed the wiring is real, not merely constructed-and-discarded.

`radar_scan_completed`'s payload is genuinely useful, not counters-shaped noise — confirmed real
content: `{"created":{...},"counters":{"claimsBySlug":{...},"claimsWritten":5,...},"obscurity":0.88,"identity_tier":4}`.
`entity_id` on `radar_scan_completed` rows is populated from the real application id when one
exists (`cbba3000-ddc6-4c84-983a-f935eaf40048` in the row I captured), and legitimately null only
when the opt-out gate suppressed the whole write (nothing was created to reference). **But
`crawl_skipped_robots.entity_id` is hard-coded `null` unconditionally** — `crawlSkippedEvent(url,
verdict)` never takes a founder/application/company id parameter at all — so a robots skip can
**never** be joined back to which candidate/scan triggered it; only `payload.url` and the timestamp
distinguish one skip from another. Minor finding, but worth naming since it weakens the
traceability claim specifically for this mechanism.

### 4g. `events` rows this feature writes are not covered by `purge_founder()`'s erasure sweep (Major — GDPR-relevant, directly answers the orchestrator's last probe)

`purge_founder()` (`db/schema.sql` line 800) deletes prior audit history with exactly:
```sql
DELETE FROM events WHERE entity_type = 'founder' AND entity_id = ANY (v_person_ids);
```
`crawl_skipped_robots` rows are written with `entity_type: 'url'`, `entity_id: null`.
`radar_scan_completed` rows are written with `entity_type: 'application'`. **Neither can ever match
this DELETE**, structurally, regardless of which founder is purged. I confirmed this live: the
`crawl_skipped_robots` row from 4f above (containing a real, personal LinkedIn-profile-shaped URL —
exactly the kind of identifying data the erasure path exists to remove) and the
`radar_scan_completed` row from earlier both survived two separate `purge_founder()` calls I made
afterward on unrelated founders (the DELETE's own WHERE clause makes this deterministic, not
timing-dependent — no further live proof is needed beyond reading the SQL, but I confirmed it
anyway):
```
$ psql "$DATABASE_URL" -c "select event_type, payload->>'url' from events where event_type in ('crawl_skipped_robots','radar_scan_completed');"
 radar_scan_completed | (no url)
 crawl_skipped_robots | https://www.linkedin.com/in/some-random-qa-probe-handle
```
(present, unaffected, after two intervening `purge_founder()` calls on other founders — same
session, see case 6 below).

This directly contradicts line 797's own comment ("Prior audit history for every id in the set --
GDPR beats audit") and undercuts design §7's honesty framing: the *known, documented* gap is
"re-ingestion after erasure," but this is a *second, undocumented* gap — a founder's own personal
site/social URL, once logged in a `crawl_skipped_robots` event during their ingest, is **permanently
un-erasable** through the one deletion door this schema provides, because the sweep was written
before these two new `entity_type`s existed and was never extended to cover them.

**Verdict on Case 4: FAIL** — the skip mechanism itself works and is now genuinely persisted
(4f, positive), but 4d (UA mismatch on the actual crawl) and 4g (erasure gap on the feature's own
new event rows) are both real, evidenced, and directly contradict claims the code makes about
itself in its own comments.

---

## Mandatory case 5 — REQ-003 across the 02→03 boundary

Live call, this session, against the currently-deployed workflow:
```
$ curl -s -X POST http://localhost:5678/webhook/f03-score-founder -d '{"founder_id":"a0c5d430-...-ayuhito"}'
HTTP 200, status: scored, value: 75, confidence: 0.58, coverage: 0.32
```
Per-criterion verdicts:
```
E1 met (credit 1, tier documented)     E3 not_met (credit 0, tier documented -- a REAL negative
E4 met (credit 0.8, tier discovered)      observation: "1 of the last 12 weeks had at least one
E5 cannot_assess    E7 cannot_assess       commit", licensed by evidence_tier=documented, not a
X1 cannot_assess  X2 cannot_assess  X6 cannot_assess    missing-data penalty)
L2 cannot_assess   L3 cannot_assess   L5 met (credit 1, tier documented)
```
**L2, L3 both `cannot_assess`, never `not_met`.** X5 was not present in this particular run's
subscorer output at all for this founder (it appears the expertise subscorer only emits the
criteria it has any claim for), but L2/L3 — the two the brief specifically names alongside X5 as
"need a deck/interview the radar cannot produce" — are exactly right. E3's `not_met` is legitimate:
it is licensed by a real `documented`-tier GitHub observation, the opposite of a missing-data
penalty, and correctly distinguished from the `cannot_assess` rows that have `credit: null,
evidence_tier: null`.

**Verdict: PASS.**

---

## Mandatory case 6 — opt-out

### 6a. Base case (re-verified independently, not just trusting the orchestrator's own report)
Set `opt_out_at` on `ayuhito`'s founder row, attempted a **new** HN handle
(`totally-new-fake-handle-qa-probe`) whose GitHub identity resolves (tier 2, 0.85,
`crossPlatformLinked=true`) to the **same, already-opted-out** GitHub login (`ayuhito`):
```
$ psql ... "update founders set opt_out_at = now() where id='a0c5d430-...';"
$ node ... buildWriteSet(new-handle-input) -> founder.full_name = "totally-new-fake-handle-qa-probe"
$ node ... applyWriteSet(...) ->
{
  "blocked": true, "reason": "opt_out",
  "matchedIdentity": {"kind": "github", "value": "ayuhito"},
  "created": {"founder": false, ..., "rawSignals": 0, "claims": 0, "evidence": 0, "metrics": 0}
}
```
`founders`/`raw_signals`/`applications` row counts were **identical** before and after (8/108/39).
The opt-out gate correctly caught this via the *GitHub* identity even though the *HN handle* had
never been seen before — it checks every identity in the write-set, not just the HN one, exactly as
the new code comment claims. Restored `opt_out_at = NULL` on `ayuhito` afterward.

### 6b. Mid-run opt-out (TOCTOU) — Minor, not empirically forced but confirmed by code reading
The opt-out check runs exactly once, at the very top of `applyWriteSet()`, before any row is
written. I re-read the full function body and found no second check anywhere later in the
sequential await chain (founder → identities → company → application → card → N raw_signals → M
claims/evidence → K metrics, each a separate PostgREST round trip). If a founder's `opt_out_at` is
set by another actor *during* an in-flight `applyWriteSet()` call for that same founder, the
in-flight write completes anyway — the code checks once, not per-statement or inside a transaction
with a lock. For a `--recorded` demo-scale run this window is real (several seconds of sequential
HTTP calls), not sub-millisecond. Flagged as a known gap rather than reproduced under an actual
race, since forcing it deterministically would need instrumenting a delay into shipped code.

### 6c. `purge_founder()` re-ingestion limit — confirmed honest, confirmed real
Built a disposable synthetic candidate (`qa-purge-probe-handle`, HN-only, no GitHub), wrote it,
captured its founder id (`910f76fd-...`), called `purge_founder()`, confirmed founder/identity/
raw_signals all zeroed and exactly one anonymized `founder_purged` event (`payload: {}`) was
written, then **re-ran the identical write**:
```
$ psql ... "select purge_founder('910f76fd-...'::uuid);"
$ psql ... "select count(*) from founders where id='910f76fd-...';"   -- 0
$ node ... applyWriteSet(same input again) ->
  "RE-INGEST after erasure -- founder id: 1838c4cb-...  blocked: false"
$ psql ... "select id from founders f join founder_identities fi ... where fi.value='qa-purge-probe-handle';"
  1838c4cb-...   (a brand-new id, not the purged one)
```
The person was silently re-ingested under a fresh id, `blocked: false` — exactly what design §7 and
`ethics.js`'s own comment state plainly as a known, un-fixed limit ("the honest fix is a
salted-hash suppression list, out of MVP scope"). The code does **not** pretend to enforce
anything here; the documentation and the behavior agree. Cleaned up (`purge_founder()` on the
re-ingested test row, confirmed zeroed).

**Verdict on Case 6: PASS** on the base case, the GitHub-identity edge case, and the honesty of the
documented `purge_founder()` limit. 6b is a real but unforced structural gap (Minor).

---

## Mandatory case 7 — `evidence.raw_signal_id` populated for 02's rows

```
$ psql "$DATABASE_URL" -c "
select split_part(cl.topic,'.',1), cl.topic, count(*)
from evidence ev join claims cl on cl.id=ev.claim_id
where ev.raw_signal_id is null group by 1,2;"
 competition | competition.competitor | 3
(1 row)
```
Every NULL `raw_signal_id` evidence row in the entire live database belongs to
`competition.competitor` — feature 04's topic, not one of 02's nine slugs. Zero of 02's own claims
have a NULL `raw_signal_id`.

**Verdict: PASS**, and correctly attributed away from feature 02 (matching the tracker's own
04-attribution note, independently re-confirmed rather than trusted).

---

## Mandatory case 8 — obscurity cannot be gamed by absence

Pulled the live view definition and diffed it term-for-term against `lib/f02/obscurity.js`:
```sql
followers_term = CASE WHEN gh_followers IS NOT NULL THEN 1 - LEAST(GREATEST(log(1+gh_followers)/3,0),1) ELSE NULL END
karma_term     = CASE WHEN hn_karma     IS NOT NULL THEN 1 - LEAST(GREATEST(log(1+hn_karma)/4,0),1)     ELSE NULL END
obscurity      = CASE WHEN both NOT NULL THEN round((f+k)/2,4) WHEN only one THEN round(that one,4) ELSE NULL END
```
```js
followers_term = 1 - clamp(log10(1+gh_followers)/3, 0, 1);   karma_term = 1 - clamp(log10(1+hn_karma)/4, 0, 1);
obscurity = terms.length===0 ? null : round4(mean(terms));
```
Identical, term for term, including the "average over observed terms only, never 0-substitute"
semantics and `obscurity_basis`. No divergence found (the divergence the tracker records as
previously found and fixed did not recur). Confirmed no other field affects the SQL or JS formula
(both take exactly `gh_followers`/`hn_karma`, nothing else).

Verified the anti-gaming property directly: a founder with *only* `hn_karma=9` observed gets
`obscurity=0.75` (one term, unmodified); a founder with the *same* `hn_karma=9` **plus** an
observed `gh_followers=9` gets `obscurity=0.7083` — lower, but because the second, real (not
zero-substituted) data point genuinely indicates marginally more discoverability (9 GitHub
followers reads as slightly more visible than 9 HN karma under this formula's own log-scale, per
the differing /3 vs /4 divisors) — not because having more data was structurally penalized. A
zero-substituted version of the two-term case would have produced ≈0.875 (worse than either real
case), which is exactly what the formula avoids by construction. This matches "fewer observed
metrics must not outrank more, all else equal": nothing here rewards *not having* a metric.

**Verdict: PASS.**

---

## Also probed (unbriefed)

- **B2 inversion (can a claim reach 03 without a resolvable `raw_signals.source`?).** Enforced at
  three independent layers — `claims.js`'s `assertClaimWellFormed` (exported but, see below,
  **never actually called** from the write path), `pipeline.js`'s own runtime assertion (throws if
  any claim's `evidence.raw_signal_ref` doesn't resolve to a raw signal emitted in the *same*
  write-set), and `write.js`'s defensive re-check before insert. Case 7's live query is the
  empirical proof: zero NULL `raw_signal_id` rows among 02's claims. **Not reachable, confirmed.**

- **Minor — `assertClaimWellFormed` is dead code on the real write path.** `claims.js`'s own header
  comment says it is "exported so both this file's own tests **and a caller's DB-write step** can
  call it as a final guard before insert." `grep -n "assertClaimWellFormed" lib/f02/*.js` shows it
  is called only from `claims.test.js`; `write.js` never imports or calls it (it has its own,
  separate, redundant check instead). The invariant holds today (three overlapping enforcement
  layers, one of which the file's own documentation claims is wired in and is not) — low severity,
  but a real gap between what the file says about itself and what runs.

- **Tier-0 recency cap / dropped-count logging.** Tasks 7/7a/8 (the actual n8n scan workflow) are
  marked "pending" in `tracker.md`, but `n8n/build-f02-workflow.py` and
  `n8n/workflows/f02-radar-scan.json` exist on disk and — checked live against the n8n API — the
  workflow **is imported** (`GET /api/v1/workflows` → `f02-radar-scan`, `active: false`,
  `updatedAt` within the last hour of this session). The build script does track
  `dropped_by_cap`/`dropped_no_url` counters and feeds them into the completion-event payload, so
  the design's "the number dropped is logged, never silent" claim looks honored in the source I can
  read — but the workflow is **not active**, so I could not execute it end-to-end to verify the
  counters actually land correctly at runtime, and **`tracker.md`'s task-board status for 7/7a/8 is
  stale** relative to what is actually on disk and in n8n at report time. Flagging as a process
  finding (Minor) rather than a functional PASS/FAIL, since I have not run this workflow myself.

- **`radar_candidates.channel` — minor mismatch with design.** Design §6.4 documents `channel` as
  `'hn_showhn' | 'github_graph'`. The live view instead returns the raw `raw_signals.source` of the
  founder's earliest observation (`hn_algolia` / `github_api` / `tavily_extract`), never the two
  documented enum values. Not misleading in a harmful way (still informative, still a real source
  slug), but a judge reading design.md next to the actual view output would see values that don't
  match the documented enum. Minor / informational.

- **Nothing else in `radar_candidates` looked misleading.** `obscurity_basis`, `freshness`, the
  founder/company/application ids all resolved correctly against real rows I cross-checked.

---

## Summary

| # | Case | Verdict |
|---|---|---|
| — | **DB surface not in `db/schema.sql`/`seed.sql`/`smoke.sql`** | **FAIL (Critical)** |
| 1 | Idempotency | PASS with 2 real findings (`companies` race-duplication — Major; `applications` unbounded duplication on retry — Major) |
| 2 | Organization does not invent a founder | PASS |
| 3 | Handle mismatch, no fuzzy matching | PASS (+ Minor: unsound comment-stripping in the regression test) |
| 4 | robots.txt | **FAIL** (UA mismatch vs. actual Tavily-mediated crawl — Major; erasure does not cover this feature's own new event rows — Major; HTML-as-robots.txt has no sanity check — Minor/Major; unicode paths — Minor) |
| 5 | REQ-003 across 02→03 boundary | PASS |
| 6 | Opt-out | PASS (+ Minor: no TOCTOU protection on a mid-run opt-out) |
| 7 | `evidence.raw_signal_id` populated | PASS |
| 8 | Obscurity anti-gaming | PASS |

Eight of the nine probes I ran (counting the DB-surface check as its own item) turned up something
real; a fully clean sweep here would have made me distrust my own probes, and it didn't happen —
every finding above has a verbatim command/query and an observed output attached, and every finding
is either newly discovered here or, where I re-checked something the orchestrator had just fixed
(the events-persistence wiring in 4f), independently re-derived rather than taken on trust.

## GATE: FAILED

Blocking reasons, in order of severity:
1. Feature 02's DB surface (the `radar_candidates` view and 7 `metric_kinds` rows, which the
   obscurity mechanism and feature 09's read path both depend on) does not survive the project's own
   documented clean-apply procedure. This must be committed into `db/schema.sql` / `db/seed.sql` /
   `db/tests/smoke.sql` before this feature can be marked done.
2. `events` rows this feature introduces (`crawl_skipped_robots`, `radar_scan_completed`) are not
   covered by `purge_founder()`'s erasure sweep, and `crawl_skipped_robots` specifically persists a
   founder's real personal-site/social URL with no erasure path at all — a second, undocumented GDPR
   gap sitting right next to a feature whose whole value proposition this session is "ethics
   mechanics visible in the product."
3. The robots.txt check's own UA-consistency guarantee, stated in its own source comment, is false
   for the actual site-content crawl (delegated to Tavily under an uncontrolled, unverified UA).
4. Two live, reproduced duplicate-row defects (`companies` under a documented-but-now-confirmed
   race; `applications` unboundedly on every retry) contradict the idempotency guarantees Task 7's
   acceptance criteria and design §6.1 claim.

None of these require re-litigating a design decision — 1 is a "commit what already works in the
live DB" fix, 2 and 3 are scoped fixes inside `lib/f02/ethics.js`/`run.js`, 4's `companies` half
needs the schema decision the code already deferred (a real partial unique index, previously ruled
out "for a reviewed change" — this finding is that review's trigger), and its `applications` half
needs either a natural key or an explicit "one application per (company, scan window)" dedup rule.

---

## RE-CHECK ROUND

Everything below is freshly re-derived against the frozen codebase — nothing here is taken on the
coordinator's word. Every claim below has its own command/query and observed output, same standard
as the first pass. Two throwaway Postgres databases (`qa_recheck_02`, created and dropped inside
this round) and a handful of synthetic founders (created, purged, and confirmed gone) were used and
are all cleaned up; details inline.

### Re-check 1 — DB surface (was Critical FAIL)

Re-ran the exact scratch-database probe from the first pass, against the codebase as it stands now:

```
$ psql "$DATABASE_URL" -c "CREATE DATABASE qa_recheck_02;"
CREATE DATABASE
$ DATABASE_URL=".../qa_recheck_02" ./db/apply.sh    # twice, back to back
... CREATE VIEW ...
==> Done.
(second run: every seed INSERT reports "INSERT 0 0" -- fully idempotent)

$ psql ".../qa_recheck_02" -tAc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';"
25
$ psql ".../qa_recheck_02" -c "select table_name from information_schema.views where table_schema='public';"
 radar_candidates
$ for t in score_formulas score_components thesis_evaluations radar_candidates; do
    psql ".../qa_recheck_02" -tAc "select to_regclass('public.$t') is not null;"; done
t / t / t / t
$ psql ".../qa_recheck_02" -tAc "select column_name from information_schema.columns where table_name='theses' and column_name='is_default';"
is_default
$ psql ".../qa_recheck_02" -tAc "select proname from pg_proc where proname in ('validate_thesis_config','activate_thesis_version','purge_founder','forbid_mutation');"
activate_thesis_version / forbid_mutation / purge_founder / validate_thesis_config
$ psql ".../qa_recheck_02" -tAc "select count(*) from metric_kinds;"    -- 12
$ psql ".../qa_recheck_02" -tAc "select count(*) from score_formulas;"  -- 1
$ psql ".../qa_recheck_02" -tAc "select count(*) from theses;"          -- 1
```

**25 tables, 1 view, all four cross-feature objects, `theses.is_default`, all three named
functions, 12/1/1 seed counts — matches the coordinator's own numbers exactly, independently
re-derived**, not copy-checked.

Git tracking, checked directly (not trusted from the commit message):
```
$ git log --oneline -3
0ca3a87 feat(02): sourcing radar — lib/f02 core, recorded fixtures, n8n workflow
edee0df fix(db): restore schema/seed/smoke lost from the working tree (features 02+03+07)
c33deba feat(07): thesis engine — DB layer, deterministic evaluator, n8n workflows
$ git status --short -- db/schema.sql db/seed.sql db/tests/smoke.sql
(clean -- nothing to commit, matches HEAD exactly)
$ git show HEAD:db/schema.sql | grep -c radar_candidates    # 2
$ git show HEAD:db/seed.sql   | grep -c hn_karma            # 1
$ git show HEAD:db/tests/smoke.sql | grep -c 02f00001       # 22
```
Confirmed: the content is in the actual committed tree at `HEAD` (`git show HEAD:...`), not merely
present in a working copy that happens to match. `git ls-files` also lists all three as tracked.

**One honest methodology gap, disclosed rather than hidden:** `db/tests/smoke.sql` FAILED when run
against my scratch `qa_recheck_02` database — `expected SQLSTATE P0001 on the R1 GUC-forge attack,
got 42501 (permission denied for table scores)`. Chased this down rather than reporting it as a
regression: `pg_default_acl` (Postgres's per-database default-privilege table) has 27 rows in the
live `postgres` database (Supabase's own self-hosted bootstrap, `ALTER DEFAULT PRIVILEGES IN SCHEMA
public GRANT ... TO service_role/anon/authenticated`, confirmed in `db/schema.sql`'s own comments as
platform-provisioned, not app DDL) and **zero** rows in a database created ad hoc with `CREATE
DATABASE` inside the same running cluster — that bootstrap only ran once, against the original
`postgres` database, at container first-start, and is not copied by `CREATE DATABASE`. This is a
gap in *my scratch-DB technique*, not in the committed schema: re-ran `psql -f db/tests/smoke.sql`
against the real, Supabase-bootstrapped `postgres` database and it passed clean (all `DO` blocks,
final `ROLLBACK`, exit 0). Did **not** run the full physical cold-start reset
(`rm -rf infra/supabase/volumes/db/data`) to get a from-scratch Supabase-bootstrapped proof, since
that would destroy the live n8n-discovered dataset (68 founders, per the coordinator) with no
offsetting value beyond what the isolated-DDL test plus the real smoke run already prove — noted as
a deliberate scope limit, not a hidden gap. Dropped `qa_recheck_02` when done.

**Verdict: RESOLVED. FIXED.**

### Re-check 2 — events escaping erasure (was Major FAIL)

Read the fix first: `lib/f02/ethics.js`'s `crawlSkippedEvent()` now hard-codes `entity_type:
'founder'` (was `'url'`) with a comment naming exactly the QA finding it closes; `run.js`'s `main()`
now backfills `entity_id` on every ledger row (both `crawl_skipped_robots` and
`radar_scan_completed`) from `result.ids.founder` before calling `writeEvents()`.

Did not trust the diff — built my own end-to-end case, mirroring exactly what `run.js --write` does
but under my own control: wrote a synthetic founder via `buildWriteSet`/`applyWriteSet`, ran a real
`checkRobots()` against a genuinely disallowed URL (`linkedin.com/in/...`), built both ledger
entries with `entity_id` backfilled from the real founder id exactly as `run.js` does, persisted
them, confirmed both rows exist tied to that founder, then purged the founder and confirmed both
are gone:

```
$ node ... -> FOUNDER_ID=f95d460d-d1ff-4937-b482-0ba11bd458f2
robots verdict: {"allowed":false,"checked":true,"status":200,"rule":"/","reason":"disallowed"}
events written: {"written":2}

$ psql ... "select event_type, entity_type, entity_id, payload from events where entity_type='founder' and entity_id='f95d460d-...';"
 crawl_skipped_robots | founder | f95d460d-... | {"url": "https://www.linkedin.com/in/qa-erasure-recheck-probe", ...}
 radar_scan_completed | founder | f95d460d-... | {"blocked": false, "created": {...}, ...}

$ psql ... "select purge_founder('f95d460d-...'::uuid);"

$ psql ... "select event_type, entity_type, entity_id from events where entity_id='f95d460d-...';"
 founder_purged | founder | f95d460d-...     -- the ONLY row left

$ psql ... "select count(*) from founders where id='f95d460d-...';"   -- 0
```
Both event rows — including the one carrying the founder's real personal-site URL, exactly the
data class the original finding was about — are gone after `purge_founder()`, leaving only the
single anonymized tombstone (`payload: {}`), matching `db/schema.sql`'s own `DELETE FROM events
WHERE entity_type = 'founder' AND entity_id = ANY (v_person_ids)` sweep. Test founder cleaned up
(already purged as part of the test; residual `companies`/`applications` rows for the synthetic
domain also confirmed gone).

**Verdict: RESOLVED. FIXED**, on a case I constructed myself, not the coordinator's.

### Re-check 3 — the UA-consistency claim (was "honestly downgraded")

Re-read `run.js`'s current comment above `ROBOTS_UA`. It now says, verbatim: *"HONEST LIMITATION,
found by QA and NOT fixed here... the actual page retrieval is delegated to Tavily's `/map` and
`/extract`, which crawl under Tavily's own identity and expose no UA parameter. So we evaluate
robots.txt as `vcbrain-radar` while a different agent does the fetching -- structurally the pattern
the EDPB guidance treats as not honouring the signal, even though our intent is the opposite."* It
no longer claims the two fetches share an identity. It states the mitigating fact accurately and
I re-verified it rather than trusting the comment: a real `linkedin.com/in/*` check (re-run this
session) still returns `{"allowed":false,"rule":"/","reason":"disallowed"}`, and the code path never
calls Tavily when `!robots.allowed` — so the refusal side genuinely has force regardless of the UA
gap; only the *allow* side is unverifiable. The comment also names a correctly-scoped, cheap
post-MVP fix (fetch the root page directly under the same UA, which the design's own §7.1 field
data says is already the common case since `/map` returns 0 URLs on real small personal sites).

**My own judgment, as asked:** I do not think this specific, now-honestly-scoped gap is on its own
grounds for FAIL. The higher-stakes direction (an explicit refusal) is real, verified, and not
UA-dependent; the exposure is confined to one enrichment path (personal-site crawl), not the
higher-volume HN/GitHub sources; and the wording no longer overclaims. **However, re-reading the
surrounding code for this re-check turned up something the current comment does not mention and
that is not covered by "we can't set Tavily's UA":**

`checkRobots()` is called **exactly once per candidate, against the seed URL only**
(`run.js` line ~421: `robots = await checkRobots(siteSeed, ...)`). If allowed, the code then calls
Tavily `/map` (`max_depth:1, limit:20`) and hands up to 5 of whatever it returns to `/extract`
(`targets = urls.length > 0 ? urls.slice(0, 5) : [siteSeed]`) — **none of those additional,
`/map`-discovered URLs are individually re-checked against the parsed robots.txt rules**, even
though this would need no extra network round trip (the robots.txt text is already in hand at that
point in principle, though the current `checkRobots()` return shape doesn't expose it for reuse).
So even in a hypothetical world where the UA problem were solved, a site with `Allow: /` but
`Disallow: /private` would have its seed correctly cleared, and then any `/private/*` page `/map`
happens to discover would be sent to `/extract` with **no per-path check at all**. Empirically this
is low-exposure today — §7.1's own field data (independently corroborated by both the coordinator's
and my probing) says `/map` returns 0 URLs on real personal sites in practice, so `targets` usually
just falls back to `[siteSeed]` — but it is a real, distinct, and entirely-within-our-own-control
gap (no third party involved) that the current "honest limitation" comment does not disclose.

**Verdict: the false claim is gone — confirmed. The remaining, disclosed gap (UA) is adequately and
honestly worded, and I do not consider it independently gate-blocking. The newly-found, undisclosed
gap (per-path robots scope) is a fresh Minor–Major finding, added to the ledger below.**

### Re-check 4 — duplicates (was Major FAIL, `companies` + `applications`)

Root causes as described — `selectOne` had no `ORDER BY` (now `created_at.asc`), and missing-marker
claims were unhashed (now hashed on `(card_id, topic, sentinel)`) — checked directly in the current
`write.js`, not taken on trust:
```
$ grep -n "order.*created_at" lib/f02/write.js
163:  async function selectOne(table, filters, select, { order = 'created_at.asc' } = {}) {
$ sed -n '/isMissing = evidence.tier/,+15p' lib/f02/write.js
    ... "Missing-marker claims ARE hashed and DO go through the idempotent two-step,
        exactly like every other claim." ... contentHash([cardId, claim.topic, claim.text_verbatim]) ...
```

Ran my own fresh two-pass, all-four-fixture, all-eight-table snapshot test, with a timestamp
(`--now 2026-07-19T14:00:00Z`) neither I nor the coordinator had used before, against the live DB
(which had grown to 87 founders / 157 companies / 264 applications from concurrent activity by this
point — noted, not filtered out):

```
columns: founders,companies,applications,cards,raw_signals,claims,evidence,metric_observations
baseline:                    87,157,264,91,575,595,540,337
after user-artifact write#1: 87,157,264,91,584,595,540,342
after org-artifact write#1:  87,157,264,91,591,595,540,347
after product-url write#1:   87,157,264,91,594,595,540,350
after threaded write#1:      87,157,264,91,600,595,540,355
--- pass 2, identical re-write of all four, same --now ---
after user-artifact write#2: 87,157,264,91,600,595,540,355
after org-artifact write#2:  87,157,264,91,600,595,540,355
after product-url write#2:   87,157,264,91,600,595,540,355
after threaded write#2:      87,157,264,91,600,595,540,355
```
**Zero drift across all eight tables on the retry pass**, matching the coordinator's own "two full
passes, zero drift" claim, independently reproduced with my own timestamp and my own snapshots. Note
`applications` did not even grow on the *first* write here (264→264 throughout) — a genuine
improvement beyond what the coordinator's summary described: `write.js` now also carries an
`artifact_links->>hn_item_id`-scoped natural key for `applications` (checked directly in the source,
with the file's own comment citing this exact QA finding: *"An earlier version of this block cited
01/design.md's 're-application = new row' as licence to insert unconditionally -- that was a
MISREADING, and QA proved its cost live (up to 10 duplicate rows for one company)"*). This resolves
the `Finding A` I raised in the first pass beyond what "Finding 4" as described to me covered.

Confirmed the pre-existing legacy duplicate rows (`safehttp`×4, `puffinsoft`×2, `getting glm...`×2)
were **not** retroactively fixed (expected — the fix prevents new duplicates, it does not merge old
ones) and, more importantly, **no new duplicate-name groups appeared** after my fresh test, even
though the live DB had grown substantially from unrelated concurrent activity in between:
```
$ psql ... "select normalized_name, domain, count(*) from companies group by 1,2 having count(*)>1;"
 safehttp / puffinsoft / getting glm 5.2 running on my slow computer   -- same 3, unchanged
```

**Verdict: RESOLVED. FIXED** on the exact idempotency question Case 1 was about — but see the new
finding immediately below, found while investigating the deployed n8n workflow, which duplicates
`companies` (and, less severely, `applications`) through a completely different mechanism the
CLI-based retry test above cannot see at all.

### New finding (Critical) — the deployed n8n workflow splits Organization-owned candidates into two companies, every time, and the wrong one wins

The coordinator's "also worth attacking" pointer led me into `n8n/build-f02-workflow.py` and the
deployed `f02-radar-scan` workflow (id `qmViGGDMmEEN3XWH`). Its own architecture (per
`n8n/workflows/README-f02.md`, confirmed against the actual node bodies extracted from
`n8n/workflows/f02-radar-scan.json`) calls `buildWriteSet` + `applyWriteSet` **twice per
candidate**: once in `Tier 1 - create entities + raw signals` with
`capabilities: {github:false, tavily:false}` (before the thesis gate, per design §5.5a), and again
in `Tier 2 - Build write set + persist` with full capabilities, after GitHub/Tavily enrichment.

`pipeline.js`'s company-name derivation branches on `identity.orgIsCompany`, which is only knowable
once GitHub data exists (`ghOwnerType` comes from `effGhUser`, which is capability-gated to `null`
in Tier 1). So for an **Organization-owned** artifact specifically, Tier 1 and Tier 2 derive two
different names for the same real-world company. Reproduced directly, using the exact capability
flags the workflow uses, on the `org-artifact` fixture (`G3819` → `puffinsoft`):

```
$ node ... buildWriteSet({...capabilities:{github:false,tavily:false}}) ->
  TIER1 company: {"name":"peek-cli","domain":null}   orgIsCompany:false  tier:5
$ node ... buildWriteSet({...capabilities:{github:true,tavily:true}}) ->
  TIER2 company: {"name":"puffinsoft","domain":null}  orgIsCompany:true   tier:3
SAME company name+domain across both passes? false
```
Both have `domain:null` (`github.com` is generic-hosted), so both go through the fragile
check-then-insert `normalized_name` dedup path — and since the *names differ*, that dedup can never
match them. Tier 1 creates `"peek-cli"` (a repo name); Tier 2 creates a **second, separate** company
row, `"puffinsoft"` (the actual organization). This is not a race and not intermittent — it is
deterministic, 100% reproducible for every Organization-owned Show HN artifact this workflow
processes.

The consequence is worse than "an extra row": `write.js`'s card-creation step (step 4) only sets
`company_id` **once**, on first creation — and Tier 1 runs first, so **the card ends up pinned to
the fabricated repo-named company, never updated when Tier 2 correctly resolves the real
organization**. This directly contradicts design §4.1 tier 3's explicit ruling ("the ORG becomes the
`companies` row... No entity merge") — the deployed workflow does not merge two entities, but it
does **attach the founder's card to the wrong one**.

Confirmed this has already happened, repeatedly, in the live production data (not a fixture, not my
test — real Show HN posts the workflow discovered on its own), by finding every `raw_signals` row
recording a GitHub `Organization`-type owner and cross-referencing by the shared `hn_item_id`:

```
$ psql ... "select rs.founder_id, rs.payload->>'login', rs.payload->>'type' from raw_signals
            where source='github_api' and payload->>'type'='Organization';"
 ... inklate | kaiT2en | brainwavesio | astrio-labs ...   (plus the known puffinsoft/G3819)

$ -- for hn_item_id=48944340 (same candidate, both rows):
   card's company: "kait2en-fedora"       (Tier 1, repo name -- WRONG, this is what the card points to)
   separate row:   "kait2en"              (Tier 2, correct org name -- orphaned, nothing points to it)
$ -- hn_item_id=48943863:
   card's company: "pi-digby"             (wrong)     separate: "brainwavesio"  (correct, orphaned)
$ -- hn_item_id=48942012:
   card's company: "forall"               (wrong)     separate: "astrio-labs"   (correct, orphaned)
```
Three-for-three on real, independently-discovered production candidates, each confirmed via the
matching `applications.artifact_links->>'hn_item_id'` on both sides. **Every Organization-owned
candidate this workflow has processed so far has the wrong company attached to its card**, and the
correct company (the actual organization) sits as a data-complete but unreferenced orphan that
nothing reading through the card (03, 09, a future feed) will ever see.

This does **not** affect non-Organization (`User`-owned) candidates: their company-name branch
(`artifact.kind === 'github_repo' && artifact.repo` → repo name) is identical whether GitHub
capability is on or off, so Tier 1 and Tier 2 agree and no split occurs — checked directly for the
`user-artifact`/`threaded-artifact` fixtures under both capability settings, names matched in both
cases. It also does not require the `companies` fix above to have failed — this is a completely
independent mechanism (capability-dependent name derivation across two sequential write-set builds
within one candidate's single scan), not a race and not a hash-based dedup gap, so nothing in
Re-check 4 touches it.

**Verdict: NEW FINDING, Critical.** This is a live, production-confirmed violation of an explicit,
named design invariant (§4.1 tier 3), not a theoretical risk.

### New finding (Major) — the exact bug class that caused the URL defect is present in at least three more places, unaddressed

Per the coordinator's specific ask ("look for other places where a catch written for bad input
would mask a missing global or an environment defect"). Cross-checked `n8n/workflows/README-f02.md`
first to confirm none of these overlap with the four already-triaged sandbox bugs (crypto, URL,
URLSearchParams, and the missing `.url` field on `parseArtifactUrl`'s return in the Tavily node) —
they do not; these are new.

1. **`ghGet()` in the `Tier 2 - GitHub enrichment` node — worst instance, zero diagnostic trace.**
   ```js
   async function ghGet(self, url) {
     try {
       return await self.helpers.httpRequest({ method: 'GET', url, headers, json: true });
     } catch (e) {
       return null; // absent, not fatal -- design §2's "best-effort, never fatal"
     }
   }
   ```
   This gates `ghUser`, `ghRepos`, `ghSearchPrs`, `ghEvents` (and `ghRepo`/`ghContributors` below
   it) — the majority of the 0.40 of 0.70375 reachable weight that comes from GitHub signals (E1,
   E3, E5, E7 per design §5.1). `e` is never inspected, logged, or distinguished by shape: a genuine
   404 (correct to treat as absent), a rate-limit/403, and a `TypeError: self.helpers.httpRequest is
   not a function`-class environment defect all collapse into the identical `return null`, which
   `pipeline.js`/`claims.js` then read as ordinary "no attempt" / "no GitHub data" — **exactly the
   documented, expected degradation state for a candidate with no `GITHUB_TOKEN`** (design §5.4).
   If this function were ever silently broken by an environment change, the entire GitHub
   enrichment tier would degrade to that same, already-normal-looking state for every candidate,
   indistinguishable from ordinary token-absence, with literally nothing in the logs to notice —
   the precise failure signature the original URL bug had, in the one place with the largest blast
   radius.
2. **`robotsFetchFn()` in the `Tier 2 - Tavily enrichment` node — suppresses the `checked` flag's
   honesty, not just diagnostics.**
   ```js
   async function robotsFetchFn(self, url) {
     try {
       const body = await self.helpers.httpRequest({ method: 'GET', url, json: false });
       return { status: 200, text: async () => String(body) };
     } catch (e) {
       const status = (e && e.statusCode) || (e && e.response && e.response.statusCode) ||
         (e && e.cause && e.cause.response && e.cause.response.status) || null;
       return { status };   // note: no `text` field at all on this branch
     }
   }
   ```
   This never throws — any exception, HTTP-shaped or not, becomes `{status: <derived-or-null>}`.
   Traced the consequence into `checkRobots()` itself: because `robotsFetchFn` never re-throws,
   `checkRobots()`'s own outer `catch` (the one that sets `checked:false, reason:'fetch_failed:...'`)
   is **structurally unreachable** in this deployment — every failure mode, HTTP-level or an
   unrelated code/environment defect in `robotsFetchFn` itself, resolves to
   `{allowed:true, checked:true, status:<...>, reason:'no_robots_txt'}`. That collapses exactly the
   distinction design §7.1 says must stay separate — *"could not verify" and "no robots.txt" are
   different outcomes and must not be conflated"* — and does so by **wrongly reporting `checked:
   true`** (implying we successfully verified) precisely when the true state is "we don't actually
   know, our own request layer errored for a reason that has nothing to do with the target site."
3. **Tavily `/map` and `/extract` (same node) — least severe of the three, but same pattern.**
   ```js
   try { siteMap = await this.helpers.httpRequest({...}); }
   catch (e) { siteMap = { results: [], error: (e && e.message) || String(e) }; }
   ```
   (and the analogous block for `/extract`). Better than `ghGet` in one respect — `e.message` is at
   least captured into the stored payload, so a human inspecting the row later has *something* to go
   on — but the design intent stated right above it in the source ("a failed extract is 'could not
   verify', never 'project is dead'") is written for genuine network/HTTP failures, and is the wrong
   frame if the actual cause was our own code never reaching the target at all.

None of these three are proven to have misfired in the current live run — the 68-founder execution
the coordinator reported succeeded, which is itself evidence `self.helpers.httpRequest` is, in
practice, working correctly right now. This is reported as a **structural, currently-latent risk of
the identical class that already cost real debugging time in this exact codebase**, not as a
proven-active defect — but `ghGet`'s complete absence of any error capture (not even a
`console.error(e)` or a payload field) means that if it *does* ever fire, there is currently no way
to distinguish "GitHub genuinely has nothing" from "our own code stopped reaching GitHub" after the
fact, which is the same blind spot that let the URL bug ship unnoticed until an independent
live-vs-vm cross-check caught it.

**Verdict: NEW FINDING, Major.** Recommend (not fixed by me, per instructions): at minimum, capture
`e && e.message` into every one of these catches (cheapest, matches what `/map`/`/extract` already
do), and for `ghGet` specifically, distinguish "this looks like an HTTP error" (has `statusCode` or
a `response`/`cause.response` shape) from "this does not" and `throw` (or at minimum
`console.error`) on the latter — the same discrimination `robotsFetchFn` already attempts for
deriving `status`, just not carried through to an actual signal.

---

## Updated summary (re-check round)

| # | Original finding | Fresh verdict |
|---|---|---|
| 1 | DB surface uncommitted (Critical) | **FIXED, independently re-verified** (own scratch DB + git tree + real smoke run) |
| 2 | Erasure does not cover this feature's new event rows (Major) | **FIXED, independently re-verified** (own constructed founder+purge case) |
| 3 | UA-consistency claim false (Major) | **Honestly downgraded — I concur it is no longer gate-blocking on its own.** New, undisclosed sub-gap found (per-path robots scope) — Minor–Major |
| 4 | Duplicates in `companies`/`applications` (Major) | **FIXED, independently re-verified** (own 2-pass/4-fixture/8-table snapshot test, zero drift) |
| new | n8n workflow splits every Organization-owned candidate into two companies; card is pinned to the wrong (fabricated) one | **NEW — Critical, confirmed live in production data, three-for-three** |
| new | `ghGet`/`robotsFetchFn`/Tavily `/map`+`/extract` all share the exact catch-swallows-environment-defect pattern the original URL bug had | **NEW — Major, structural risk, not proven active** |

## GATE: FAILED

Three of the original four findings are now genuinely fixed, independently re-verified with fresh
evidence I generated myself rather than trusted — that work is real and I say so plainly. The
fourth (UA-consistency) is honestly downgraded from a false claim to a disclosed limitation, and I
agree that specific, narrow point is no longer independently gate-blocking.

The gate stays FAILED because this re-check surfaced a new, more severe, **already-manifested-in-
production** defect that none of the four fixes touch: the deployed `f02-radar-scan` workflow's
two-phase (capability-gated) execution model deterministically fabricates a wrong company for every
Organization-owned Show HN candidate and pins the founder's card to it, orphaning the real
organization's own company row — confirmed on real, independently-discovered production data
(`kait2en`/`brainwavesio`/`astrio-labs`, not fixtures), not a hypothetical. This is a direct,
now-proven violation of design §4.1 tier 3, the same tier the original QA case 2 was written to
protect, reached through a code path (the n8n two-pass architecture) that CLI-based retry testing —
mine or the coordinator's — cannot see at all.

Secondary, non-blocking-on-their-own but worth fixing in the same pass: the catch-swallows-defect
pattern recurring in three more places (`ghGet` most urgently, given its blast radius and complete
absence of diagnostic trace), and the undisclosed per-path robots-scope gap.

None of this requires reopening what was just fixed. The `companies`-split bug needs either (a) the
company-name derivation deferred entirely to the pass that has full capabilities (skip company
creation/naming in Tier 1 for candidates whose artifact is `github_repo` until Tier 2 has resolved
`ghOwnerType`), or (b) the card's `company_id` updated on every `applyWriteSet` call rather than
pinned at first creation. Either is a scoped fix inside `pipeline.js`/`write.js`, not a schema or
design change.

---

## ROUND 3

Both round-2 findings addressed; re-derived independently, same standard as before — nothing here
is taken on the coordinator's word. One synthetic candidate created during this round with
deliberately unique names (no collision risk with any prior test data), left in the DB as clean
positive evidence rather than purged (noted below).

### Round-3 check 1 — the phase-invariant company anchor (was Critical, live-confirmed-active)

Read the fix first (`lib/f02/write.js`, step 2): a `hn_item_id`-scoped lookup against
`applications` (no `company_id` in the filter, precisely because `company_id` isn't known yet — this
is what breaks the circularity) runs *before* any name/domain-based company resolution. If a match
exists, its `company_id` is reused unconditionally (`created.company = false`), and — since
`companies` is a mutable table with no `forbid_mutation` trigger — a `PATCH` renames it in place
when `writeSet.decisions.orgIsCompany` is true and the name differs. The card's `company_id`,
already pointing at that same row, therefore shows the corrected name automatically, with no card
update needed.

**Test A — a genuinely fresh candidate, engineered to have zero possible name collision with any
prior test data** (unique org login + unique repo name, both stamped with `Date.now()`, so this
could not accidentally reuse a company row from my own or the coordinator's earlier testing — a gap
in my very first synthetic test, see the note below):
```
Tier1 (github:false): company {"name":"qa-round3-uniquerepo-1784438263118", domain:null}
  -> company_id=9314115d-... created.company=TRUE   (genuinely new row)
Tier2 (github:true):  company {"name":"qa-round3-uniqueorg-1784438263118",  domain:null}
  -> company_id=9314115d-... created.company=FALSE  (anchored, same id)
  warning: "company renamed 'qa-round3-uniquerepo-...' -> 'qa-round3-uniqueorg-...'"
SAME company id across phases (no split)? true
```
Confirmed in the DB directly afterward: exactly **one** `companies` row matching either candidate
name, exactly **one** `applications` row for this `hn_item_id`, and the card resolves through to the
final, correct (org) name:
```
$ psql ... "select id, name from companies where name like 'qa-round3-unique%';"
 9314115d-... | qa-round3-uniqueorg-1784438263118          -- exactly one row
$ psql ... "select id, hn_item_id, company_id from applications where company_id='9314115d-...';"
 15b55a87-... | 638263118 | 9314115d-...                    -- exactly one row
$ psql ... "select f.full_name, comp.name from cards c join founders f ... join companies comp ..."
 qa-round3-uniquecand-... | qa-round3-uniqueorg-1784438263118   -- correct
```
(Methodology note: my *first* attempt at this test reused the `org-artifact` fixture's real,
unmodified `gh_repo.json`/`gh_user.json` under a new synthetic HN handle — and it silently attached
to a pre-existing `peek-cli`→`puffinsoft` row left over from earlier testing today, because the
`normalized_name` fallback path matches on the *name string*, which collided since I reused the same
underlying repo data. That is an artifact of *my* test design, not a new defect — company-name
collisions between two genuinely unrelated real GitHub orgs are not a realistic scenario — so I
redid it with the fully unique version above for a clean, unambiguous result.)

**Test B — the coordinator's specific ask: re-derive on the three real candidates the bug was
originally found on, fresh, post-fix.** Extracted their real `hn_item_id`s from the already-split
data (`kaiT2en`=48944340, `brainwavesio`=48943863, `astrio-labs`=48942012) and re-ran each through
`node lib/f02/run.js --live <id>` against real, freshly-fetched HN/GitHub data — first with
`--capabilities github=false,tavily=false` (Tier-1 shape), then with default capabilities (Tier-2
shape), exactly mirroring the deployed workflow's two-phase sequence:

```
hn_item_id=48944340: Tier1 created.company=false / Tier2 created.company=false,
  warning: "company renamed 'kait2en-fedora' -> 'kait2en'"
hn_item_id=48943863: Tier1 created.company=false / Tier2 created.company=false,
  warning: "company renamed 'pi-digby' -> 'brainwavesio'"
hn_item_id=48942012: Tier1 created.company=false / Tier2 created.company=false,
  warning: "company renamed 'forall' -> 'astrio-labs'"
```
`created.company=false` and `created.application=false` on **all six** calls — the anchor found the
pre-existing (wrong-named, from-before-the-fix) row every time and reused it; nothing new was
created. Confirmed in the DB: still exactly the same 6 `companies` rows as before this test (no 7th
or 8th appeared), but now **each formerly-mismatched pair shares the same, correct name** — the
wrong-named row was renamed in place to match its own orphaned, correctly-named twin:
```
astrio-labs   (x2, both now named "astrio-labs")
brainwavesio  (x2, both now named "brainwavesio")
kait2en       (x2, both now named "kait2en")
```
And, not merely "no new split" but an actual, live self-heal of the original bug's damage — the
three founders' **cards now resolve to the correct organisation**, re-queried directly:
```
4l3x4f1sh3r -> kait2en        (was "kait2en-fedora" in round 2's report)
grrowl      -> brainwavesio   (was "pi-digby")
Nolan_Lwin  -> astrio-labs    (was "forall")
```
Also re-ran the fourth org-owned candidate I'd separately found (`inklate`/`missingstack`,
`hn_item_id=48957301`, which had *three* legacy company rows from an even earlier bug generation) —
same result: no new row, `missingstack`'s card now correctly resolves to `inklate` instead of the
Show-HN-title-derived name it had before.

The pre-existing duplicate *rows* for these four organisations still exist (two rows each, now with
matching names) — exactly the "historical duplicates are expected, not a regression" outcome the
coordinator described; nothing merges old rows, and nothing was asked to. What was being tested —
whether a *fresh* run still splits — it does not, on 5 for 5 real/quasi-real candidates plus one
fully clean synthetic one.

**Verdict: RESOLVED. FIXED — independently re-derived on a clean synthetic candidate AND on all
three (plus a fourth) real production candidates the bug was originally found on.**

### Round-3 check 2 — per-URL robots gating (was Minor–Major, undisclosed gap)

Read the fix: `checkRobots()` now returns the fetched `text` alongside its verdict; `run.js` reuses
it (zero extra requests) to call `isCrawlAllowed(robotsText, u, ROBOTS_UA)` for every URL `/map`
hands to `/extract`, dropping and recording (`crawl_skipped_robots`) any that fail, before the seed
`/map` results are ever sent to `/extract`.

Did not read the coordinator's own two added regression tests before writing my own (per this
report's own standing rule not to reuse developer tests as evidence) — instead ran the exact
mechanism against a real, live, currently-published robots.txt (`voronoigo.com`, the same site
probed in the original QA pass, chosen because its real rules mix `Allow`/`Disallow` at different
path depths under one already-allowed root):
```
$ node -e '... checkRobots("https://voronoigo.com/", realFetch, "vcbrain-radar") ...'
seed verdict: {allowed:true, checked:true, hasText:true, textLen:782}

$ -- simulated /map results on the SAME allowed origin, evaluated against the SAME robots.text,
     exactly as run.js now does:
/about       -> {allowed:true,  reason:"no_matching_disallow"}
/game/local  -> {allowed:true,  reason:"allow_overrides"}      -- explicit Allow override
/game/ranked -> {allowed:false, reason:"disallowed", rule:"/game"}
/login       -> {allowed:false, reason:"disallowed", rule:"/login"}
```
On real, live, non-fixture data: **2 of these 4 URLs are disallowed even though the seed (`/`) is
allowed** — concretely proving the seed-only check and the per-URL check are NOT equivalent in
practice on a real site, the exact property worth checking given the coordinator described their own
regression test as asserting this. Had the pre-fix code run against a site shaped like this,
`/game/ranked` and `/login` would have been sent to `/extract` unfiltered.

**Verdict: RESOLVED. FIXED**, confirmed against real, live robots.txt content, not a fixture.

### Round-3 check 3 — catch-swallows-environment-defects (Major, deliberately not fixed)

Re-extracted the Code node bodies from the regenerated, redeployed `f02-radar-scan.json`
(`qmViGGDMmEEN3XWH`) and diffed `ghGet()`/`robotsFetchFn()` against what I recorded in round 2 —
byte-for-byte identical:
```js
async function ghGet(self, url) {
  try { return await self.helpers.httpRequest({...}); }
  catch (e) { return null; }               // unchanged
}
async function robotsFetchFn(self, url) {
  try { ...; return { status: 200, text: async () => String(body) }; }
  catch (e) { ...; return { status }; }    // unchanged, still no `text` on the error branch
}
```
Confirmed the tracker entry the coordinator pointed to is real, not asserted-but-absent:
`docs/backlog/02-sourcing-radar/tracker.md` (~line 472) states, verbatim: *"Left standing,
documented not fixed: QA's structural finding that the catch-swallows-environment-defect pattern
recurs in `ghGet`, `robotsFetchFn` and the Tavily calls — the same shape as the already-fixed
`URL`-undefined bug. Not proven active; recorded honestly."*

**My independent judgment, as asked.** I do not consider this gate-blocking on its own, for four
reasons, weighed together: (1) it is not proven active — the same live 68-founder run that
demonstrated the company-split bug is also evidence `self.helpers.httpRequest` is, empirically,
working correctly right now across all three call sites; (2) it is honestly named in the tracker
with the correct severity and the correct analogy to the bug that did fire, not minimized or hidden;
(3) the remediation is well-understood and cheap (capture `e.message` at minimum, discriminate
HTTP-shaped errors from others in `ghGet` specifically) — this is a scoping decision under real time
pressure, not an unknown risk; (4) every other finding raised across all three rounds that *was*
proven active or provably broken has now been fixed and independently re-verified by me. Shipping
one disclosed, non-active structural risk after three consecutive rounds of real fixes is a
different situation from shipping a report that says "clean" while the DB surface doesn't exist,
erasure doesn't work, or production data is actively wrong — which is what rounds 1 and 2 actually
found and is now resolved.

I'd still fix it if the remaining hours allow (it is cheap), and `ghGet` specifically deserves
priority given it has zero diagnostic trace and the largest blast radius (gates most of the
GitHub-derived reachable weight) — but I am not holding the gate on it.

**Verdict: confirmed not fixed, confirmed honestly disclosed. Judged non-blocking on its own.**

### Round-3 residual note (Minor, informational — not re-derived this round, still standing from
the original pass): the unsound comment-stripping regression test (§ Case 3), the unicode-path
mismatch in the robots parser, `radar_candidates.channel`'s enum not matching design.md, and
`assertClaimWellFormed` never being called from the write path are all still present as of this
round. None were re-checked here (out of scope for what changed) and none were ever gate-blocking.

## Final summary (all three rounds)

| Finding | Origin | Status |
|---|---|---|
| DB surface (`schema.sql`/`seed.sql`/`smoke.sql`) uncommitted | Round 1, Critical | **Fixed, re-verified round 2** |
| `events` rows escape `purge_founder()` erasure | Round 1, Major | **Fixed, re-verified round 2** |
| Robots UA-consistency claim false | Round 1, Major | **Honestly downgraded to a disclosed limitation, round 2** — judged non-blocking |
| `companies`/`applications` duplicate on retry | Round 1, Major | **Fixed, re-verified round 2** |
| n8n two-phase execution splits every Organization-owned candidate's company | Round 2, Critical | **Fixed, re-verified round 3 on real production candidates** |
| Robots check only gated the seed URL, not `/map`-discovered URLs | Round 2, Minor–Major | **Fixed, re-verified round 3 against live robots.txt** |
| Catch-swallows-environment-defects in `ghGet`/`robotsFetchFn`/Tavily calls | Round 2, Major | **Not fixed, deliberately, honestly disclosed in tracker.md — judged non-blocking** |
| Unsound comment-stripping test, unicode-path mismatch, `channel` enum mismatch, dead `assertClaimWellFormed` | Round 1, Minor | Still standing, never blocking |

## GATE: PASSED

Every finding that was proven active — data that was actually missing, actually unerasable,
actually duplicating, or actually wrong in production — has been fixed and independently
re-verified by me, on evidence I generated myself, across three rounds, including live re-tests
against real production candidates and real third-party robots.txt content, not fixtures and not
the developer's own test suite.

One finding remains open by deliberate, disclosed choice: the catch-swallows-environment-defect
pattern in `ghGet`/`robotsFetchFn`/the Tavily calls is the same shape as a bug that did fire in this
exact codebase, is not proven active now, is named accurately in `docs/backlog/02-sourcing-radar/
tracker.md`, and is cheap to close if time remains. I do not judge it gate-blocking given everything
else in this report is now clean, but it should not be forgotten before this feature is considered
fully closed — recommend a follow-up task (not a re-opened gate) to add error-shape discrimination
and at least a captured `e.message` to all three call sites, `ghGet` first.
