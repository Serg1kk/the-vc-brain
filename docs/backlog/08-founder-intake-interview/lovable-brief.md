# Lovable Build Brief — Founder Intake (feature 08)

> **Purpose of this file.** Everything Lovable needs to generate the founder-facing part of
> The VC Brain, in one place: product context, hard constraints, exact routes, exact API
> contracts, exact copy, every screen state, and acceptance criteria.
> **Owner:** feature 08 terminal. **Status:** API contracts below are FROZEN — the n8n
> backend is being built against these exact shapes.
>
> **How to use:** paste §1 as the first Lovable prompt, then feed §5–§11 screen by screen.
> Bring the exported source back to the repo; it will be run locally (see §3.2).

---

## 1. First prompt for Lovable (paste this verbatim)

```
Build the founder-facing part of an early-stage VC platform called "The VC Brain".

This is NOT a marketing site and NOT a SaaS dashboard. It is a short, respectful
application flow for startup founders, plus a follow-up questions page. Three screens
total. Calm, dense, trustworthy — think Notion's approachability with a financial
tool's seriousness. No hero sections, no testimonials, no pricing, no feature grids,
no gradients, no glassmorphism, no emoji, no stock photos, no animated blobs.

Stack: React + TypeScript + Vite + Tailwind + shadcn/ui. React Router for routing.

CRITICAL CONSTRAINTS — do not violate any of these:
- Do NOT connect Lovable's native Supabase integration. Do NOT create a database,
  auth, or any backend. This app is a pure frontend.
- All data goes through fetch() calls to a base URL from an environment variable.
  Never hardcode a URL.
- No authentication of any kind. No login, no signup, no user accounts, no sessions.
- No mock data, no placeholder content, no "coming soon" pages beyond the one
  explicitly specified panel in the spec.
- No analytics, no tracking pixels, no cookie banner.
- Everything must work offline apart from the fetch calls: bundle fonts, no CDN
  <script> or <link> tags, no external image hosts.

Routes:
  /apply           — the application form (default route, redirect / to it)
  /apply/questions — optional follow-up questions, shown after a successful submit
  /apply/status    — confirmation screen
  /a/:token        — standalone follow-up questions page opened from a link
  /privacy         — a plain text disclosure page

I will give you each screen's exact fields, states, and copy next. Start by scaffolding
the app shell, routing, the design tokens, and a typed API client module.
```

---

## 2. Product context (so the generated copy has the right tone)

The VC Brain scores pre-seed founders on evidence rather than pedigree, including founders
with no track record who are invisible to Crunchbase-style databases. This flow is the
founder's entrance to it.

Two facts that should shape every word of the UI:

1. **The founder's number-one pain is not rejection — it is timeline drag.** 37% of
   researched founder complaints are about how long it takes to get *any* answer; rejection
   itself is 3.5%. The product's promise is a verdict within 24 hours. Say so, early and plainly.
2. **The second pain is repetition** — "the same 15 questions, 20 times, every investor
   starts from zero." So the flow must visibly ask only what it does not already know, and
   never ask for something the founder already gave us.

Tone: direct, respectful of time, no salesmanship, no hype adjectives, no exclamation marks.
Never congratulate the founder for applying. Never use the word "journey".

---

## 3. Hard technical constraints

### 3.1 Environment variables

Create `.env.example` with exactly these, and read them via `import.meta.env`:

```
VITE_N8N_BASE_URL=http://localhost:5678
VITE_SUPABASE_REST_URL=http://localhost:8000/rest/v1
VITE_SUPABASE_ANON_KEY=
```

`VITE_SUPABASE_*` are declared for later screens; **the founder flow must not call
Supabase directly** — every write goes through the n8n endpoints in §4.

### 3.2 Local-only — there is no hosted version, ever

**The entire product runs on one machine in Docker.** Supabase, n8n and this frontend are all
local; the deliverables are a demo video recorded against that local stack, plus the source
code on GitHub. Nothing is deployed to the internet — not now, not for the submission.

This is a hard constraint on the generated code, not a deployment preference. A page served
from `https://*.lovable.app` cannot call `http://localhost` — browsers block it as mixed
content and no setting works around it. So Lovable's preview is only ever a design surface;
the app is real once it is exported and run with `npm install && npm run dev` against
`http://localhost:5678`. Therefore:

