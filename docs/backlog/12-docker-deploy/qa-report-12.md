# QA Report — Feature 12 (Docker & Deploy — remote test-server deploy)

> Independent adversarial acceptance pass against the **live public deploy**
> (`dashboard.prodsignal.me`, `submit.prodsignal.me`, `vc-api.prodsignal.me`, `vc-n8n.prodsignal.me`),
> run 2026-07-19. Two passes: curl/PostgREST evidence, then a full Playwright walkthrough once the
> shared browser freed up mid-session. No dev tests reused, no local stack touched.

## TWO SEPARATE VERDICTS — do not conflate them

1. **Infra / data-backed functionality: PASSED.** Routing, TLS, CORS, ingestion, scoring, evidence,
   contradiction-detection, and every screen tested render correctly against real data with zero
   console errors and zero failed requests. See §A–§E.
2. **PUBLIC-RELEASE GATE: BLOCKED (CRITICAL).** The deploy is technically sound but **MUST NOT be
   made public — not to judges, not in the submission — until both items in §F clear**:
   - **F1 — real-people exposure.** 343 of 359 applications (95.5%) on the live, publicly-reachable
     API are real people (`is_synthetic:false`), not the intended synthetic-only demo set.
   - **F2 — no password gate.** The dashboard is meant to be app-level password-gated (design.md);
     none exists in this build. Combined with F1, anyone with the link can browse real founders'
     data and AI-generated claims about them with zero authentication.

**Bottom line: technically sound, not yet safe to publish.**

---

## F. Public-release blockers (read this section first)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| F1 | **343/359 (95.5%) applications on the live public API are real people, not synthetic.** | CRITICAL | `GET https://vc-api.prodsignal.me/rest/v1/api_applications?select=is_synthetic` (anon key, no auth) → 359 rows, `Counter({False: 343, True: 16})`. Confirms `docs/backlog/12-docker-deploy/tracker.md`'s "DATA POLICY CHANGE" note independently, via the live API rather than just reading the tracker: the operator ruled the public demo DB must hold ONLY the feature-11 synthetic dataset (ethics: no AI-generated claims about real people on a public URL), and a swap (SWAP-1/SWAP-2 in the tracker) is pending on feature 11 finishing. As of this pass, that swap has **not** happened — the real-people data is live on the public URL right now. |
| F2 | **No app-level password gate on the dashboard.** | CRITICAL (compounds F1) | design.md §"Target topology": `dashboard.prodsignal.me` is meant to be "password-gated (app-level password added by feature 09)". Live: `GET /` → `302`, `GET /app/feed` → `200`, no `401`/`WWW-Authenticate` anywhere in the chain. Grepped `web/src/` for a password-gate component/route guard — none found (only an unrelated string match in `validation.ts`). Together with F1, this means the real-people data is not just present but is reachable by anyone with the URL, no credential required. |

**Resolution path (already in motion, per tracker.md):** feature 11 finishes generating the curated
synthetic dataset → SWAP-1 (extract synthetic-only from local) → SWAP-2 (wipe remote person-data,
load synthetic-only, re-verify) → re-run this same `is_synthetic` check against the live API,
expect **0** `false` rows. F2 needs its own fix (in-app gate or Caddy basic-auth) independent of the
swap. **I will re-verify both against the live API/UI once the team lead signals they've landed —
do not treat this report as re-confirming either item resolved until that re-verification happens.**

---

## A. Ingress / infra

| # | Check | Verdict | Evidence |
|---|---|---|---|
| A1 | TLS valid on all four hosts | PASS | `curl -sI -w '%{ssl_verify_result}'` → `0` (verified) on `dashboard`, `submit`, `vc-n8n`, `vc-api`. |
| A2 | `favicon.svg` serves correctly | PASS | `GET https://dashboard.prodsignal.me/favicon.svg` → `HTTP/2 200`, `content-type: image/svg+xml`. |
| A3 | `vc-n8n.prodsignal.me` shows n8n login/app shell | PASS | Root returns n8n's own HTML shell (`<title>n8n.io - Workflow Automation</title>`, n8n `2.30.7` in a Sentry config meta tag) — confirmed reachable. |
| A4 | `vc-api.prodsignal.me` root is auth-gated | PASS | `GET /` → `HTTP/2 401`, JSON body, `access-control-allow-origin: *` present even on the 401. (Studio itself is gated — the underlying `/rest/v1/*` data is not; see F1/F2.) |
| A5 | `vc-api.prodsignal.me/rest/v1/api_founders` with anon key returns real data | PASS | `GET /rest/v1/api_founders?limit=1` → `HTTP 200`, one fully-populated founder row (`founder_score`, `founder_score_confidence`, `founder_score_missing`/`founder_score_gaps` all populated with real per-criterion reasoning). Confirms remote PostgREST + demo dataset are live and the honest-about-gaps invariant is wired into the API, not just the UI. |
| A6 | CORS preflight from the dashboard origin to the API succeeds | PASS | `OPTIONS /rest/v1/api_founders` with `Origin: https://dashboard.prodsignal.me` → `HTTP/2 200`, correct `access-control-allow-*` headers. Matches design.md §5. |

