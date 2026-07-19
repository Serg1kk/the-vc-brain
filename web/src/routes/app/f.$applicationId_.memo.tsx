// The investment memo — brief §10. A document, not a dashboard: single column,
// generous leading, print-friendly. Required sections render in a fixed order;
// padding is scored against us, so a section with nothing to say says so in one
// line rather than being filled.
//
// The dominant state today (brief owner's brief, verified live): `memos` has 0 rows
// anywhere in the corpus — feature 06 (the memo writer) has not shipped. The honest
// empty state below is therefore what this screen actually shows in the demo; the
// "has a memo" render path is built against `db/schema.sql`'s column contract and
// brief §10's requirements, but the internal shape of `sections` / `deep_dive_questions`
// / `conditions` is NOT frozen anywhere (feature 06 unbuilt) — `investor-api.ts` reads
// them as `unknown` on purpose, and the tolerant normalizers below are this screen's
// best-effort reading of that shape, not a guessed contract baked into the shared
// client. Fix the normalizers here, not investor-api.ts, once 06 ships a real payload.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getApplications,
  getClaimTrust,
  getClaims,
  getCurrentMemo,
  getFounders,
  type ClaimWithTrust,
  type MemoRecommendation,
  type MemoRow,
  type Result,
} from "@/lib/investor-api";
import { ProvenanceChip } from "@/components/app/provenance-chip";
import { VerdictBadge, JudgementBadge, ForecastBadge, verdictLabel } from "@/components/app/claim-badges";
import { SyntheticBadge } from "@/components/app/synthetic-badge";
import { ThesisFitLedger } from "@/components/app/thesis-fit-ledger";
import { useExplainPanel, type ExplainPanelData } from "@/components/app/explain-panel";

export const Route = createFileRoute("/app/f/$applicationId_/memo")({
  head: () => ({
    meta: [{ title: "Investment memo — The VC Brain" }, { name: "robots", content: "noindex" }],
  }),
  component: Memo,
});

// ---------------------------------------------------------------------------
// Tolerant section normalizers — see file header. `sections.<key>` is EITHER a
// plain string (rendered as one paragraph; citations traced via the memo-level
// `cited_claim_ids` list at the foot of the document instead of inline) OR an
// array of `{text, claim_id}` blocks (rendered as sentences, each with its own
// inline verdict badge, matching the design export). Anything else renders as
// honestly as JSON.stringify allows rather than crashing or showing nothing.
// ---------------------------------------------------------------------------

interface ProseBlock {
  text: string;
  claimId: string | null;
}
type ProseSection = string | ProseBlock[];

function normalizeSection(raw: unknown): ProseSection {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((item): ProseBlock => {
      if (item && typeof item === "object" && "text" in item) {
        const it = item as { text: unknown; claim_id?: unknown };
        return {
          text: typeof it.text === "string" ? it.text : String(it.text),
          claimId: typeof it.claim_id === "string" ? it.claim_id : null,
        };
      }
      return { text: String(item), claimId: null };
    });
  }
  if (raw == null) return "";
  return typeof raw === "object" ? JSON.stringify(raw) : String(raw);
}

function sectionHasContent(section: ProseSection): boolean {
  if (typeof section === "string") return section.trim().length > 0;
  return section.length > 0 && section.some((b) => b.text.trim().length > 0);
}

function sectionToPlainText(section: ProseSection): string {
  if (typeof section === "string") return section;
  return section.map((b) => b.text).join(" ");
}

interface SwotShape {
  strengths: ProseSection;
  weaknesses: ProseSection;
  opportunities: ProseSection;
  threats: ProseSection;
}

function normalizeSwot(raw: unknown): SwotShape {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    strengths: normalizeSection(obj.strengths),
    weaknesses: normalizeSection(obj.weaknesses),
    opportunities: normalizeSection(obj.opportunities),
    threats: normalizeSection(obj.threats),
  };
}

interface DeepDiveQuestion {
  question: string;
  closesGap: string;
}

/** `deep_dive_questions`'s shape is not frozen (see file header) — this accepts
 * either `closes_gap`/`gap`/`closes` for the "what this closes" string, so a
 * reasonable future payload from feature 06 needs no code change here. */