- no dependency on Lovable's hosting, preview URLs, or their Supabase integration;
- no absolute URLs anywhere in the source;
- `npm run build` must succeed with no environment variables set;
- no service worker, no PWA manifest, no CDN asset, no external font — the demo must render
  identically with the machine offline apart from the local Docker network;
- it will be added to a `docker-compose` stack later, so the dev server must honour `HOST`
  and `PORT` from the environment and must not assume it is the only thing on localhost.

### 3.3 This app will later grow a second half

A separate workstream adds an investor dashboard to this same application under `/app/*`.
Keep the shell generic: routing, design tokens, and the API client must live in shared
modules, not inside the founder pages. **Do not build any dashboard, feed, or investor
screens now** — they are out of scope for this brief and will conflict.

Suggested layout:

```
src/
  main.tsx
  App.tsx                     # router only
  lib/
    api.ts                    # typed fetch client, all endpoints from §4
    types.ts                  # shared response types
    validation.ts             # client-side field rules from §6
  components/ui/*             # shadcn
  components/
    DisclosureBanner.tsx
    ArtifactLinkList.tsx
    FileDropzone.tsx
    QuestionCard.tsx
    NextPhasePanel.tsx
    StatusTimeline.tsx
  pages/
    Apply.tsx
    Questions.tsx
    Status.tsx
    FollowUp.tsx
    Privacy.tsx
```

---

## 4. API contracts — FROZEN, build exactly against these

Base URL: `${VITE_N8N_BASE_URL}`. All requests and responses are `application/json`.
All endpoints may return the error shape in §4.5. Timeouts: deck submit up to 90 s
(it parses a PDF and calls a model) — everything else 15 s.

### 4.1 `POST /webhook/f08-intake-submit`

The one and only way an application is created.

```jsonc
{
  "intake_submission_id": "uuid-v4",      // generated client-side, one per form session,
                                          // resent unchanged on retry — this is the
                                          // idempotency key that prevents double-submit
  "company_name": "Acme Robotics",        // required, 1..120 chars after trim
  "contact_email": "founder@acme.dev",    // required, valid email, <=254 chars
  "deck": {                                // required
    "filename": "acme-deck.pdf",
    "mime": "application/pdf",
    "base64": "JVBERi0xLjQ..."            // no data: prefix, raw base64 only
  },
  "artifact_links": [                      // optional, 0..5 entries
    { "url": "https://github.com/acme/core", "kind": "github_repo" }
  ],
  "extra_files": [                         // optional, 0..3 entries
    { "filename": "demo.mp4", "mime": "video/mp4", "base64": "..." }
  ]
}
```

`kind` is one of `github_repo | github_user | product | other`. The UI infers it from the
URL (see §6.4) and does not ask the founder to choose.

**Response 200:**

```jsonc
{
  "application_id": "uuid",
  "company_id": "uuid",
  "founder_id": "uuid",
  "status": "screening",
  "deck": {
    "extraction_mode": "text_layer" | "vision" | "none",
    "pages": 14,
    "chars_extracted": 8412,
    "warning": null | "image_only_deck" | "extraction_failed"
  },
  "extra_files_stored": 1,                 // stored but not parsed in this version
  "gap_questions": [
    {
      "criterion_id": "L2",
      "question": "Who is using it today, and how did the first one find you?",
      "why": "Your deck doesn't name a first customer or pilot.",
      "placeholder": "A name, a date, and how the conversation started is enough."
    }
  ],
  "estimated_minutes": 2,
  "verdict_eta_hours": 24
}
```

`gap_questions` has **0 to 5** entries. **An empty array is a valid, expected response** —
it means the deck already covered everything the system could not learn on its own. In that
case skip `/apply/questions` entirely and go straight to `/apply/status`.

### 4.2 `POST /webhook/f08-gap-answers`

```jsonc
{
  "application_id": "uuid",
  "answers": [
    { "criterion_id": "L2", "question": "<the question text as shown>", "answer_text": "..." }
  ],
  "skipped_criterion_ids": ["X5"]
}
```