## B. `dashboard.prodsignal.me` — full walkthrough (Playwright)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| B1 | Root → `/app` → `/app/feed` redirect chain | PASS | `curl -sL` → 2 redirects, final `200`. |
| B2 | Feed renders real data, correct lane structure | PASS | Screenshot (`dashboard-feed.png`, saved to session scratchpad — **not committed**, see note below). 359 applications. Correct three-lane structure per product invariant #1/§thesis rules: "Off-thesis but exceptional" (independent-axis override, not silently filtered), "In thesis", "Outside thesis". Coverage/fit columns show F/M/I/T axes independently (never averaged into one number) — e.g. Voltaic Labs: F "not assessed", M "50", I "50", T "not assessed" — visibly not collapsed. `SYNTHETIC` badges render correctly on synthetic rows. Honest "not assessed" state shown for the majority of the feed rather than a fabricated score. |
| B3 | Founder card (Voltaic Labs) — header, scores, contradiction detection | PASS | Screenshot (`founder-card-voltaic.png`). Three independent axis cards (Founder/Market/Idea-vs-Market) plus a separate "Trust — per-claim rollup" card, never merged. Founder Score card reads **"Not enough evidence to score" / "0 of 12 assessed" / coverage 0.00, below the 0.25 threshold** — a real computed gate, not a narrative placeholder (product invariant #2/#4). A live **contradiction banner** ("1 contradiction found — worth raising on the call") correctly surfaces the deck's claim ("three paying pilot customers in banking and healthcare") against the company homepage's actual content ("invites visitors to join the waitlist... private beta") — the truth-gap/trust engine (feature 05) working exactly as designed on real data, not a canned demo string. |
| B4 | All 5 founder-card tabs render | PASS | Evidence, Market, Competition, Interview, "What we don't know" all clicked live. Zero console errors/warnings across all 5. Interview tab showed the correct honest-empty state ("No interview answers collected yet"). Evidence tab shows per-claim trust pips, source attribution, `Judgement — not verifiable` / `Not disclosed` / `Conflicting` tags — matches product invariant #3 (trust on every claim, not per-company). |
| B5 | Memo route degrades gracefully | PASS | Screenshot (`memo-page.png`). "No memo generated yet... this is the honest state, not a loading spinner", `Generate memo` button correctly disabled with "Not available in this build — integration point for feature 06." No crash, no white screen. |
| B6 | Thesis Engine page renders, fully configurable | PASS | Screenshot (`thesis-page.png`). Sectors/geographies/stages/keywords/fit-tuning/rules/exceptional-lane all editable and populated with the live "default v2" thesis (product invariant #6). **Did not modify or save anything** — this is a live-writes form on the production demo DB; observed only. |
| B7 | Invalid ID handling | PASS | Navigating to `/app/f/<company_id>` (wrong ID shape) redirected gracefully back to `/app/feed` — no crash, no white screen, no stack trace. |
| B8 | Console errors / failed network requests across the whole walkthrough | PASS | 0 console errors/warnings at every step (feed, card, all 5 tabs, memo, thesis). All `vc-api` requests inspected returned `200`. |
| — | App-level password gate | see **F2** above — CRITICAL, blocks public release. |

**Note on screenshots:** 7 screenshots were taken during this pass and are **not committed to the
repo** — they depict real founders' names, scores, and AI-generated claims (see F1), and this
repo's `docs/` is published publicly per project policy. Saved locally to the session scratchpad
(`.../scratchpad/qa-report-12-screenshots/`) for the team lead's reference; delete once no longer
needed, do not move into `docs/`.

## C. `submit.prodsignal.me` — full walkthrough (Playwright)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| C1 | Root client-routes to `/apply` | PASS | `page.goto('/')` → final URL `/apply`, title "Apply — The VC Brain". |
| C2 | Intake form renders correctly | PASS | Screenshot (`apply-page.png`). Non-dismissible AI-disclosure banner present verbatim ("An AI system reviews your application... No decision here is made by AI alone" — guardrail #1/#2 from feature 08, still holding). Company name / email / deck upload (10 MB cap) / optional links / optional other-files / Submit button all render. "Voice conversations — Not available yet. Nothing on this page records audio" next-phase notice present (matches known E5/E6 state from feature 08's QA pass). **Did not submit** — n8n webhooks are inactive by design this pass, not tested. |
| C3 | `/apply/questions` cold-navigation guard | PASS | Direct navigation with no in-flight session correctly `<Navigate to="/apply" replace/>`s (confirmed in `apply.questions.tsx:40`) — a deliberate guard, not a regression of the previously-fixed E1 routing bug from feature 08. |
| C4 | `/apply/status` cold-navigation state | PASS | Screenshot (`apply-status.png`). Honest "No application in this session. Start an application." — no crash. |
| C5 | `/privacy` renders live | PASS | Confirmed live, matches the corrected copy from feature 08's QA pass (names "contact the investor you applied to" as the erasure channel, discloses email delivery isn't wired up in this build). |

## D. Data-architecture finding — sourcing/radar dedup gap

| # | Finding | Severity | Evidence |
|---|---|---|---|
| D1 | **139 of 359 application rows (38.7%) are duplicates of an already-seen company**, concentrated almost entirely in the outbound sourcing-radar pipeline. | MAJOR (not a public-release blocker, but directly hits the 30%-weighted "Data Architecture & Intelligence: smart ingestion, dedup" rubric criterion) | Pulled all 359 rows from `GET /rest/v1/api_applications?select=*` (read-only). 220 unique `company_name` values; 84 names appear more than once. Worst cases: `rewindcup` × 14 (**all 14 share the same `company_id`** — same underlying company re-inserted as a new application row repeatedly, two rows submitted 200ms apart), `safehttp` × 12 (spread across **4 different `company_id` values** — entity resolution also failed to recognize the same real-world company/founder across separate ingestion runs), `puffinsoft` × 11 (3 distinct `company_id`s). Breakdown by `kind`: 210 of the 309 `radar_activated` (outbound) rows are involved in a duplicate group, vs. only 13 of 50 `inbound` rows — this is concentrated in feature 02's sourcing-radar re-activation logic, not a general system-wide issue, and not feature 08's inbound intake (which is nearly clean). Confirmed live on the dashboard feed too: the "safehttp" HN post ("Show HN: Safehttp – an SSRF-resistant HTTP client for Go", author `ayuhito`) appears as 9 separate rows in the "Off-thesis but exceptional" lane in the UI, not just in the raw API. **Not this feature's file to fix** — flagging with full repro for feature 02/09 ownership, same as prior QA reports flag cross-feature issues without fixing them out of scope. |

---

## Zero destructive actions — confirmed

Every check in this report is a `GET`/`HEAD`/`OPTIONS` request, a Playwright click/navigation on
read-only UI, or a static source review. Specifically:
- No intake form was submitted (C2).
- No delete/purge/opt-out control was clicked. The founder-card "⋯ More actions" → "Delete this
  person's data" control (wired to `purge_founder()`) was identified by reading
  `web/src/routes/app/f.$applicationId.tsx` source, never opened or clicked in the browser.
- The Thesis Engine's live editable form (B6) was viewed only — no field was changed, no save
  action was triggered.
- The one non-benign action taken all session was closing an **idle, orphaned** Chrome process
  (30+ min on `about:blank`, explicitly authorized by the team lead after confirming it belonged to
  neither `db-dump` nor `deploy-vps` and was not the operator's separate human-tester browser) —
  not a mutation against the deploy itself.

---

## Summary table

| Area | Status |
|---|---|
| F. Public-release gate (2 items) | **BLOCKED — CRITICAL.** Real-people exposure (F1) + no password gate (F2). Do not publish the URL until both clear. |
| A. Ingress/infra (6 checks) | 6 PASS |
| B. Dashboard walkthrough (8 checks) | 8 PASS — feed, founder card, all 5 tabs, memo, thesis, invalid-ID handling, zero console/network errors |
| C. Submit walkthrough (5 checks) | 5 PASS — intake form, cold-nav guards, privacy page |
| D. Dedup finding | MAJOR, cross-feature (sourcing radar), not a publish blocker but rubric-relevant — flagged for feature 02/09 |

## Status at close

**Infra and functionality: PASSED.** Every screen tested renders correctly against real, live data
with zero console errors and zero failed requests. Several core product invariants were verified
live, not just in source: independent 3-axis scoring, honest "not enough evidence" gating on the
Founder Score, per-claim trust with a genuinely-caught contradiction, and graceful empty/cold-nav
states everywhere they matter.

**Public release: BLOCKED.** F1 (95.5% real-people exposure) and F2 (no password gate) are both
CRITICAL and both must clear before this URL goes to judges or into the submission. Both are
already being actively worked per `tracker.md`'s SWAP-0/1/2 tasks — this report doesn't need to
trigger new work, just hold the gate until they land. I'll re-verify both against the live
system once the team lead signals they've landed; until then, do not treat F1/F2 as resolved.

D1 (dedup) is a separate, non-blocking finding for feature 02/09 to pick up — real and
rubric-relevant, but does not gate publication the way F1/F2 do.

**PUBLIC-RELEASE GATE: BLOCKED (CRITICAL) — do not publish until F1 and F2 clear. Infra/functionality: PASSED.**