function normalizeDeepDiveQuestions(raw: unknown): DeepDiveQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): DeepDiveQuestion | null => {
      if (!item || typeof item !== "object") return null;
      const it = item as Record<string, unknown>;
      const question = it.question ?? it.q;
      const gap = it.closes_gap ?? it.gap ?? it.closes;
      if (typeof question !== "string") return null;
      return { question, closesGap: typeof gap === "string" ? gap : "" };
    })
    .filter((q): q is DeepDiveQuestion => q !== null);
}

function normalizeConditions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const it = item as Record<string, unknown>;
      const text = it.condition ?? it.text;
      if (typeof text === "string") return text;
    }
    return String(item);
  });
}

const RECOMMENDATION_LABEL: Record<MemoRecommendation, string> = {
  proceed: "Proceed",
  "proceed-with-conditions": "Proceed with conditions",
  pass: "Pass",
  watchlist: "Watchlist",
};

// SWOT is rendered separately (4 named quadrants, not one prose block) between
// "Investment hypotheses" and "Problem & product" — the required order from
// brief §10 — so the required sections split around it rather than listing it.
const SECTIONS_BEFORE_SWOT: Array<{ key: keyof MemoRow["sections"] & string; heading: string }> = [
  { key: "snapshot", heading: "Company snapshot" },
  { key: "hypotheses", heading: "Investment hypotheses" },
];
const SECTIONS_AFTER_SWOT: Array<{ key: keyof MemoRow["sections"] & string; heading: string }> = [
  { key: "problem_product", heading: "Problem & product" },
  { key: "traction", heading: "Traction & KPIs" },
];