Send answers only for questions actually answered; every question the founder left blank or
explicitly skipped goes in `skipped_criterion_ids`. Sending an empty `answers` array with all
ids skipped is valid and must not be treated as an error.

**Response 200:**

```jsonc
{
  "accepted": 2,
  "skipped": 1,
  "card_completeness": 0.62,               // 0..1
  "status": "screening",
  "verdict_eta_hours": 24
}
```

### 4.3 `GET /webhook/f08-application-status?application_id=<uuid>`

For rendering `/apply/status` after a page refresh.

```jsonc
{
  "application_id": "uuid",
  "company_name": "Acme Robotics",
  "status": "screening" | "diligence" | "decision",
  "submitted_at": "2026-07-19T09:41:00Z",
  "verdict_eta_hours": 24,
  "card_completeness": 0.62,
  "open_questions": 1                      // unanswered gap questions still outstanding
}
```

### 4.4 Follow-up by link

`GET /webhook/f08-followup?token=<token>` — reading does **not** consume the token.

```jsonc
{
  "valid": true,
  "company_name": "Acme Robotics",
  "asked_by": "The investor reviewing your application",
  "note": "Optional free-text note the investor left, or null",
  "questions": [
    { "criterion_id": "L2", "question": "...", "why": "...", "placeholder": "..." }
  ],
  "estimated_minutes": 2,
  "already_answered": false
}
```

Invalid or expired token → **HTTP 200** with `{ "valid": false, "reason": "expired" | "unknown" }`.
Do not treat this as a network error; render the state in §9.4.

`POST /webhook/f08-followup-answers`

```jsonc
{ "token": "...", "answers": [ ... ], "skipped_criterion_ids": [ ... ] }
```

Response: same shape as §4.2.

> Note for the implementer: the token is consumed on this POST, never on the GET — corporate
> mail scanners prefetch links and would otherwise silently burn them.

### 4.5 Error shape

```jsonc
{ "error": { "code": "deck_too_large", "message": "Human-readable, safe to display." } }
```

Known codes to handle specifically: `deck_too_large`, `unsupported_file_type`,
`invalid_email`, `rate_limited`, `internal`. Any unknown code → show `message` if present,
otherwise the generic failure copy in §9.5. **Never show a raw stack trace or JSON blob.**

---

## 5. Design tokens

Light theme is the default; support dark via `prefers-color-scheme` and a `data-theme`
override on `:root`. Define these as CSS variables in `index.css` and map them into the
Tailwind theme.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAFAF9` | `#0C0C0D` | page background |
| `--surface` | `#FFFFFF` | `#161618` | cards, inputs |
| `--border` | `#E7E5E4` | `#27272A` | 1px hairlines, the main structural device |
| `--text` | `#1C1917` | `#FAFAF9` | body |
| `--text-muted` | `#78716C` | `#A1A1AA` | helper text, "why we ask" |
| `--accent` | `#1D4ED8` | `#60A5FA` | primary action, focus ring, progress fill |
| `--warn` | `#B45309` | `#FBBF24` | honest-limitation notices (never red) |
| `--ok` | `#15803D` | `#4ADE80` | confirmation ticks |

- **Type:** system stack (`ui-sans-serif, -apple-system, Segoe UI, Inter, sans-serif`).
  Body 15px/1.6. Labels 13px medium. Page title 24px semibold. One weight step per level,
  never more than two type sizes visible in the same block.
- **Radius:** 8px on cards and inputs, 6px on buttons. Nothing pill-shaped.
- **Elevation:** borders, not shadows. At most one `shadow-sm` on the submit card.
- **Width:** content column `max-w-[640px]`, centred, 24px side padding on mobile.
- **Spacing:** 8px scale. 32px between form sections, 16px between a label and its field.
- **Motion:** 150 ms ease-out on hover/focus only. No entrance animations, no scroll effects,
  no skeleton shimmer — use a plain progress indicator instead.

Accessibility is a requirement, not a nicety: every input has a real `<label>`, focus rings
are always visible, contrast ≥ 4.5:1, the whole flow is keyboard-operable, errors are tied to
inputs with `aria-describedby`, and status changes announce via `aria-live="polite"`.

---

## 6. Screen 1 — `/apply`

### 6.1 Layout, top to bottom

