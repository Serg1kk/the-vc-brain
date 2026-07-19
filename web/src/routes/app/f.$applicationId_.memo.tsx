// The investment memo — brief §10. A document, not a dashboard: single column,
// generous leading, print-friendly. Required sections render in a fixed order;
// padding is scored against us, so a section with nothing to say says so in one
// line rather than being filled.
//
// Feature 06 has shipped. The frozen `memos` jsonb contract (design.md §4.1) is:
//   sections.<key> = { statements: [ { text, claim_ids: string[], kind } ] }
//     kind ∈ "fact" | "not_disclosed" | "benchmark" | "structural"
//   sections.swot = { strengths, weaknesses, opportunities, threats }  (each a statements[])
//   sections.risk_matrix    = { risks: [ { text, severity, likelihood, claim_ids } ] }
//   sections.competition    = { statements: [...], competitors: [ { name, named_by_founder, claim_ids } ] }
//   sections.financials_lite = { statements: [...] }   (benchmark + not_disclosed only)
//   conditions = { check_size_usd, rationale, items: [ { text, closes, claim_ids } ], decision_inputs, ... }
//   deep_dive_questions = [ { question, closes_gap, gap_kind, claim_ids } ]
// The normalizers below read exactly this, and stay tolerant of the older
// string / {text, claim_id} shapes so nothing regresses. `investor-api.ts` still
// types these values as `unknown` on purpose — the reading lives here.

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
// Statement normalizer — the atomic renderable unit (design §4.1). Every prose
// section is normalized to a ProseBlock[]. Handles the frozen shape
// `{ statements: [ { text, claim_ids, kind } ] }`, plus the legacy string /
// array-of-{text, claim_id} shapes, without ever dumping raw JSON to screen.
// ---------------------------------------------------------------------------

type StatementKind = "fact" | "not_disclosed" | "benchmark" | "structural";

interface ProseBlock {
  text: string;
  claimIds: string[];
  kind: StatementKind;
}
type ProseSection = ProseBlock[];

function normalizeSection(raw: unknown): ProseSection {
  if (typeof raw === "string") {
    return raw.trim() ? [{ text: raw, claimIds: [], kind: "structural" }] : [];
  }
  // Unwrap the `{ statements: [...] }` envelope (the frozen shape).
  let arr: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "statements" in raw) {
    arr = (raw as { statements: unknown }).statements;
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item): ProseBlock | null => {
      if (typeof item === "string") return { text: item, claimIds: [], kind: "structural" };
      if (item && typeof item === "object" && "text" in item) {
        const it = item as { text: unknown; claim_ids?: unknown; claim_id?: unknown; kind?: unknown };
        const claimIds = Array.isArray(it.claim_ids)
          ? it.claim_ids.filter((x): x is string => typeof x === "string")
          : typeof it.claim_id === "string"
            ? [it.claim_id]
            : [];
        const kind: StatementKind =
          it.kind === "not_disclosed" || it.kind === "benchmark" || it.kind === "structural"
            ? it.kind
            : "fact";
        return {
          text: typeof it.text === "string" ? it.text : String(it.text ?? ""),
          claimIds,
          kind,
        };
      }
      return null;
    })
    .filter((b): b is ProseBlock => b !== null && b.text.trim().length > 0);
}

function sectionHasContent(section: ProseSection): boolean {
  return section.some((b) => b.text.trim().length > 0);
}

function sectionToPlainText(section: ProseSection): string {
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

interface RiskRow {
  text: string;
  severity: string;
  likelihood: string;
  claimIds: string[];
}

function normalizeRiskMatrix(raw: unknown): RiskRow[] {
  const risks =
    raw && typeof raw === "object" && Array.isArray((raw as { risks?: unknown }).risks)
      ? ((raw as { risks: unknown[] }).risks)
      : [];
  return risks
    .map((r): RiskRow | null => {
      if (!r || typeof r !== "object") return null;
      const it = r as Record<string, unknown>;
      const text = typeof it.text === "string" ? it.text : String(it.text ?? "");
      if (!text.trim()) return null;
      return {
        text,
        severity: typeof it.severity === "string" ? it.severity : "",
        likelihood: typeof it.likelihood === "string" ? it.likelihood : "",
        claimIds: Array.isArray(it.claim_ids)
          ? it.claim_ids.filter((x): x is string => typeof x === "string")
          : [],
      };
    })
    .filter((r): r is RiskRow => r !== null);
}

interface CompetitorRow {
  name: string;
  namedByFounder: boolean;
  claimIds: string[];
}

function normalizeCompetition(raw: unknown): { statements: ProseSection; competitors: CompetitorRow[] } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const statements = normalizeSection(obj);
  const competitors = Array.isArray(obj.competitors)
    ? obj.competitors
        .map((c): CompetitorRow | null => {
          if (!c || typeof c !== "object") return null;
          const it = c as Record<string, unknown>;
          const name = typeof it.name === "string" ? it.name : String(it.name ?? "");
          if (!name.trim()) return null;
          return {
            name,
            namedByFounder: it.named_by_founder === true,
            claimIds: Array.isArray(it.claim_ids)
              ? it.claim_ids.filter((x): x is string => typeof x === "string")
              : [],
          };
        })
        .filter((c): c is CompetitorRow => c !== null)
    : [];
  return { statements, competitors };
}