const OPTIONAL_SECTION_HEADINGS: Record<string, string> = {
  risk_matrix: "Risk matrix",
  competition: "Competition",
  financials_lite: "Financials",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Citation resolution — a targeted two-read join (api_claims + claim_trust) over
// exactly `cited_claim_ids`, not the whole application's claim set. Same join
// `getEvidenceLedger` performs, keyed differently — kept local rather than added
// to investor-api.ts, since it isn't a general-purpose primitive other screens need.
// ---------------------------------------------------------------------------

async function fetchCitedClaims(claimIds: string[]): Promise<Result<ClaimWithTrust[]>> {
  if (claimIds.length === 0) return { ok: true, data: [] };
  const idList = `in.(${claimIds.join(",")})`;
  const [claims, trust] = await Promise.all([
    getClaims({ filters: { claim_id: idList } }),
    getClaimTrust({ filters: { claim_id: idList } }),
  ]);
  if (!claims.ok) return claims;
  if (!trust.ok) return trust;
  const trustByClaim = new Map(trust.data.map((t) => [t.claim_id, t]));
  return {
    ok: true,
    data: claims.data.map((c) => ({ ...c, trust: trustByClaim.get(c.claim_id) ?? null })),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function claimExplainData(entry: ClaimWithTrust): ExplainPanelData {
  return {
    title: entry.topic,
    what: entry.text_verbatim,
    // Per brief §4.1: claim verdicts are a model's judgement of what a source
    // says — the arithmetic of how much that's worth (trust, pips) is `▦◇`, but
    // the verdict itself is `◇`.
    chip: "model",
    model: {
      modelName: entry.trust?.router_class ?? "claim-verification",
      asked: "Judge this claim against the retrieved evidence for this entity.",
      shown: `${entry.evidence.length} evidence row${entry.evidence.length === 1 ? "" : "s"} for this claim.`,
    },
    evidence: entry.evidence.map((e) => ({
      claim: entry.text_verbatim,
      quote: e.quote_verbatim,
      sourceUrl: e.source_url,
      sourceLabel: e.source_url ? hostOf(e.source_url) : undefined,
      tier: e.tier,
      verdict: entry.trust ? verdictLabel(entry.trust.derived_status) : undefined,
      date: e.captured_at ? formatDate(e.captured_at) : undefined,
    })),
  };
}

/** Renders one cited sentence with its inline verdict badge — Family A/B per
 * scoring-ux §3.6(b): qualitative/unverifiable claims never get a verdict
 * ("Judgement — not verifiable"), forecast claims never get a verdict either
 * ("Forecast"), everything else renders its `derived_status`. */
function CitedSentence({
  text,
  claim,
}: {
  text: string;
  claim: ClaimWithTrust | undefined | null;
}) {
  const { open } = useExplainPanel();

  if (!claim) {
    // The claim id on this block didn't resolve against `cited_claim_ids` —
    // surface that as a visible gap, not a silently dropped citation. A memo
    // sentence with no traceable claim behind it is a bug (brief §10), and
    // hiding this would hide the bug along with it.
    return (
      <>
        {text}{" "}
        <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">(uncited)</span>{" "}
      </>
    );
  }

  const badge =
    claim.trust?.router_class === "forecast" ? (
      <ForecastBadge className="cursor-pointer" />
    ) : claim.trust?.router_class === "qualitative" || claim.trust?.router_class === "unverifiable" ? (
      <JudgementBadge className="cursor-pointer" />
    ) : (
      <VerdictBadge status={claim.trust?.derived_status ?? "unverified"} />
    );

  return (
    <>
      {text}{" "}
      <button
        type="button"
        onClick={() => open(claimExplainData(claim))}
        className="cursor-pointer border-none bg-transparent p-0 align-baseline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
      >
        {badge}
      </button>{" "}
    </>
  );
}

function ProseBlockText({
  section,
  citedByClaimId,
}: {
  section: ProseSection;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  if (typeof section === "string") {
    return <p className="m-0 text-wrap-pretty">{section}</p>;
  }
  if (section.length === 0) {
    return <p className="m-0 text-[13px] text-[color:var(--color-text-muted)] italic">Nothing to say here.</p>;
  }
  return (
    <p className="m-0 text-wrap-pretty">
      {section.map((block, i) => (
        <CitedSentence
          key={i}
          text={block.text}
          claim={block.claimId ? citedByClaimId.get(block.claimId) : null}
        />
      ))}
    </p>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <>
      <h2 className="mt-[26px] mb-0 text-[20px] font-medium">{children}</h2>
      <div className="ms-rule mt-1.5 mb-3" />
    </>
  );
}

function SwotQuadrant({
  label,
  section,
  citedByClaimId,
}: {
  label: string;
  section: ProseSection;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  return (
    <div>
      <span className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        {label}
      </span>
      <div className="mt-1 text-[14px]">
        {sectionHasContent(section) ? (
          <ProseBlockText section={section} citedByClaimId={citedByClaimId} />
        ) : (
          <p className="m-0 text-[13px] text-[color:var(--color-text-muted)] italic">
            Nothing to say here.
          </p>
        )}
      </div>
    </div>
  );
}

function Swot({
  raw,
  citedByClaimId,
}: {
  raw: unknown;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  const swot = normalizeSwot(raw);
  return (
    <div>
      <SectionHeading>SWOT</SectionHeading>
      <div className="grid grid-cols-2 gap-x-[22px] gap-y-3.5 text-[14px]">
        <SwotQuadrant label="Strengths" section={swot.strengths} citedByClaimId={citedByClaimId} />
        <SwotQuadrant label="Weaknesses" section={swot.weaknesses} citedByClaimId={citedByClaimId} />
        <SwotQuadrant
          label="Opportunities"
          section={swot.opportunities}
          citedByClaimId={citedByClaimId}
        />
        <SwotQuadrant label="Threats" section={swot.threats} citedByClaimId={citedByClaimId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown export — client-only, no backend call. Ignores inline citation ids
// (a plain-text export has nowhere to put a clickable badge) but keeps the
// prose, the recommendation and the where-to-dig block, which is what a reader
// pastes into an email before a founder call.
// ---------------------------------------------------------------------------

function memoToMarkdown(memo: MemoRow, companyName: string, thesisName: string | null): string {
  const lines: string[] = [];
  lines.push(`# Investment memo — ${companyName}`);
  lines.push(`v${memo.version} · ${formatDate(memo.created_at)}${thesisName ? ` · ${thesisName}` : ""}`);
  lines.push("");
  if (memo.recommendation) {
    lines.push(`**Recommendation: ${RECOMMENDATION_LABEL[memo.recommendation]}**`);
    lines.push("");
  }

  const push = (heading: string, raw: unknown) => {
    const section = normalizeSection(raw);
    if (!sectionHasContent(section)) return;
    lines.push(`## ${heading}`, sectionToPlainText(section), "");
  };

  push("Company snapshot", memo.sections.snapshot);
  push("Investment hypotheses", memo.sections.hypotheses);

  const swot = normalizeSwot(memo.sections.swot);
  lines.push("## SWOT");
  lines.push(`**Strengths.** ${sectionToPlainText(swot.strengths) || "Nothing to say here."}`);
  lines.push(`**Weaknesses.** ${sectionToPlainText(swot.weaknesses) || "Nothing to say here."}`);
  lines.push(`**Opportunities.** ${sectionToPlainText(swot.opportunities) || "Nothing to say here."}`);
  lines.push(`**Threats.** ${sectionToPlainText(swot.threats) || "Nothing to say here."}`, "");

  push("Problem & product", memo.sections.problem_product);
  push("Traction & KPIs", memo.sections.traction);
  for (const [key, heading] of Object.entries(OPTIONAL_SECTION_HEADINGS)) {
    if (key in memo.sections) push(heading, memo.sections[key]);
  }

  const conditions = normalizeConditions(memo.conditions);
  if (conditions.length > 0) {
    lines.push("## Conditions");
    conditions.forEach((c) => lines.push(`- ${c}`));
    lines.push("");
  }

  const questions = normalizeDeepDiveQuestions(memo.deep_dive_questions);
  if (questions.length > 0) {
    lines.push("## Where to dig");
    questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q.question}`);
      if (q.closesGap) lines.push(`   closes: ${q.closesGap}`);
    });
  }

  return lines.join("\n");
}

function exportMarkdown(memo: MemoRow, companyName: string, thesisName: string | null) {
  const md = memoToMarkdown(memo, companyName, thesisName);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `memo-${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-v${memo.version}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function Memo() {
  const { applicationId } = Route.useParams();

  const appQ = useQuery({
    queryKey: ["investor", "application", applicationId],
    queryFn: () =>
      getApplications({ filters: { application_id: `eq.${applicationId}` }, limit: 1 }),
  });
  const founderQ = useQuery({
    queryKey: ["investor", "founder-by-application", applicationId],
    queryFn: () => getFounders({ filters: { application_id: `eq.${applicationId}` }, limit: 1 }),
  });
  const memoQ = useQuery({
    queryKey: ["investor", "memo", applicationId],
    queryFn: () => getCurrentMemo(applicationId),
  });

  const memo = memoQ.data?.ok ? memoQ.data.data : null;
  const citedIds = useMemo(() => memo?.cited_claim_ids ?? [], [memo]);

  const citedQ = useQuery({
    queryKey: ["investor", "memo-citations", applicationId, memo?.id],
    queryFn: () => fetchCitedClaims(citedIds),
    enabled: citedIds.length > 0,
  });
  const citedByClaimId = useMemo(() => {
    const map = new Map<string, ClaimWithTrust>();
    if (citedQ.data?.ok) for (const c of citedQ.data.data) map.set(c.claim_id, c);
    return map;
  }, [citedQ.data]);

  const loading = appQ.isLoading || memoQ.isLoading;
  // `isError` covers a hard transport failure (queryFn itself threw, which none of
  // this file's calls ever do — belt and suspenders); `!result.ok` covers the normal
  // failure path, where `getApplications`/`getCurrentMemo` resolve to a typed error
  // instead of throwing (investor-api.ts's `Result<T>` contract).
  const failureMessage = appQ.isError
    ? "Something went wrong on our side. Try again."
    : memoQ.isError
      ? "Something went wrong on our side. Try again."
      : appQ.data && !appQ.data.ok
        ? appQ.data.error.message
        : memoQ.data && !memoQ.data.ok
          ? memoQ.data.error.message
          : null;

  if (loading) {
    return (
      <div className="px-9 py-7">
        <p className="text-[13px] text-[color:var(--color-text-muted)]">Loading memo…</p>
      </div>
    );
  }

  if (failureMessage) {
    return (
      <div className="px-9 py-7">
        <div className="border border-[color:var(--color-border)] p-5">
          <p className="text-[14px]">{failureMessage}</p>
          <button
            type="button"
            onClick={() => {
              appQ.refetch();
              memoQ.refetch();
            }}
            className="mt-3 border border-[color:var(--color-text)] px-3 py-1.5 text-[13px] font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const application = appQ.data?.ok ? appQ.data.data[0] : undefined;
  if (!application) {
    return (
      <div className="px-9 py-7">
        <p className="text-[15px] font-medium">This application couldn't be found.</p>
        <Link
          to="/app/feed"
          className="mt-2 inline-block text-[13px] underline decoration-[color:var(--color-border)] underline-offset-[3px]"
        >
          ← Back to feed
        </Link>
      </div>
    );
  }

  const founder = founderQ.data?.ok ? founderQ.data.data[0] : undefined;
  const isSynthetic = application.is_synthetic || founder?.is_synthetic === true;
  const companyName = application.company_name ?? "This company";

  // §6 of data-contracts.md: `thesis_coverage` is NULL in keyword mode and in
  // full mode alike whenever nothing was assessed — but keyword mode is the
  // only case where `thesis_fit` can be non-null while `thesis_coverage` stays
  // null (full mode always populates coverage alongside a non-null fit). No
  // `evaluation_mode` column exists on `api_applications` to read directly.
  const keywordModeOnly = application.thesis_fit != null && application.thesis_coverage == null;
  const insufficientReason =
    application.thesis_fit == null
      ? application.thesis_missing_fields.length > 0
        ? `Not assessable against this thesis — missing ${application.thesis_missing_fields.join(", ")}.`
        : "Not assessable against this thesis."
      : null;

  return (
    <div className="px-9 py-7 pb-20">
      <div className="mx-auto max-w-[760px]">
        <div className="flex items-center gap-3.5 text-[13px]">
          <Link
            to="/app/f/$applicationId"
            params={{ applicationId }}
            className="text-[color:var(--color-text-muted)]"
          >
            ← Founder card
          </Link>
          <span className="flex-1" />
          {memo ? (
            <>
              <span className="flex items-center gap-1 rounded-full border border-[color:var(--color-border)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--color-text-muted)]">
                prose <ProvenanceChip kind="model" />
              </span>
              <span className="flex items-center gap-1 bg-[color:var(--color-surface)] px-2 py-0.5 font-mono text-[10px]">
                recommendation <ProvenanceChip kind="rule" />
              </span>
              <button
                type="button"
                onClick={() => exportMarkdown(memo, companyName, application.thesis_name)}
                className="border border-[color:var(--color-text)] px-2.5 py-1 text-[12.5px] font-medium"
              >
                Export markdown
              </button>
            </>
          ) : null}
        </div>

        <h1 className="mt-3.5 mb-0 text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">
          Investment memo — {companyName}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-[color:var(--color-text-muted)]">
          {founder?.full_name ? <span>{founder.full_name}</span> : null}
          {memo ? (
            <span>
              v{memo.version} · {formatDate(memo.created_at)}
              {application.thesis_name ? ` · ${application.thesis_name}` : ""}
            </span>
          ) : null}
          {isSynthetic ? <SyntheticBadge /> : null}
        </div>
        <div className="ms-rule mt-4" />

        {memo ? (
          <>
            <div className="mt-0 bg-[color:var(--color-surface)] p-[18px_22px]">
              <div className="flex flex-wrap items-baseline gap-3.5">
                <span className="text-[22px] font-bold">
                  {memo.recommendation ? RECOMMENDATION_LABEL[memo.recommendation].toUpperCase() : "NOT YET DECIDED"}
                </span>
                <span className="text-[12.5px] text-[color:var(--color-text-muted)]">
                  deterministic rule over the thesis — not a model's call
                </span>
              </div>
              {application.thesis_id ? (
                <div className="mt-2.5 border-t border-[color:var(--color-border)] pt-2.5">
                  <ThesisFitLedger
                    fit={application.thesis_fit}
                    coverage={application.thesis_coverage}
                    rules={application.thesis_fired_rules}
                    insufficientReason={insufficientReason}
                    keywordModeOnly={keywordModeOnly}
                  />
                </div>
              ) : (
                <p className="mt-2.5 text-[13px] text-[color:var(--color-text-muted)]">
                  No thesis was active when this application was evaluated.
                </p>
              )}
              {memo.recommendation === "proceed-with-conditions" ? (
                (() => {
                  const conditions = normalizeConditions(memo.conditions);
                  return conditions.length > 0 ? (
                    <div className="mt-2.5 border-t border-[color:var(--color-border)] pt-2.5 text-[13px]">
                      <span className="font-medium">Conditions: </span>
                      {conditions.join(" · ")}
                    </div>
                  ) : null;
                })()
              ) : null}
            </div>

            {SECTIONS_BEFORE_SWOT.map(({ key, heading }) => (
              <div key={key}>
                <SectionHeading>{heading}</SectionHeading>
                <ProseBlockText section={normalizeSection(memo.sections[key])} citedByClaimId={citedByClaimId} />
              </div>
            ))}

            <Swot raw={memo.sections.swot} citedByClaimId={citedByClaimId} />

            {SECTIONS_AFTER_SWOT.map(({ key, heading }) => (
              <div key={key}>
                <SectionHeading>{heading}</SectionHeading>
                <ProseBlockText section={normalizeSection(memo.sections[key])} citedByClaimId={citedByClaimId} />
              </div>
            ))}

            {Object.entries(OPTIONAL_SECTION_HEADINGS).map(([key, heading]) => {
              if (!(key in memo.sections)) return null;
              const section = normalizeSection(memo.sections[key]);
              if (!sectionHasContent(section)) return null;
              return (
                <div key={key}>
                  <SectionHeading>{heading}</SectionHeading>
                  <ProseBlockText section={section} citedByClaimId={citedByClaimId} />
                </div>
              );
            })}

            {(() => {
              const questions = normalizeDeepDiveQuestions(memo.deep_dive_questions);
              return (
                <div>
                  <h2 className="mt-[26px] mb-0 text-[20px] font-medium">Where to dig</h2>
                  <div className="ms-rule mt-1.5" />
                  {questions.length === 0 ? (
                    <p className="mt-3 text-[13px] text-[color:var(--color-text-muted)] italic">
                      No follow-up questions were generated for this memo.
                    </p>
                  ) : (
                    questions.map((q, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[34px_1fr] gap-3 border-b border-[color:var(--color-border)] py-3"
                      >
                        <span className="font-mono text-[13px] text-[color:var(--color-text-muted)]">
                          {i + 1}
                        </span>
                        <div>
                          <div className="text-[15px] leading-[1.45] font-medium">{q.question}</div>
                          {q.closesGap ? (
                            <div className="mt-0.5 text-[12.5px] text-[color:var(--color-text-muted)]">
                              closes: {q.closesGap}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              );
            })()}
          </>
        ) : (
          <div className="mt-10 border border-[color:var(--color-border)] p-8 text-center">
            <p className="text-[15px] font-medium">No memo generated yet</p>
            <p className="mx-auto mt-2 max-w-[440px] text-[13px] text-[color:var(--color-text-muted)]">
              Memo generation reads this application's evidence, trust and thesis fit and writes a
              new versioned memo row. That workflow hasn't shipped yet — this is the honest state,
              not a loading spinner.
            </p>
            <button
              type="button"
              disabled
              title="Not wired yet — feature 06's memo-writer workflow has not shipped."
              className="mt-5 cursor-not-allowed border border-[color:var(--color-border)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-text-muted)] disabled:opacity-70"
            >
              Generate memo
            </button>
            <p className="mt-2 text-[11px] text-[color:var(--color-text-muted)]">
              Not available in this build — integration point for feature 06.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