1. Small wordmark "The VC Brain" (text only, no logo asset).
2. Page title + subtitle (§6.6).
3. **Disclosure banner** — bordered, `--warn` left edge, not dismissible (§6.5).
4. Form section "Your company" — company name, contact email.
5. Form section "Your deck" — file dropzone.
6. Form section "Links" — labelled **Optional** (§6.4).
7. Form section "Anything else" — labelled **Optional**, extra files (§6.4).
8. Submit button + the time promise line.
9. **Next-phase panel** (§6.7) — below the fold, visually quieter than the form.
10. Footer: link to `/privacy`.

### 6.2 Required fields — exactly three

| Field | Type | Rules |
|---|---|---|
| Company name | text | required, trim, 1..120 chars |
| Contact email | email | required, RFC-ish check, ≤254 chars, lowercased on submit |
| Deck | file | required, `.pdf` only, ≤10 MB |

**Do not add any other required field.** Not stage, not sector, not location, not team size,
not a founder name, not a phone number, and never a CAPTCHA. Each required field past the
third measurably costs completion, and everything else here is either derivable from the deck
or independently researched by the system.

### 6.3 Deck dropzone

- Drag-and-drop plus a click-to-browse fallback; both must be keyboard reachable.
- Accepts `.pdf` only. Any other type → inline error, `unsupported_file_type` copy.
- Over 10 MB → inline error before any upload attempt.
- After selection: filename, human-readable size, and a "Remove" button. No preview render.
- Convert to base64 with `FileReader` at submit time, not at selection time.

### 6.4 Optional sections

**Links** — up to 5 rows, each a single URL input with an "Add another link" button.
Placeholder: `https://github.com/you/project`. Under the section header, one line of helper
text: *"A repo, a live URL, or a notebook. These are worth more to us than slides."*

Infer `kind` client-side and never ask:

| Pattern | kind |
|---|---|
| `github.com/<owner>/<repo>` | `github_repo` |
| `github.com/<user>` (no repo) | `github_user` |
| any other valid http(s) URL | `product` |
| unparseable | `other` |

Validation: must parse as a URL with an `http` or `https` scheme. **Reject URLs containing
credentials** (anything with `@` before the host, e.g. `https://x.com@evil.com/`). Empty rows
are dropped silently, not flagged.

**Anything else** — up to 3 files of any type, ≤25 MB each. Helper text must be honest and
exact: *"Stored with your application. Only PDFs are read automatically in this version —
anything else is kept for the investor to open."* Do not imply they will be analysed.

### 6.5 Disclosure banner — exact copy, do not paraphrase

```
An AI system reviews your application. It reads your deck and public information about
your work, then a human investor reviews everything before any decision is made. No
decision here is made by AI alone.

You will get an answer within 24 hours.
```

This is a legal transparency requirement, not marketing copy. It must be visible without
scrolling on a 900px-tall viewport, and it must not be collapsible.

### 6.6 Page copy

- Title: `Apply for a $100K pre-seed check`
- Subtitle: `Three fields. A verdict within 24 hours. We do the research ourselves — you don't need to write a summary of your own company.`
- Submit button idle: `Submit application`
- Submit button busy: `Reading your deck…` (see §9.2)
- Under the button: `We'll ask at most three short follow-up questions — optional, about two minutes.`

### 6.7 Next-phase panel — required, and it must read as future work

A bordered, muted card, clearly separated from the form, headed with a small
`NEXT PHASE` eyebrow label. It must never look like an available feature: no button, no
input, no "join waitlist", nothing clickable inside it.

```
NEXT PHASE — Voice conversations

Today we read your deck and your public work. Next, founders will be able to answer in
their own voice instead of typing.

Why it matters:
· A spoken answer is far harder to fake than pasted text, so it counts as stronger evidence.
· Hesitation, pacing and latency carry signal that written answers cannot — which is what
  makes a voice answer resistant to being generated on the fly.
· Voice answers will be scored separately and shown to investors alongside, never merged
  into, the evidence we gather ourselves.

Not available yet. Nothing on this page records audio.
```

That last line is mandatory.

---

## 7. Screen 2 — `/apply/questions`

