// The company/founder card — feature 09, screen 2. lovable-brief.md §9.
//
// The deepest screen in the product: this is where "we know what we don't know"
// either lands or doesn't. Every number here is either a foundation-layer component
// (imported, never forked) or derived directly from a live PostgREST read — nothing
// on this screen is mock data or a placeholder row.
//
// Data-surface gaps found while wiring this against the live schema (see the report
// back to the team lead for the full list): there is no dedicated market-detail view
// (TAM bands, venture-scale gates, competitor threat/switching-cost columns) or
// per-criterion source URL for the founder-score ledger — both are rebuilt here from
// the generic `api_claims` / `score_components` rows rather than invented.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import {
  getApplications,
  getFounders,
  getEvidenceLedger,
  getContradictionEvents,
  getInsufficientEvidenceEvents,
  getScoreComponents,
  suggestFollowUp,
  purgeFounderData,
  type ApplicationRow,
  type FounderRow,
  type ClaimWithTrust,
  type ClaimEvidence,
  type EventRow,
  type ClaimContradictedPayload,
  type ScoreComponentRow,
  type Result,
  type ApiError,
  type CriterionVerdict,
  type SuggestFollowUpResponse,
  type PurgeFounderResponse,
} from "@/lib/investor-api";
import { AxisScoreHero } from "@/components/app/axis-score";
import {
  FounderScoreCard,
  FounderScoreChip,
  type FounderScoreGroupView,
  type FounderScoreCriterionView,
} from "@/components/app/founder-score";
import {
  VerdictBadge,
  ForecastBadge,
  JudgementBadge,
  TierBadge,
  type DerivedStatus,
  type EvidenceTier,
} from "@/components/app/claim-badges";
import { TrustPipMeter, computeTrustPips } from "@/components/app/trust-pip-meter";
import {
  NotCheckedNotice,
  SearchedNothingFoundCard,
  SearchedNothingFoundAggregate,
  NotDisclosedNote,
} from "@/components/app/not-known-states";
import { BullBearScale } from "@/components/app/bull-bear-scale";
import { SyntheticBadge } from "@/components/app/synthetic-badge";
import { NextPhasePanel } from "@/components/app/next-phase-panel";
import { ObscurityIndicator } from "@/components/app/obscurity-indicator";
import { useExplainPanel } from "@/components/app/explain-panel";

export const Route = createFileRoute("/app/f/$applicationId")({
  head: () => ({
    meta: [{ title: "Company card — The VC Brain" }, { name: "robots", content: "noindex" }],
  }),
  component: FounderCard,
});

// ---------------------------------------------------------------------------
// Query plumbing — every `investor-api.ts` call returns Result<T> and never
// throws, so react-query's own error channel is unused here; `.data` is always
// `Result<T> | undefined` and callers check `.ok` themselves (brief §12.3).
// ---------------------------------------------------------------------------