interface DeepDiveQuestion {
  question: string;
  closesGap: string;
}

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

interface MemoConditions {
  rationale: string | null;
  items: Array<{ text: string; closes: string | null }>;
}

// `conditions` is the decision node's object (design §4.4): { rationale, items, ... }.
// Stays tolerant of the older array-of-strings shape.
function normalizeConditions(raw: unknown): MemoConditions {
  if (Array.isArray(raw)) {
    return {
      rationale: null,
      items: raw
        .map((x): { text: string; closes: string | null } | null =>
          typeof x === "string" ? { text: x, closes: null } : null,
        )
        .filter((x): x is { text: string; closes: string | null } => x !== null),
    };
  }
  if (!raw || typeof raw !== "object") return { rationale: null, items: [] };
  const it = raw as Record<string, unknown>;
  const rationale = typeof it.rationale === "string" ? it.rationale : null;
  const rawItems = Array.isArray(it.items) ? it.items : [];
  const items = rawItems
    .map((x): { text: string; closes: string | null } | null => {
      if (typeof x === "string") return { text: x, closes: null };
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const text = o.text ?? o.condition;
        if (typeof text === "string") return { text, closes: typeof o.closes === "string" ? o.closes : null };
      }
      return null;
    })
    .filter((x): x is { text: string; closes: string | null } => x !== null);
  return { rationale, items };
}

const RECOMMENDATION_LABEL: Record<MemoRecommendation, string> = {
  proceed: "Proceed",
  "proceed-with-conditions": "Proceed with conditions",
  pass: "Pass",
  watchlist: "Watchlist",
};