Reached automatically after a successful submit **when `gap_questions` is non-empty**. State
is passed in-memory via router state; if a user lands here directly with no state, redirect
to `/apply`.

### 7.1 The single most important rule on this screen

**The words "interview", "AI interview", "assessment", "evaluation", "test", "screening
questions" must never appear in founder-facing copy anywhere in this app.** Field research
on 3,000+ applicants found that framing this step as an interview cut continuation by over
50%, and the drop was largest among the most qualified applicants and among women. The
questions are framed as gap-filling, and answering is genuinely optional.

### 7.2 Layout

- Title: `Three things your deck didn't cover` — the number must match the actual question
  count and be grammatically correct for 1, 2 or 3 ("One thing your deck didn't cover").
- Subtitle: `Optional. About two minutes. Skipping any of these does not count against you — it only means we'll have less to go on.`
- A progress indicator: `Question 1 of 3`. Show all questions on one page as a vertical
  stack, not one at a time — the founder must be able to see the total ask up front.
- Each question renders as a `QuestionCard`:
  - the question text (16px, `--text`);
  - the `why` line beneath it in `--text-muted`, prefixed with a small "why we're asking" label;
  - a `<textarea>`, 3 rows, auto-growing to 10, using `placeholder` from the API;
  - a character counter appearing only past 800 characters, with a soft cap of 2000.
- Two actions at the bottom: primary `Submit answers`, secondary text-button `Skip and finish`.
- Per-question skipping is implicit: leaving a textarea empty skips it. Do not add per-question
  skip checkboxes — they add decision friction.

### 7.3 Behaviour

- Answers are editable up to submission; no re-record, no lock-in, no timer.
- `Submit answers` sends every non-empty answer in `answers` and every empty one in
  `skipped_criterion_ids`.
- `Skip and finish` sends an empty `answers` array with all ids skipped, then goes to
  `/apply/status`. It must never show a confirmation dialog or a guilt prompt.
- Do not display any score, grade, rating, strength meter, or "answer quality" feedback.
  Nothing here is scored on how well it is written.

---

## 8. Screen 3 — `/apply/status`

- Large, calm confirmation. No confetti, no animation, no illustration.
- Title: `Application received`
- Line 1: `<Company name> — submitted <relative time>.`
- A three-step `StatusTimeline`, current step emphasised, future steps muted:
  `Received → Under review → Verdict` with `Verdict expected within 24 hours` beneath.
- If `deck.warning === "image_only_deck"`, show the honest notice from §9.3 here as well.
- If `open_questions > 0`, one line with a link back to `/apply/questions`:
  `You left <n> question(s) unanswered. You can still add them.`
- Footer line: `Your answers are visible only to the investor reviewing your application.`
- Link to `/privacy`.

On mount, if the router carries no state (i.e. a refresh), fetch §4.3 using an
`application_id` persisted in `sessionStorage` at submit time.

---

## 9. Every state that must exist

Generated apps usually ship the happy path only. All of these are required.

### 9.1 Idle / validation
Inline field errors appear on blur and on submit, never while typing the first time. The
submit button is disabled only while a request is in flight — never disabled based on
validity, because a disabled button with no explanation is a dead end. Invalid submit →
focus moves to the first offending field.

### 9.2 Submitting
Deck parsing takes real time. Show a determinate-looking progress sequence with these exact
stages, advancing on a timer since the API is a single call: `Uploading your deck` →
`Reading it` → `Checking public sources`. Keep the form visible but disabled behind it. Never
show a spinner alone for more than 2 seconds without a label.

### 9.3 Image-only deck — an honesty feature, not an error
When `deck.warning === "image_only_deck"`, show a `--warn` notice, never red, never blocking:

```
We could not read text from your deck — it looks like the slides are images.

We've stored it for the investor to read directly, and we've noted in your file that our
automatic reading of it was limited. This lowers how much we can verify on our own; it does
not count against you.
```

If `warning === "extraction_failed"`, same treatment with `We couldn't read this file at all.`

### 9.4 Invalid or expired follow-up link (`/a/:token`, `valid: false`)
Plain page: `This link is no longer valid.` plus
`Links expire 24 hours after they're sent. Ask the investor who sent it for a new one.`
No form, no redirect, no error styling beyond muted text.

