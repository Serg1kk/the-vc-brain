# Spec review — design.md rev.1

> Adversarial spec review run before the operator gate, per the work-on-feature process.
> Reviewer: `implementation-plan-reviewer` subagent, read-only, given the upstream contracts
> (01 design, 02/03 done.md, 07 handoff, TRACKER, live `db/schema.sql` + `db/seed.sql`) and
> both 08 documents. **Verdict: CHANGES REQUIRED** — 5 blockers, 11 major, 3 minor.
>
> All 19 findings were independently verified by the orchestrator against the live database,
> the live n8n container and the seeded config before being accepted. **Every finding was
> real**; none were rejected. rev.2 of `design.md` folds all of them in, marked ⟨R-n⟩.

## Findings

| # | Sev | Finding | Fix applied in rev.2 |
|---|---|---|---|
| 1 | BLOCKER | §3 had no deck-upload step, but `applications_deck_required_for_inbound` CHECK requires `deck_storage_path` at INSERT — cannot be worked around with INSERT-then-UPDATE | Step 2 added: upload before the `applications` write (§3) |
| 2 | BLOCKER | No Storage bucket exists; `db/apply.sh` does not create one; "no schema change" hid an operational prerequisite | §3.0: bucket `decks`, path convention, provisioning named as an owned task |
| 3 | BLOCKER | §6's rule ("`neg_src` limited to deck/interview") excludes X1 and X2, which carry `tavily_extract`. Only L2/L3/X5 qualify — the design's own 0.296 figure proved 3, while its table listed 5 | §6 table cut to three; `gap_questions` is `0..3`; brief §4.1 corrected |
| 4 | BLOCKER | `founders.full_name`, `companies.stage`, `founder_company.role` are NOT NULL with no source in a 3-field form; `companies.domain` UNIQUE would collide if derived from email | §3.1: explicit defaults; `domain` left NULL at intake |
| 5 | BLOCKER | Erasure misses the Storage objects, `events` with a non-`founder` `entity_type`, gap-answer `raw_signals` FKs, and `ai_runs` FKs | §4.1: three commitments + Storage gap disclosed as a known limitation |
| 6 | MAJOR | The image-only `missing` claim had no evidence row — an evidence-less claim inverts REQ-003 via 03's wildcard fallback | §4: every claim carries evidence; deck claims are `self_reported`, never `public` |
| 7 | MAJOR | "Drop criteria already covered by a claim" would count 07's `missing` gap markers as coverage and suppress the right question | §6: coverage check excludes `verification_status='missing'`; convention tie broken via `07/design.md:734` |
| 8 | MAJOR | Email anchoring does not deliver "the score follows the person": shared inboxes merge two humans; a new address loses history; **a radar-discovered founder has no email identity and would be duplicated** — the `ayuhito` demo case | §3.1: GitHub-first resolution order; remaining failure modes stated rather than claimed away |
| 9 | MAJOR | Nothing captures the team — 07 doesn't, 08 didn't; invariant #3 names team background as an evidence-backed claim. Also "traction claims" overloaded a routed prefix | §4: team declared out of scope with its consequences; traction restricted to L2/L3 anchors |
| 10 | MAJOR | The frozen contract permits ~113 MB base64 against n8n's 16 MB default | **Operator decision:** raise `N8N_PAYLOAD_SIZE_MAX=192`, frontend untouched. Mitigation: extra files uploaded first and base64 dropped from the item |
| 11 | MAJOR | `placeholder` is rendered by the frontend but absent from the agent's output schema | §7: added to the schema |
| 12 | MAJOR | `card_completeness` frozen in the contract while listed as an open item | §6.1: defined as covered ÷ reachable weight over the three criteria; explicitly distinct from 03's `coverage` |
| 13 | MAJOR | Nothing persisted the questions asked, yet `open_questions` and the follow-up `questions[]` need them; router state does not survive the required refresh | §8: persisted to `interviews.transcript` |
| 14 | MAJOR | `/privacy` routes erasure requests to "reply to the confirmation email" — email is mocked, so the only legal-commitment page advertises a dead channel | Brief §10 copy corrected |
| 15 | MAJOR | `content_hash UNIQUE` would raise `23505` when a founder re-applies with the same deck — killing the re-application path the design celebrates | §3.2: hashes include `application_id`; retries still dedupe |
| 16 | MAJOR | Idempotency was on a jsonb key with no index or constraint (read-then-insert race); §3 also cross-referenced a §4 that said nothing | §3.2: `applications.id := intake_submission_id` — PK-level dedup |
| 17 | MINOR | Gate call underspecified: no `text` on the `none` branch; caller obligation unstated; `status:"screening"` returned but never set (column defaults to `sourced`) | §3.3 + step 8 |
| 18 | MINOR | Unmentioned n8n mechanics: base64→binary conversion, CORS (fails only in the browser), `rate_limited` unimplemented | §5.1 |
| 19 | MINOR | Weight rounding in §6's table | Seeded values used |

## Sections the review found sound

- §9's share-token scheme — hash-at-rest, consume-on-POST, no device binding, expiry from
  `created_at`; all compatible with the live DDL. Only omission: naming `status='completed'` as
  the representation of "consumed" (added).
- §6's config field names — `criteria` is a jsonb array as 03 warned, and every assumed field
  exists under the assumed name.
- §5's `ExtractFromFile` capability check and the honesty argument for declaring an unreadable
  deck.
- §1.1, §10, §11 — the evidence base, the recorded criteria-transparency tension, and the
  IDEA-002 disclosure that Carl never endorsed the interview idea.

## Reviewer's own disclosure, and what the orchestrator verified afterwards

The reviewer had no Bash tool and flagged five things it could not confirm. Each was then
checked against the live environment:

| Reviewer could not verify | Orchestrator check | Result |
|---|---|---|
| Whether the Storage bucket is genuinely absent | `GET /storage/v1/bucket` | `[]` — confirmed absent |
| `N8N_PAYLOAD_SIZE_MAX` / CORS on the live container | `docker exec vcbrain-n8n printenv` | Neither set — defaults apply, both findings real |
| Which 07 gap-marker convention is authoritative | Read `07/design.md:734` | Base topic + `verification_status='missing'`; `handoff.md`'s `.gap` wording is explicitly marked wrong there |
| X1/X2 `neg_src` values | `grep` of the seeded `score_formulas` row | Both carry `tavily_extract` — finding 3 confirmed |
| NOT NULL columns | `grep` of `db/schema.sql` | `full_name:68`, `stage:108`, `role:152`, `domain UNIQUE:104` — confirmed |

It also did not read `01/design.md` (checking claims against the live DDL instead, which is the
stronger check) and read `db/schema.sql` only to line 1341 of 1606 — the unread tail is feature
10's views, which 08 does not touch.