// SWOT is rendered separately (4 named quadrants) between "Investment hypotheses"
// and "Problem & product" — the required order from brief §10.
const SECTIONS_BEFORE_SWOT: Array<{ key: keyof MemoRow["sections"] & string; heading: string }> = [
  { key: "snapshot", heading: "Company snapshot" },
  { key: "hypotheses", heading: "Investment hypotheses" },
];
const SECTIONS_AFTER_SWOT: Array<{ key: keyof MemoRow["sections"] & string; heading: string }> = [
  { key: "problem_product", heading: "Problem & product" },
  { key: "traction", heading: "Traction & KPIs" },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Citation resolution — a targeted two-read join (api_claims + claim_trust) over
// exactly `cited_claim_ids`.
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

/** Inline verdict badge for one resolved claim — Family A/B per scoring-ux §3.6(b). */
function VerdictBadgeButton({ claim }: { claim: ClaimWithTrust }) {
  const { open } = useExplainPanel();
  const badge =
    claim.trust?.router_class === "forecast" ? (
      <ForecastBadge className="cursor-pointer" />
    ) : claim.trust?.router_class === "qualitative" || claim.trust?.router_class === "unverifiable" ? (
      <JudgementBadge className="cursor-pointer" />
    ) : (
      <VerdictBadge status={claim.trust?.derived_status ?? "unverified"} />
    );
  return (
    <button
      type="button"
      onClick={() => open(claimExplainData(claim))}
      className="cursor-pointer border-none bg-transparent p-0 align-baseline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
    >
      {badge}
    </button>
  );
}

/** One statement, rendered as its own paragraph. `fact` statements carry a verdict
 * badge per cited claim (and an honest "(uncited)" only for a fact whose claim did
 * not resolve). not_disclosed/benchmark/structural carry no badge — they are honest
 * absences / comparables / connective prose, never a "bug". */
function Statement({
  block,
  citedByClaimId,
}: {
  block: ProseBlock;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  const muted = block.kind === "not_disclosed";
  const isFact = block.kind === "fact";
  const resolved = block.claimIds.map((id) => ({ id, claim: citedByClaimId.get(id) ?? null }));
  return (
    <p
      className={`m-0 mt-2 text-wrap-pretty first:mt-0 ${muted ? "text-[color:var(--color-text-muted)]" : ""}`}
    >
      {block.text}{" "}
      {isFact && resolved.length === 0 ? (
        <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">(uncited)</span>
      ) : null}
      {isFact
        ? resolved.map(({ id, claim }) =>
            claim ? (
              <span key={id}>
                <VerdictBadgeButton claim={claim} />{" "}
              </span>
            ) : (
              <span key={id} className="font-mono text-[10px] text-[color:var(--color-text-muted)]">
                (uncited){" "}
              </span>
            ),
          )
        : null}
    </p>
  );
}

function ProseBlockText({
  section,
  citedByClaimId,
}: {
  section: ProseSection;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  if (section.length === 0) {
    return <p className="m-0 text-[13px] text-[color:var(--color-text-muted)] italic">Nothing to say here.</p>;
  }
  return (
    <div>
      {section.map((block, i) => (
        <Statement key={i} block={block} citedByClaimId={citedByClaimId} />
      ))}
    </div>
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
          <p className="m-0 text-[13px] text-[color:var(--color-text-muted)] italic">Nothing to say here.</p>
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
        <SwotQuadrant label="Opportunities" section={swot.opportunities} citedByClaimId={citedByClaimId} />
        <SwotQuadrant label="Threats" section={swot.threats} citedByClaimId={citedByClaimId} />
      </div>
    </div>
  );
}

function severityClass(severity: string): string {
  return severity === "material"
    ? "text-[color:var(--color-text)] border-[color:var(--color-text)]"
    : "text-[color:var(--color-text-muted)] border-[color:var(--color-border)]";
}

function RiskMatrix({
  raw,
  citedByClaimId,
}: {
  raw: unknown;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  const risks = normalizeRiskMatrix(raw);
  if (risks.length === 0) return null;
  return (
    <div>
      <SectionHeading>Risk matrix</SectionHeading>
      <div className="flex flex-col gap-2.5">
        {risks.map((r, i) => (
          <div key={i} className="border-b border-[color:var(--color-border)] pb-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${severityClass(r.severity)}`}
              >
                {r.severity || "severity ?"}
              </span>
              <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--color-text-muted)]">
                likelihood: {r.likelihood || "?"}
              </span>
              {r.claimIds.map((id) => {
                const claim = citedByClaimId.get(id);
                return claim ? <VerdictBadgeButton key={id} claim={claim} /> : null;
              })}
            </div>
            <p className="m-0 mt-1 text-[14px] text-wrap-pretty">{r.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Competition({
  raw,
  citedByClaimId,
}: {
  raw: unknown;
  citedByClaimId: Map<string, ClaimWithTrust>;
}) {
  const { statements, competitors } = normalizeCompetition(raw);
  if (!sectionHasContent(statements) && competitors.length === 0) return null;
  return (
    <div>
      <SectionHeading>Competition</SectionHeading>
      {sectionHasContent(statements) ? (
        <ProseBlockText section={statements} citedByClaimId={citedByClaimId} />
      ) : null}
      {competitors.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {competitors.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-[14px]">
              <span className="font-medium">{c.name}</span>
              {!c.namedByFounder ? (
                <span className="rounded-full border border-[color:var(--color-text)] px-2 py-0.5 font-mono text-[10px]">
                  not named by founder
                </span>
              ) : (
                <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">
                  named by founder
                </span>
              )}
              {c.claimIds.map((id) => {
                const claim = citedByClaimId.get(id);
                return claim ? <VerdictBadgeButton key={id} claim={claim} /> : null;
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown export — client-only, no backend call. Keeps section + bullet
// structure; inline citation ids are dropped (plain text has nowhere to put a
// clickable badge) but not_disclosed / benchmark statements survive as prose.
// ---------------------------------------------------------------------------

function blocksToMarkdown(section: ProseSection): string {
  return section.map((b) => b.text).join("\n\n");
}

function memoToMarkdown(memo: MemoRow, companyName: string, thesisName: string | null): string {
  const lines: string[] = [];
  lines.push(`# Investment memo — ${companyName}`);
  lines.push(`v${memo.version} · ${formatDate(memo.created_at)}${thesisName ? ` · ${thesisName}` : ""}`);
  lines.push("");
  if (memo.recommendation) {
    lines.push(`**Recommendation: ${RECOMMENDATION_LABEL[memo.recommendation]}**`);
    const cond = normalizeConditions(memo.conditions);
    if (cond.rationale) lines.push("", cond.rationale);
    lines.push("");
  }

  const push = (heading: string, raw: unknown) => {
    const section = normalizeSection(raw);
    if (!sectionHasContent(section)) return;
    lines.push(`## ${heading}`, blocksToMarkdown(section), "");
  };

  push("Company snapshot", memo.sections.snapshot);
  push("Investment hypotheses", memo.sections.hypotheses);

  const swot = normalizeSwot(memo.sections.swot);
  lines.push("## SWOT");
  const swotBlock = (label: string, section: ProseSection) => {
    lines.push(`**${label}**`);
    if (sectionHasContent(section)) section.forEach((b) => lines.push(`- ${b.text}`));
    else lines.push("- Nothing to say here.");
    lines.push("");
  };
  swotBlock("Strengths", swot.strengths);
  swotBlock("Weaknesses", swot.weaknesses);
  swotBlock("Opportunities", swot.opportunities);
  swotBlock("Threats", swot.threats);

  push("Problem & product", memo.sections.problem_product);
  push("Traction & KPIs", memo.sections.traction);

  const risks = normalizeRiskMatrix((memo.sections as Record<string, unknown>).risk_matrix);
  if (risks.length > 0) {
    lines.push("## Risk matrix");
    risks.forEach((r) => lines.push(`- **[${r.severity || "?"} · ${r.likelihood || "?"}]** ${r.text}`));
    lines.push("");
  }

  const comp = normalizeCompetition((memo.sections as Record<string, unknown>).competition);
  if (sectionHasContent(comp.statements) || comp.competitors.length > 0) {
    lines.push("## Competition");
    if (sectionHasContent(comp.statements)) lines.push(blocksToMarkdown(comp.statements), "");
    comp.competitors.forEach((c) =>
      lines.push(`- ${c.name}${c.namedByFounder ? "" : " _(not named by founder)_"}`),
    );
    lines.push("");
  }

  push("Financials", (memo.sections as Record<string, unknown>).financials_lite);

  const cond = normalizeConditions(memo.conditions);
  if (cond.items.length > 0) {
    lines.push("## Conditions");
    cond.items.forEach((c) => lines.push(`- ${c.text}${c.closes ? ` — closes: ${c.closes}` : ""}`));
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
    queryFn: () => getApplications({ filters: { application_id: `eq.${applicationId}` }, limit: 1 }),
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

  const keywordModeOnly = application.thesis_fit != null && application.thesis_coverage == null;
  const insufficientReason =
    application.thesis_fit == null
      ? application.thesis_missing_fields.length > 0
        ? `Not assessable against this thesis — missing ${application.thesis_missing_fields.join(", ")}.`
        : "Not assessable against this thesis."
      : null;

  const conditions = memo ? normalizeConditions(memo.conditions) : { rationale: null, items: [] };

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
              {conditions.rationale ? (
                <div className="mt-2.5 border-t border-[color:var(--color-border)] pt-2.5 text-[13px]">
                  <span className="font-medium">Why: </span>
                  {conditions.rationale}
                </div>
              ) : null}
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
              {conditions.items.length > 0 ? (
                <div className="mt-2.5 border-t border-[color:var(--color-border)] pt-2.5 text-[13px]">
                  <span className="font-medium">Conditions</span>
                  <ul className="mt-1 mb-0 flex list-disc flex-col gap-1 ps-5">
                    {conditions.items.map((c, i) => (
                      <li key={i}>
                        {c.text}
                        {c.closes ? (
                          <span className="text-[color:var(--color-text-muted)]"> — closes {c.closes}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
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

            {/* Optional sections — each has a dedicated renderer; an absent key renders nothing. */}
            {"risk_matrix" in memo.sections ? (
              <RiskMatrix raw={(memo.sections as Record<string, unknown>).risk_matrix} citedByClaimId={citedByClaimId} />
            ) : null}
            {"competition" in memo.sections ? (
              <Competition raw={(memo.sections as Record<string, unknown>).competition} citedByClaimId={citedByClaimId} />
            ) : null}
            {"financials_lite" in memo.sections ? (
              (() => {
                const section = normalizeSection((memo.sections as Record<string, unknown>).financials_lite);
                if (!sectionHasContent(section)) return null;
                return (
                  <div>
                    <SectionHeading>Financials</SectionHeading>
                    <ProseBlockText section={section} citedByClaimId={citedByClaimId} />
                  </div>
                );
              })()
            ) : null}

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
                        <span className="font-mono text-[13px] text-[color:var(--color-text-muted)]">{i + 1}</span>
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
              Memo generation reads this application's evidence, trust and thesis fit and writes a new
              versioned memo row via the <span className="font-mono">f06-generate-memo</span> workflow.
              Trigger it from the backend for this application, then reload.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