### 9.5 Network or server failure
Non-blocking error card above the submit button: the API `message` when present, otherwise
`Something went wrong on our side. Your answers are still here — try again.` **The form must
retain every field value.** A `Try again` button re-sends with the **same
`intake_submission_id`** so a retry cannot create a duplicate application.

### 9.6 Rate limited (`rate_limited`)
`Too many attempts. Wait a minute and try again.` Same retention rules as 9.5.

---

## 10. `/privacy` — plain and short

No design work. A single text column, same tokens.

```
What we collect and why

When you apply, we store what you send us: your company name, your email, your deck, and
any links or files you add.

We also look at public information about your work — public code repositories, public posts,
and your own website — to check what your deck says against what already exists publicly.
We only collect signals about your ability to build and ship. We do not collect age, photos,
health, political, religious, or any other sensitive personal information.

The legal basis is our legitimate interest in assessing an investment, and we hold ourselves
to honouring any objection or deletion request without conditions.

Your rights

You can ask us for a copy of your data, ask us to correct it, or ask us to delete it. We
respond within one month. Deletion removes your data from our system entirely.

To make a request, reply to the confirmation email you received.
```

The deletion mechanism itself is built in a separate workstream — this page describes it, and
this page is where that workstream will attach the control. Do not build a delete button here.

---

## 11. Explicitly out of scope — do not build

- Any investor, dashboard, feed, scoring, or memo screen.
- Login, signup, password reset, magic-link request, or any account concept.
- Sending email of any kind.
- A chat interface, message bubbles, typing indicators, or an avatar.
- Audio recording, microphone permissions, or playback controls — the next-phase panel is
  static text only.
- Any AI-generated-text detector, "authenticity" score, or writing-quality indicator.
- Score previews, progress-toward-approval meters, or a "profile strength" bar.
- Multi-step wizards for the three required fields. The main form is one page.
- Autosave to `localStorage` of deck contents.

---

## 12. Acceptance criteria

Tick every line before handing the export back.

**Structure**
- [ ] `npm install && npm run build` succeeds with no `.env` present.
- [ ] `.env.example` contains exactly the three variables in §3.1.
- [ ] No absolute URL, API key, or hostname is hardcoded anywhere in `src/`.
- [ ] No Supabase client, no auth library, no backend folder, no serverless function.
- [ ] All network calls live in `src/lib/api.ts` and are typed against §4.
- [ ] No external `<script>`, `<link>`, font CDN, or image host in `index.html`.

**Flow**
- [ ] `/` redirects to `/apply`.
- [ ] Exactly three required fields; everything else visibly labelled Optional.
- [ ] `intake_submission_id` is generated once per form session and reused on retry.
- [ ] Empty `gap_questions` skips the questions screen entirely.
- [ ] "Skip and finish" reaches the status screen with no confirmation dialog.
- [ ] `/apply/status` survives a page refresh via `sessionStorage` + §4.3.
- [ ] `/a/:token` with `valid: false` renders §9.4 and never a crash or a blank page.

**Copy**
- [ ] The words interview / assessment / evaluation / test / screening appear **nowhere**
      in founder-facing copy.
- [ ] The disclosure banner text of §6.5 appears verbatim and is not collapsible.
- [ ] The next-phase panel ends with "Nothing on this page records audio." and contains
      no interactive element.
- [ ] The image-only-deck notice is worded as a limitation of ours, not a fault of theirs.

**Quality**
- [ ] Every state in §9 is reachable and styled.
- [ ] Full keyboard operation; visible focus rings throughout.
- [ ] Contrast ≥ 4.5:1 in both light and dark.
- [ ] Usable at 360px width with no horizontal scrolling.
- [ ] No console errors or warnings on any route.

---

## 13. Notes for whoever integrates the export

- Route ownership: `/apply*`, `/a/:token`, `/privacy` belong to feature 08. The investor
  dashboard will claim `/app/*` — keep the router table in `App.tsx` so both can coexist.
- The three progress stages in §9.2 are cosmetic; the API is one call. If the backend later
  streams progress, they become real without a UI change.
- `verdict_eta_hours` is returned by the API rather than hardcoded so the promise stays a
  configuration value, not a claim baked into the markup.