function useApiQuery<T>(key: readonly unknown[], fn: () => Promise<Result<T>>, enabled = true) {
  return useQuery({
    queryKey: key as unknown[],
    queryFn: fn,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

function ReadFailure({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="border border-[color:var(--color-border)] p-4 text-[13.5px]">
      <div>{error.message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 cursor-pointer border border-[color:var(--color-border)] px-2.5 py-1 text-[12.5px] font-medium"
      >
        Retry
      </button>
    </div>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div className="py-3 text-[12.5px] text-[color:var(--color-text-muted)]">
      <div className="h-1 w-full bg-[color:var(--color-track)]">
        <div className="h-1 w-2/3 bg-[color:var(--color-text)]" />
      </div>
      <div className="mt-1.5">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Founder-score plain-English criterion map — scoring-ux.md §1.2. The ledger
// component's own rule: never the raw id as the primary label.
// ---------------------------------------------------------------------------

const CRITERIA: Record<string, { label: string; group: string; groupWeight: number }> = {
  E1: { label: "Merged a PR into a repo they do not own (12mo)", group: "Execution signals", groupWeight: 0.4 },
  E3: { label: "Commits in ≥8 of the last 12 weeks", group: "Execution signals", groupWeight: 0.4 },
  E4: { label: "A live production URL actually responds", group: "Execution signals", groupWeight: 0.4 },
  E5: { label: "Measured external usage (forks, dependents, downloads)", group: "Execution signals", groupWeight: 0.4 },
  E7: { label: "Provenance clean — no earlier source for the flagship repo", group: "Execution signals", groupWeight: 0.4 },
  X1: { label: "Documented tenure in the same vertical", group: "Expertise signals", groupWeight: 0.3 },
  X2: { label: "Insight specificity an outsider could not guess", group: "Expertise signals", groupWeight: 0.3 },
  X5: { label: "Describes competitors at insider granularity", group: "Expertise signals", groupWeight: 0.3 },
  X6: { label: "Substantial work nobody asked for, before funding", group: "Expertise signals", groupWeight: 0.3 },
  L2: { label: "First customers, LOI, or pilot evidence", group: "Leadership & sales proxies", groupWeight: 0.3 },
  L3: { label: "ICP specificity", group: "Leadership & sales proxies", groupWeight: 0.3 },
  L5: { label: "Written communication concise under compression", group: "Leadership & sales proxies", groupWeight: 0.3 },
};
const GROUP_ORDER = ["Execution signals", "Expertise signals", "Leadership & sales proxies"];

function tierLabelFor(c: ScoreComponentRow): string {
  if (c.verdict === "cannot_assess") return "not assessed";
  if (c.evidence_tier) return c.evidence_tier;
  if (c.verdict === "self_asserted") return "self-asserted";
  if (c.verdict === "not_met") return "established absent";
  return "documented";
}

function buildFounderScoreGroups(rows: ScoreComponentRow[]): FounderScoreGroupView[] {
  const byGroup = new Map<string, FounderScoreCriterionView[]>();
  for (const r of rows) {
    const meta = CRITERIA[r.criterion_id];
    const groupName = meta?.group ?? r.subscorer;
    const criterion: FounderScoreCriterionView = {
      criterionId: r.criterion_id,
      label: meta?.label ?? r.criterion_id,
      verdict: r.verdict,
      tierLabel: tierLabelFor(r),
      contribution: r.contribution,
      demotedBy: r.demoted_by,
      quote: r.quote_verbatim,
      // No per-criterion source URL is exposed by `score_components` — only
      // `claim_ids`, which would need a second join to `api_claims` to resolve.
      // Render the verified quote without a link rather than fabricate one.
      quoteUrl: null,
      rationale: r.rationale,
      whatWouldCloseIt: r.what_would_close_it,
    };
    const list = byGroup.get(groupName) ?? [];
    list.push(criterion);
    byGroup.set(groupName, list);
  }
  const names = [...byGroup.keys()].sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );
  return names.map((name) => ({
    name,
    weight: rows.find((r) => (CRITERIA[r.criterion_id]?.group ?? r.subscorer) === name)
      ? (CRITERIA[byGroup.get(name)![0].criterionId]?.groupWeight ?? 0)
      : 0,
    criteria: byGroup.get(name)!,
  }));
}

// ---------------------------------------------------------------------------
// Claim helpers — the Evidence tab, Market/Competition tabs and "What we don't
// know" tab all read from the same `getEvidenceLedger` join.
// ---------------------------------------------------------------------------

const TIER_RANK: Record<EvidenceTier, number> = { documented: 3, discovered: 2, inferred: 1, missing: 0 };

/** Detects §4.3's third not-known state: an evidence row exists with
 * `tier='missing'` and `relation='context'` — "we looked and found nothing",
 * distinct from a claim with no evidence rows at all ("not checked yet"). */
function isSearchedNothingFound(c: ClaimWithTrust): boolean {
  return c.evidence.some((e) => e.tier === "missing" && e.relation === "context");
}

function bestEvidenceRow(c: ClaimWithTrust): ClaimEvidence | null {
  const contradicts = c.evidence.filter((e) => e.relation === "contradicts");
  if (contradicts.length > 0) return contradicts[0];
  const supports = c.evidence.filter((e) => e.relation === "supports");
  if (supports.length > 0) {
    return supports.reduce((best, e) => (TIER_RANK[e.tier] > TIER_RANK[best.tier] ? e : best));
  }
  return c.evidence[0] ?? null;
}

function trustPipsFor(c: ClaimWithTrust): number {
  const supports = c.evidence.filter((e) => e.relation === "supports");
  const bestSupportingTier = supports.length
    ? (supports.reduce((best, e) => (TIER_RANK[e.tier] > TIER_RANK[best.tier] ? e : best)).tier as EvidenceTier)
    : null;
  return computeTrustPips({
    hasSupport: supports.length > 0,
    bestSupportingTier,
    independentCount: c.trust?.n_independent ?? 0,
  });
}

/** All 666 live `source_url` values are well-formed http(s) URLs today, but this
 * renders untrusted upstream data (Tavily/GitHub crawl results) — fail soft to
 * the raw string rather than let a malformed one throw during render. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function topicGroupLabel(topic: string): string {
  const parts = topic.split(".");
  if (parts[0] === "founder" && parts[1]) {
    const sub: Record<string, string> = {
      execution: "Founder — execution",
      expertise: "Founder — expertise",
      leadership: "Founder — leadership",
    };
    return sub[parts[1]] ?? "Founder";
  }
  if (parts[0] === "company") return "Company";
  if (parts[0] === "market") return "Market";
  if (parts[0] === "competition") return "Competition";
  if (parts[0] === "round") return "Financials";
  return parts[0].replace(/_/g, " ");
}

const NOT_DISCLOSED_CLOSES: Record<string, string> = {
  "round.cap_table": "Would close if the founder shares a current cap table.",
  "round.prior_funding": "Would close if the founder discloses prior rounds raised, if any.",
};

function notDisclosedCloses(topic: string): string {
  return (
    NOT_DISCLOSED_CLOSES[topic] ??
    "Would close if this were disclosed by the founder or found in a public source."
  );
}

type EvidenceFilter = "all" | "contradicted" | "partially_supported" | "missing" | "searched_nothing";

function ClaimVerdict({ c }: { c: ClaimWithTrust }) {
  const status = c.trust?.derived_status;
  if (!c.trust) {
    return <span className="text-[12px] text-[color:var(--color-text-muted)]">not yet checked</span>;
  }
  if (c.trust.router_class === "forecast") return <ForecastBadge />;
  if (c.trust.router_class === "qualitative") return <JudgementBadge />;
  return <VerdictBadge status={status as DerivedStatus} />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function FounderCard() {
  const { applicationId } = Route.useParams();
  const { open } = useExplainPanel();
  const [tab, setTab] = useState<
    "evidence" | "market" | "competition" | "interview" | "unknown"
  >("evidence");
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>("all");
  const [contraOpen, setContraOpen] = useState(true);
  const [followUp, setFollowUp] = useState<
    | { open: false }
    | { open: true; state: "pending"; }
    | { open: true; state: "done"; result: SuggestFollowUpResponse }
    | { open: true; state: "error"; message: string }
  >({ open: false });
  const [deleteState, setDeleteState] = useState<
    | { open: false }
    | { open: true; state: "confirm" }
    | { open: true; state: "pending" }
    | { open: true; state: "done"; result: PurgeFounderResponse }
    | { open: true; state: "error"; message: string; code?: string }
  >({ open: false });

  const appQ = useApiQuery(["investor", "application", applicationId], () =>
    getApplications({ filters: { application_id: `eq.${applicationId}` }, limit: 1 }),
  );
  const app: ApplicationRow | undefined = appQ.data?.ok ? appQ.data.data[0] : undefined;

  // `api_founders` is a person-scoped view — join client-side. Filtering on
  // `company_id` rather than the view's own `application_id` column
  // deliberately: a live check found `application_id` null on a founder whose
  // company demonstrably has an application (the "most recent application"
  // resolution didn't always populate), while `company_id` resolved correctly
  // in every case checked. Some radar-only company cards resolve zero founders
  // — that is a real, honest state (no person identity linked yet), not a bug.
  const foundersQ = useApiQuery(
    ["investor", "founders", "byCompany", app?.company_id],
    () => getFounders({ filters: { company_id: `eq.${app!.company_id}` } }),
    !!app?.company_id,
  );
  const founders: FounderRow[] = foundersQ.data?.ok ? foundersQ.data.data : [];
  const founder = founders[0];

  const evidenceQ = useApiQuery(
    ["investor", "evidence-ledger", applicationId],
    () => getEvidenceLedger({ applicationId }),
    !!app,
  );
  const claims: ClaimWithTrust[] = evidenceQ.data?.ok ? evidenceQ.data.data : [];

  const contraQ = useApiQuery(
    ["investor", "contradictions", applicationId, founder?.founder_id],
    () => getContradictionEvents({ founderId: founder?.founder_id, applicationId }),
    !!app,
  );
  const contradictions: EventRow<ClaimContradictedPayload>[] = contraQ.data?.ok
    ? contraQ.data.data
    : [];

  const founderInsuffQ = useApiQuery(
    ["investor", "insufficient", "founder", founder?.founder_id],
    () => getInsufficientEvidenceEvents({ entityType: "founder", entityId: founder!.founder_id }),
    !!founder,
  );
  const founderScoreReason = founderInsuffQ.data?.ok
    ? founderInsuffQ.data.data.find((e) => e.event_type === "founder_score_insufficient_evidence")
    : undefined;

  const scoreComponentsQ = useApiQuery(
    ["investor", "score-components", founder?.founder_id],
    () => getScoreComponents({ filters: { founder_id: `eq.${founder!.founder_id}` } }),
    !!founder,
  );
  const scoreComponentRows: ScoreComponentRow[] = useMemo(() => {
    const rows = scoreComponentsQ.data?.ok ? scoreComponentsQ.data.data : [];
    if (rows.length === 0) return rows;
    // Keep only the latest run, defending against a re-scored founder
    // accumulating more than 12 rows. `run_id` is a random UUID, not a
    // timestamp — the API's default `run_id.desc` order does NOT mean "most
    // recent run" (found live on Voltaic: its founder has two runs 68s apart,
    // and the lexicographically-larger run_id belongs to the OLDER one, which
    // silently fed a stale all-`cannot_assess` run into this card while the
    // insufficient-evidence event below — sorted by `created_at` — correctly
    // showed the newer run). Select the latest run by `created_at` instead;
    // every row in one run shares the exact same insert timestamp.
    const latestCreatedAt = rows.reduce(
      (latest, r) => (r.created_at > latest ? r.created_at : latest),
      rows[0].created_at,
    );
    return rows.filter((r) => r.created_at === latestCreatedAt);
  }, [scoreComponentsQ.data]);

  // The single live coverage figure — computed once here and reused for both
  // the headline number and the below-threshold note, so the two can never
  // disagree the way they did when the note read a stale event payload
  // (task #18: Voltaic showed headline 0.00 against a note reading 0.15 from
  // an earlier run's `founder_score_insufficient_evidence` event).
  const founderCoverage =
    scoreComponentRows.length === 0
      ? 0
      : scoreComponentRows.reduce((sum, r) => sum + (r.verdict !== "cannot_assess" ? r.weight : 0), 0) /
        Math.max(
          scoreComponentRows.reduce((sum, r) => sum + r.weight, 0),
          1e-9,
        );

  if (appQ.isLoading) {
    return (
      <div className="px-9 py-7">
        <LoadingLine label="Loading card…" />
      </div>
    );
  }
  if (appQ.data && !appQ.data.ok) {
    return (
      <div className="px-9 py-7">
        <ReadFailure error={appQ.data.error} onRetry={() => appQ.refetch()} />
      </div>
    );
  }
  if (!app) {
    return (
      <div className="px-9 py-7">
        <p className="text-[14px]">This card doesn&apos;t exist, or it's been removed.</p>
        <Link to="/app/feed" className="mt-2 inline-block text-[13px] underline">
          ← Back to the feed
        </Link>
      </div>
    );
  }

  const isSynthetic = app.is_synthetic || founder?.is_synthetic === true;

  // §9.1's disagreement callout — computed from the axes actually assessed on
  // THIS application. Today's live data never has ≥2 assessed axes diverging by
  // enough to fire this (founder axis is unassessed database-wide; where market
  // and idea-vs-market are both assessed, e.g. Medows, they currently agree) —
  // built for real, exercised by none of the four fixtures.
  const axisEntries = [
    { label: "founder", axis: app.score_founder },
    { label: "market", axis: app.score_market },
    { label: "idea-vs-market fit", axis: app.score_idea_vs_market },
  ].filter((a) => a.axis.assessed && a.axis.value != null);
  let disagreement: string | null = null;
  if (axisEntries.length >= 2) {
    const max = axisEntries.reduce((a, b) => (a.axis.value! > b.axis.value! ? a : b));
    const min = axisEntries.reduce((a, b) => (a.axis.value! < b.axis.value! ? a : b));
    if (max.axis.value! - min.axis.value! >= 25) {
      disagreement = `The axes disagree: ${max.label} scores ${Math.round(max.axis.value!)}, ${min.label} scores ${Math.round(min.axis.value!)}. That gap is the thing to probe on the call.`;
    }
  }

  const founderNotAssessedReason = !app.score_founder.assessed
    ? founder
      ? founder.founder_score != null
        ? "a founder score exists for this person, but the founder axis composition has not run yet"
        : "no founder score exists yet for anyone on this application"
      : "no founder is resolved for this application yet"
    : undefined;

  return (
    <div className="px-9 pt-7 pb-16">
      {/* --- top bar ------------------------------------------------------ */}
      <div className="flex items-center gap-3.5 text-[13px]">
        <Link to="/app/feed" className="text-[color:var(--color-text-muted)]">
          ← Feed
        </Link>
        <span className="flex-1" />
        <button
          type="button"
          disabled={followUp.open}
          onClick={() => {
            setFollowUp({ open: true, state: "pending" });
            suggestFollowUp({ application_id: applicationId }).then((res) => {
              setFollowUp(
                res.ok
                  ? { open: true, state: "done", result: res.data }
                  : { open: true, state: "error", message: res.error.message },
              );
            });
          }}
          className="cursor-pointer border border-[color:var(--color-border)] px-3.5 py-2 text-[13px] font-medium disabled:cursor-default disabled:opacity-60"
        >
          Suggest follow-up questions
        </button>
        <Link
          to="/app/f/$applicationId/memo"
          params={{ applicationId }}
          className="bg-[color:var(--color-accent)] px-4.5 py-2 text-[13px] font-medium text-[color:var(--color-accent-foreground)]"
        >
          View memo
        </Link>
        {founder ? (
          <OverflowMenu onDelete={() => setDeleteState({ open: true, state: "confirm" })} />
        ) : null}
      </div>

      {/* --- hero ----------------------------------------------------------- */}
      <div className="mt-3 flex flex-wrap items-baseline gap-3.5">
        <h1>{app.company_name ?? "Unnamed company"}</h1>
        {founder ? (
          <FounderScoreChip founderName={founder.full_name} onClick={() => open(founderScoreExplain(founder, founderScoreReason))} />
        ) : null}
        {isSynthetic ? <SyntheticBadge /> : null}
        {founder ? (
          <span className="font-mono text-[10.5px] text-[color:var(--color-text-muted)]">
            {founder.channel ?? "source unknown"}
            {founder.first_seen_at ? ` · first seen ${relativeTime(founder.first_seen_at)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[color:var(--color-text-muted)]">
        <span>{app.stage === "pre_seed" ? "Pre-seed" : "Seed"}</span>
        {app.category ? <span>· {app.category}</span> : null}
        {app.company_domain ? (
          <a href={`https://${app.company_domain}`} target="_blank" rel="noreferrer" className="font-mono text-[12px]">
            · {app.company_domain}
          </a>
        ) : null}
        <span className="font-mono text-[11px]">· {app.status}</span>
        {founder?.obscurity != null ? (
          <ObscurityIndicator obscurity={founder.obscurity} basis={founder.obscurity_basis} />
        ) : null}
      </div>
      {app.kind === "radar_activated" ? (
        <div className="text-[12px] text-[color:var(--color-text-muted)]">
          Found by outbound scanning — this founder has not applied.
        </div>
      ) : null}
      <div className="ms-rule mt-4" />

      <div className="grid grid-cols-4 border-b border-[color:var(--color-border)]">
        <AxisScoreHero
          axis="Founder"
          chip="rule_on_model"
          assessed={app.score_founder.assessed}
          value={app.score_founder.value}
          confidence={app.score_founder.confidence}
          notAssessedReason={founderNotAssessedReason}
          className="border-r border-[color:var(--color-border)]"
          onClick={() => open(founderScoreExplain(founder, founderScoreReason))}
        />
        <AxisScoreHero
          axis="Market"
          chip="model"
          assessed={app.score_market.assessed}
          value={app.score_market.value}
          confidence={app.score_market.confidence}
          notAssessedReason={
            app.score_market.assessed
              ? undefined
              : app.score_market.missing.length
                ? `gaps: ${app.score_market.missing.join(", ")}`
                : "not yet researched for this application"
          }
          className="border-r border-[color:var(--color-border)]"
        />
        <AxisScoreHero
          axis="Idea-vs-Market"
          chip="model"
          assessed={app.score_idea_vs_market.assessed}
          value={app.score_idea_vs_market.value}
          confidence={app.score_idea_vs_market.confidence}
          notAssessedReason={
            app.score_idea_vs_market.assessed
              ? undefined
              : app.score_idea_vs_market.missing.length
                ? `gaps: ${app.score_idea_vs_market.missing.join(", ")}`
                : "not yet researched for this application"
          }
          className="border-r border-[color:var(--color-border)]"
        />
        <AxisScoreHero
          axis="Trust — per-claim rollup"
          chip="rule"
          assessed={false}
          value={null}
          confidence={null}
          notAssessedReason="no trust rollup has run for this card yet — the rollup writer is unshipped. Per-claim trust is in the Evidence tab below."
        />
      </div>

      {disagreement ? (
        <div className="flex items-baseline gap-3.5 bg-[color:var(--color-surface-2)] px-5 py-3.5">
          <span className="font-mono text-[11px] tracking-[0.06em]">AXES DISAGREE</span>
          <span className="text-[14.5px]">{disagreement}</span>
        </div>
      ) : null}

      {/* --- contradictions -------------------------------------------------- */}
      {contradictions.length > 0 ? (
        <div className="mt-3.5 border border-[color:var(--color-text)]">
          <button
            type="button"
            onClick={() => setContraOpen((v) => !v)}
            className="flex w-full cursor-pointer items-baseline gap-2.5 px-4 py-2.5 text-left"
          >
            <span className="font-mono text-[11px]">{contraOpen ? "▾" : "▸"}</span>
            <span className="text-[14px] font-medium">
              {contradictions.length} contradiction{contradictions.length === 1 ? "" : "s"} found —
              worth raising on the call
            </span>
            <span className="text-[12px] text-[color:var(--color-text-muted)]">
              what the deck says beside what the source says
            </span>
          </button>
          {contraOpen
            ? contradictions.map((c) => (
                <div key={c.id} className="border-t border-[color:var(--color-border)] p-4">
                  <div className="mb-2.5 text-[14px] font-medium">{c.payload.question}</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="border-l-2 border-[color:var(--color-text)] pl-3">
                      <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                        The application says
                      </div>
                      <div className="my-1 text-[13.5px]">&ldquo;{c.payload.founder_claim}&rdquo;</div>
                    </div>
                    <div className="border-l-2 border-[color:var(--color-text)] pl-3">
                      <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                        The source says
                      </div>
                      <div className="my-1 text-[13.5px]">&ldquo;{c.payload.found_reality}&rdquo;</div>
                      <a href={c.payload.source_url} target="_blank" rel="noreferrer" className="font-mono text-[11px]">
                        {c.payload.source_url}
                      </a>
                    </div>
                  </div>
                </div>
              ))
            : null}
        </div>
      ) : null}

      {/* --- founder score ledger --------------------------------------------- */}
      {founder ? (
        scoreComponentsQ.isLoading ? (
          <LoadingLine label="Loading founder-score ledger…" />
        ) : scoreComponentsQ.data && !scoreComponentsQ.data.ok ? (
          <div className="mt-3.5">
            <ReadFailure error={scoreComponentsQ.data.error} onRetry={() => scoreComponentsQ.refetch()} />
          </div>
        ) : scoreComponentRows.length > 0 ? (
          <FounderScoreCard
            className="mt-3.5"
            formulaVersion="formula_v1"
            scored={founder.score_assessed}
            value={founder.founder_score}
            assessedCount={scoreComponentRows.filter((r) => r.verdict !== "cannot_assess").length}
            totalCriteria={scoreComponentRows.length}
            coverage={founderCoverage}
            confidence={founder.founder_score_confidence}
            belowThresholdNote={
              // Same `founderCoverage` value as the headline number above —
              // never the insufficient-evidence event's stored payload, which
              // is only as fresh as whichever run last wrote it and can lag a
              // later re-score (task #18).
              !founder.score_assessed && founderCoverage < 0.25
                ? `below the 0.25 threshold — coverage ${founderCoverage.toFixed(2)}`
                : undefined
            }
            trend={
              founder.founder_score_trend
                ? { direction: founder.founder_score_trend, delta: "since the previous run" }
                : null
            }
            gapsCount={scoreComponentRows.filter((r) => r.verdict === "cannot_assess").length}
            groups={buildFounderScoreGroups(scoreComponentRows)}
            // `pedigree` intentionally left unwired — like the TAM/competitor-
            // table cuts elsewhere in this file, this is a scope cut, not an
            // oversight: `api_founders` exposes no pedigree column, so there
            // is no live data source to feed the "Pedigree (not scored)" block.
          />
        ) : null
      ) : null}

      {/* --- tabs -------------------------------------------------------- */}
      <div className="mt-6 flex gap-0.5 border-b border-[color:var(--color-border)]">
        {(
          [
            ["evidence", "Evidence"],
            ["market", "Market"],
            ["competition", "Competition"],
            ["interview", "Interview"],
            ["unknown", "What we don't know"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "cursor-pointer px-3.5 py-2 text-[13px]",
              tab === id
                ? "border-b-2 border-[color:var(--color-text)] font-medium"
                : "text-[color:var(--color-text-muted)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {evidenceQ.isLoading ? (
        <LoadingLine label="Loading evidence…" />
      ) : evidenceQ.data && !evidenceQ.data.ok ? (
        <div className="pt-4">
          <ReadFailure error={evidenceQ.data.error} onRetry={() => evidenceQ.refetch()} />
        </div>
      ) : (
        <>
          {tab === "evidence" ? (
            <EvidenceTab
              claims={claims}
              filter={evidenceFilter}
              setFilter={setEvidenceFilter}
              onExplain={(c) => open(claimExplain(c))}
            />
          ) : null}
          {tab === "market" ? <MarketTab app={app} claims={claims} onExplain={(c) => open(claimExplain(c))} /> : null}
          {tab === "competition" ? <CompetitionTab claims={claims} onExplain={(c) => open(claimExplain(c))} /> : null}
          {tab === "interview" ? <InterviewTab claims={claims} /> : null}
          {tab === "unknown" ? <UnknownTab claims={claims} onExplain={(c) => open(claimExplain(c))} /> : null}
        </>
      )}

      <FollowUpModal state={followUp} onClose={() => setFollowUp({ open: false })} />
      {founder ? (
        <DeleteDialog
          founder={founder}
          state={deleteState}
          onClose={() => setDeleteState({ open: false })}
          onConfirm={() => {
            setDeleteState({ open: true, state: "pending" });
            purgeFounderData({ founder_id: founder.founder_id }).then((res) => {
              setDeleteState(
                res.ok
                  ? { open: true, state: "done", result: res.data }
                  : { open: true, state: "error", message: res.error.message, code: res.error.code },
              );
            });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

function OverflowMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        className="cursor-pointer border border-[color:var(--color-border)] px-2.5 py-2 text-[13px]"
      >
        ⋯
      </button>
      {open ? (
        <div className="absolute top-full right-0 z-10 mt-1 w-56 border border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="w-full cursor-pointer px-3.5 py-2.5 text-left text-[13px]"
          >
            Delete this person&apos;s data
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explain-panel data builders
// ---------------------------------------------------------------------------

function founderScoreExplain(
  founder: FounderRow | undefined,
  reasonEvent: EventRow | undefined,
) {
  if (!founder) {
    return {
      title: "Founder score",
      what: "No founder is resolved for this application yet, so there is no person to score.",
      chip: null,
    };
  }
  return {
    title: `Founder score — ${founder.full_name}`,
    what: "A weighted-credit ledger over 12 binary criteria, computed by a published formula from claims the model judged. It persists across every company this person is associated with and never resets.",
    chip: "rule_on_model" as const,
    unknowns: !founder.score_assessed
      ? [
          {
            gap: "Not enough evidence to score",
            closes:
              (reasonEvent?.payload as { missing?: unknown[] } | undefined)?.missing != null
                ? `${(reasonEvent!.payload as { missing: unknown[] }).missing.length} criteria remain unassessed — see the ledger below.`
                : "We looked. We are not guessing.",
          },
        ]
      : [],
  };
}

function claimExplain(c: ClaimWithTrust) {
  const best = bestEvidenceRow(c);
  return {
    title: c.topic,
    what: c.text_verbatim,
    chip: c.trust?.router_class === "qualitative" || c.trust?.router_class === "forecast" ? ("model" as const) : ("rule_on_model" as const),
    formula:
      c.trust != null
        ? [
            { op: "", label: "base", value: c.trust.base != null ? c.trust.base.toFixed(2) : "—", note: "strongest supporting evidence" },
            { op: "×", label: "independence", value: c.trust.independence_factor.toFixed(2), note: `${c.trust.n_independent} independent source(s)` },
            { op: "−", label: "contradictions", value: c.trust.contradiction_penalty.toFixed(2), note: `${c.trust.n_contradicts_counting} counting` },
            { op: "=", label: "trust", value: c.trust.trust.toFixed(2), note: "0–1, never a percentage" },
          ]
        : [],
    evidence: c.evidence.map((e) => ({
      claim: c.text_verbatim,
      quote: e.quote_verbatim,
      sourceUrl: e.source_url ?? undefined,
      tier: e.tier,
      verdict: e.relation,
      date: e.captured_at ? relativeTime(e.captured_at) : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Evidence tab
// ---------------------------------------------------------------------------

const EVIDENCE_FILTERS: Array<[EvidenceFilter, string]> = [
  ["all", "All"],
  ["contradicted", "Refuted"],
  ["partially_supported", "Conflicting"],
  ["missing", "Not disclosed"],
  ["searched_nothing", "Searched — nothing found"],
];

function EvidenceTab({
  claims,
  filter,
  setFilter,
  onExplain,
}: {
  claims: ClaimWithTrust[];
  filter: EvidenceFilter;
  setFilter: (f: EvidenceFilter) => void;
  onExplain: (c: ClaimWithTrust) => void;
}) {
  const judgementCount = claims.filter(
    (c) => c.trust?.router_class === "qualitative" || c.trust?.router_class === "forecast",
  ).length;
  const judgementPct = claims.length ? Math.round((judgementCount / claims.length) * 100) : 0;

  const filtered = claims.filter((c) => {
    if (filter === "all") return true;
    if (filter === "searched_nothing") return isSearchedNothingFound(c);
    return c.trust?.derived_status === filter;
  });

  const byTopic = new Map<string, ClaimWithTrust[]>();
  for (const c of filtered) {
    const key = topicGroupLabel(c.topic);
    const list = byTopic.get(key) ?? [];
    list.push(c);
    byTopic.set(key, list);
  }

  if (claims.length === 0) {
    return (
      <div className="pt-8 text-[13.5px] text-[color:var(--color-text-muted)]">
        Nothing collected yet. Collection runs on a schedule.
      </div>
    );
  }

  return (
    <div className="pt-4">
      {judgementCount > 0 ? (
        <div className="ms-rule mb-4 bg-[color:var(--color-surface)] px-4 py-3.5 text-[13.5px]">
          {judgementPct}% of the claims on this card are judgements — how the founder writes, what
          they know, how they lead. We show the evidence behind them and where it came from, but we
          do not issue verdicts on judgement. That is a deliberate limit, not a gap.
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {EVIDENCE_FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={cn(
              "cursor-pointer border px-2.5 py-1 text-[12px]",
              filter === id
                ? "border-[color:var(--color-text)] font-medium"
                : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-[13px] text-[color:var(--color-text-muted)]">
          No claims match this filter.
        </p>
      ) : (
        [...byTopic.entries()].map(([topic, rows]) => (
          <div key={topic}>
            <div className="pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
              {topic}
            </div>
            {rows.map((c) => {
              const ev = bestEvidenceRow(c);
              return (
                <div
                  key={c.claim_id}
                  onClick={() => onExplain(c)}
                  className="grid cursor-pointer grid-cols-[1fr_120px_100px_150px_90px_80px] items-baseline gap-2.5 border-t border-[color:var(--color-border)] py-2"
                >
                  <span className="text-[13.5px]">{c.text_verbatim}</span>
                  {ev?.source_url ? (
                    <a
                      href={ev.source_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="truncate font-mono text-[11px]"
                    >
                      {hostnameOf(ev.source_url)}
                    </a>
                  ) : (
                    <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">no source</span>
                  )}
                  <span className="text-[11.5px] text-[color:var(--color-text-muted)] capitalize">
                    {ev?.tier ?? "—"}
                  </span>
                  <span>
                    <ClaimVerdict c={c} />
                  </span>
                  <TrustPipMeter pips={trustPipsFor(c)} title={`${c.trust?.n_independent ?? 0} independent source(s)`} />
                  <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
                    {ev?.captured_at ? relativeTime(ev.captured_at) : relativeTime(c.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}
      <p className="mt-3 text-[12px] text-[color:var(--color-text-muted)]">
        Trust per claim is a four-pip meter: has support · documented tier · one independent source
        · two or more. The raw number lives only in the explain panel, next to the arithmetic.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market tab
// ---------------------------------------------------------------------------

function MarketTab({
  app,
  claims,
  onExplain,
}: {
  app: ApplicationRow;
  claims: ClaimWithTrust[];
  onExplain: (c: ClaimWithTrust) => void;
}) {
  const marketClaims = claims.filter((c) => c.topic.startsWith("market."));
  const category = marketClaims.find((c) => c.topic === "market.category");
  const outlook = marketClaims.find((c) => c.topic === "market.outlook");
  const rest = marketClaims.filter((c) => c !== category && c !== outlook);

  return (
    <div className="max-w-[820px] pt-4.5">
      {category ? (
        <span
          className="border border-[color:var(--color-border)] px-2.5 py-1 text-[13px]"
          title="The category is set before any search runs — every downstream query is framed by it."
        >
          {category.text_verbatim}{" "}
          <span className="border-b border-dotted border-[color:var(--color-text-muted)] text-[11.5px] text-[color:var(--color-text-muted)]">
            inferred from application, not researched
          </span>
        </span>
      ) : null}

      <div className="mt-5">
        <BullBearScale
          determined={app.score_market.assessed}
          value={app.score_market.value}
          confidence={app.score_market.confidence}
        />
        {outlook ? (
          <p className="mt-2 text-[12px] text-[color:var(--color-text-muted)]">{outlook.text_verbatim}</p>
        ) : null}
      </div>

      {rest.length === 0 ? (
        <p className="mt-6 text-[13.5px] text-[color:var(--color-text-muted)]">
          No market claims collected for this card yet.
        </p>
      ) : (
        <div className="mt-6">
          <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
            What we found
          </div>
          {rest.map((c) => (
            <div
              key={c.claim_id}
              onClick={() => onExplain(c)}
              className="cursor-pointer border-t border-[color:var(--color-border)] py-2.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13.5px]">{c.text_verbatim}</span>
                <ClaimVerdict c={c} />
              </div>
              {c.evidence[0]?.source_url ? (
                <a
                  href={c.evidence[0].source_url}
                  onClick={(e) => e.stopPropagation()}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px]"
                >
                  {c.evidence[0].source_url}
                </a>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-[12px] text-[color:var(--color-text-muted)]">
        A structured TAM-vs-reachability gate pair and a venture-scale pass/fail table are described
        in the design spec but not exposed by any read this screen has access to today — shown here
        as the underlying claims instead of an invented widget.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Competition tab
// ---------------------------------------------------------------------------

function CompetitionTab({
  claims,
  onExplain,
}: {
  claims: ClaimWithTrust[];
  onExplain: (c: ClaimWithTrust) => void;
}) {
  const competitors = claims.filter((c) => c.topic === "competition.competitor");
  const other = claims.filter((c) => c.topic.startsWith("competition.") && c.topic !== "competition.competitor");

  if (competitors.length === 0 && other.length === 0) {
    return (
      <p className="pt-8 text-[13.5px] text-[color:var(--color-text-muted)]">
        No competitors found — or none have been searched yet. An empty table here does not mean no
        competition; check the Evidence tab&apos;s "Searched — nothing found" filter for whether a
        search actually ran.
      </p>
    );
  }

  return (
    <div className="pt-4.5">
      {competitors.map((c) => {
        const ev = bestEvidenceRow(c);
        return (
          <div
            key={c.claim_id}
            onClick={() => onExplain(c)}
            className="cursor-pointer border-t border-[color:var(--color-border)] py-2.5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px]">{c.text_verbatim}</span>
              <TierBadge tier={(ev?.tier ?? "missing") as EvidenceTier} />
            </div>
            {ev?.source_url ? (
              <a
                href={ev.source_url}
                onClick={(e) => e.stopPropagation()}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px]"
              >
                {ev.source_url}
              </a>
            ) : null}
          </div>
        );
      })}
      {other.length > 0 ? (
        <div className="mt-4">
          <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
            Status quo alternative
          </div>
          {other.map((c) => (
            <div key={c.claim_id} className="border-t border-[color:var(--color-border)] py-2 text-[13.5px]">
              {c.text_verbatim}
            </div>
          ))}
        </div>
      ) : null}
      <p className="mt-4 text-[12px] text-[color:var(--color-text-muted)]">
        Whether the founder named each competitor, and structured threat / switching-cost ratings,
        are not exposed by the current data surface (no dedicated competitor table is read here) —
        shown as the underlying evidence rows instead.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interview tab
// ---------------------------------------------------------------------------

function InterviewTab({ claims }: { claims: ClaimWithTrust[] }) {
  const answers = claims.filter((c) => c.source_kind === "interview" || c.source_kind === "voice");
  return (
    <div className="max-w-[760px] pt-4.5">
      {answers.length === 0 ? (
        <p className="text-[13.5px] text-[color:var(--color-text-muted)]">
          No interview answers collected yet. The founder&apos;s follow-up answers appear here once
          submitted.
        </p>
      ) : (
        answers.map((c, i) => (
          <div key={c.claim_id} className="border-t-2 border-[color:var(--color-text)] py-3">
            <div className="font-mono text-[13px] text-[color:var(--color-text-muted)]">{i + 1}</div>
            <p className="text-[15px] leading-[1.5]">{c.text_verbatim}</p>
            <span className="mt-1 inline-block rounded-full border border-[color:var(--color-border)] px-2 py-0.5 font-mono text-[9.5px] text-[color:var(--color-text-muted)]">
              self-reported — low base confidence
            </span>
          </div>
        ))
      )}
      <NextPhasePanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// "What we don't know" tab
// ---------------------------------------------------------------------------

function UnknownTab({
  claims,
  onExplain,
}: {
  claims: ClaimWithTrust[];
  onExplain: (c: ClaimWithTrust) => void;
}) {
  const searchedNothing = claims.filter(isSearchedNothingFound);
  const notChecked = claims.filter(
    (c) => c.evidence.length === 0 && c.source_kind !== "derived" && c.trust?.derived_status === "unverified",
  );
  const notDisclosed = claims.filter((c) => c.trust?.derived_status === "missing");

  // Collapse a topic sharing an identical "nothing found" reason into one
  // aggregate line rather than N identical cards — scoring-ux.md §3.6(f).
  const byTopic = new Map<string, ClaimWithTrust[]>();
  for (const c of searchedNothing) {
    const list = byTopic.get(c.topic) ?? [];
    list.push(c);
    byTopic.set(c.topic, list);
  }

  return (
    <div className="max-w-[860px] pt-4.5">
      <div className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        Searched — nothing found
      </div>
      {searchedNothing.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-text-muted)] italic">
          No searched-and-found-nothing results recorded for this card. This state exists and is
          populated elsewhere in the corpus — it is empty here, not unbuilt.
        </p>
      ) : (
        [...byTopic.entries()].map(([topic, rows]) =>
          rows.length > 3 ? (
            <SearchedNothingFoundAggregate key={topic} count={rows.length} topic={topic} />
          ) : (
            rows.map((c) => {
              const ev = c.evidence.find((e) => e.tier === "missing" && e.relation === "context");
              return (
                <SearchedNothingFoundCard
                  key={c.claim_id}
                  className="mb-2"
                  checked={ev?.source_url ?? topic}
                  checkedAt={ev?.captured_at ? relativeTime(ev.captured_at) : "unknown"}
                  lookingFor={c.text_verbatim}
                  result="no matching evidence found"
                  onDetails={() => onExplain(c)}
                />
              );
            })
          ),
        )
      )}

      <div className="mt-6 mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        Not checked yet
      </div>
      {notChecked.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-text-muted)] italic">Nothing outstanding.</p>
      ) : (
        notChecked.map((c) => <NotCheckedNotice key={c.claim_id} what={c.text_verbatim} className="border-t border-[color:var(--color-border)] py-2" />)
      )}

      <div className="mt-6 mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        Not disclosed
      </div>
      {notDisclosed.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-text-muted)] italic">Nothing declared as a gap.</p>
      ) : (
        notDisclosed.map((c) => (
          <NotDisclosedNote key={c.claim_id} what={c.text_verbatim} closes={notDisclosedCloses(c.topic)} />
        ))
      )}
      <p className="mt-3 text-[12px] text-[color:var(--color-text-muted)]">
        Neutral, informational — never phrased as the founder&apos;s fault.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggest follow-up questions — modal, brief §9.4 / §12.5
// ---------------------------------------------------------------------------

function FollowUpModal({
  state,
  onClose,
}: {
  state:
    | { open: false }
    | { open: true; state: "pending" }
    | { open: true; state: "done"; result: SuggestFollowUpResponse }
    | { open: true; state: "error"; message: string };
  onClose: () => void;
}) {
  if (!state.open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div onClick={onClose} className="absolute inset-0 bg-[color:var(--color-text)]/[0.08]" />
      <div className="absolute top-1/2 left-1/2 max-h-[80vh] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border-2 border-[color:var(--color-text)] bg-[color:var(--color-bg)] p-6">
        <div className="flex items-baseline gap-2.5">
          <span className="flex-1 text-[17px] font-medium">Suggested follow-up questions</span>
          <button type="button" onClick={onClose} className="cursor-pointer text-[16px] text-[color:var(--color-text-muted)]">
            ×
          </button>
        </div>
        {state.state === "pending" ? <LoadingLine label="Composing questions from this card's gaps…" /> : null}
        {state.state === "error" ? (
          <p className="mt-3 text-[13.5px]">{state.message}</p>
        ) : null}
        {state.state === "done" && state.result.questions.length === 0 ? (
          <p className="mt-3 text-[13.5px] text-[color:var(--color-text-muted)]">
            {state.result.empty_reason ?? "No follow-up questions were generated for this card."}
          </p>
        ) : null}
        {state.state === "done" && state.result.questions.length > 0 ? (
          <>
            <div className="mt-3.5 divide-y divide-[color:var(--color-border)] border-y border-[color:var(--color-border)]">
              {state.result.questions.map((q, i) => (
                <div key={i} className="py-2.5">
                  <div className="text-[14px] font-medium">{q.question}</div>
                  <div className="mt-0.5 text-[12px] text-[color:var(--color-text-muted)]">{q.why}</div>
                </div>
              ))}
            </div>
            {state.result.email_preview ? (
              <div className="mt-4 bg-[color:var(--color-surface)] p-3.5 text-[13px]">
                <div className="font-medium">{state.result.email_preview.subject}</div>
                <p className="mt-1 whitespace-pre-wrap text-[color:var(--color-text-muted)]">
                  {state.result.email_preview.body}
                </p>
              </div>
            ) : null}
            <div className="mt-4 flex items-center gap-3">
              <button type="button" className="cursor-pointer bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-accent-foreground)]">
                Send
              </button>
              <span className="text-[12px] text-[color:var(--color-text-muted)]">
                Not sent — email delivery is not enabled in this build.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete-on-request (GDPR) — brief §9.7. `PurgeFounderResponse` is now the
// real, frozen `n8n/workflows/README-f11.md` receipt shape (`complete`,
// `tables`, `retained`, `audit_event`) — imported straight from
// `investor-api.ts`, no local duplicate.
// ---------------------------------------------------------------------------

function DeleteDialog({
  founder,
  state,
  onClose,
  onConfirm,
}: {
  founder: FounderRow;
  state:
    | { open: false }
    | { open: true; state: "confirm" }
    | { open: true; state: "pending" }
    | { open: true; state: "done"; result: PurgeFounderResponse }
    | { open: true; state: "error"; message: string; code?: string };
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!state.open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div onClick={state.state === "pending" ? undefined : onClose} className="absolute inset-0 bg-[color:var(--color-text)]/[0.08]" />
      <div className="absolute top-1/2 left-1/2 w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 border-2 border-[color:var(--color-text)] bg-[color:var(--color-bg)] p-6">
        <div className="text-[17px] font-medium">Delete {founder.full_name}&apos;s data</div>
        {state.state === "confirm" ? (
          <>
            <p className="mt-3 text-[13.5px]">
              This permanently erases all claims, evidence, score history and events associated with{" "}
              {founder.full_name} — including their persistent founder score. This cannot be undone.
            </p>
            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                onClick={onConfirm}
                className="cursor-pointer bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-accent-foreground)]"
              >
                Delete permanently
              </button>
              <button type="button" onClick={onClose} className="cursor-pointer border border-[color:var(--color-border)] px-4 py-2 text-[13px]">
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {state.state === "pending" ? <LoadingLine label="Erasing…" /> : null}
        {state.state === "error" ? (
          <>
            <p className="mt-3 text-[13.5px]">
              {state.code === "purge_failed"
                ? "Erasure did not run — nothing was deleted. The database rolled back the whole request rather than leave a partial erasure."
                : state.message}
            </p>
            <button type="button" onClick={onClose} className="mt-3 cursor-pointer border border-[color:var(--color-border)] px-4 py-2 text-[13px]">
              Close
            </button>
          </>
        ) : null}
        {state.state === "done" ? (
          <>
            <p className="mt-3 text-[13.5px]">
              {state.result.complete
                ? "Erased. Every row this request could reach is gone."
                : "Erasure ran, but is not complete — see below."}
            </p>
            {!state.result.complete && state.result.retained.length > 0 ? (
              <div className="mt-2.5 bg-[color:var(--color-surface)] p-3 text-[12.5px]">
                {state.result.retained.map((r) => (
                  <p key={r.table} className="mt-1 first:mt-0">
                    <span className="font-mono">{r.table}</span> — {r.count} row(s) retained: {r.reason}
                  </p>
                ))}
              </div>
            ) : null}
            <Link to="/app/feed" className="mt-3 inline-block text-[13px] underline">
              ← Back to the feed
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
