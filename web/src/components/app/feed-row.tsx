// A single thesis-lane feed row — brief §8.2. Expands in place to a 3-line evidence
// preview on the chevron (triage means scanning; a navigation round-trip per
// candidate defeats it) and links out to the founder card for the full picture.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { getEvidenceLedger, type AxisScore } from "@/lib/investor-api";
import { AxisMiniBar } from "./axis-score";
import { SyntheticBadge } from "./synthetic-badge";
import { useExplainPanel, type ExplainPanelData } from "./explain-panel";
import type { ProvenanceKind } from "./provenance-chip";
import { feedRowDescription, gapCodeInfo, type FeedItem } from "./feed-lanes";

const ROW_GRID = "grid-cols-[24px_170px_1fr_92px_236px_64px_84px]";

function formatFit(app: FeedItem["application"]): { coverage: string; fit: string } {
  const verdict = app.thesis_verdict;
  const coverage =
    app.thesis_coverage != null ? `cov ${Math.round(app.thesis_coverage * 100)}%` : "—";
  if (verdict == null) return { coverage: "—", fit: "not screened" };
  if (verdict === "insufficient_evidence") return { coverage, fit: "not assessable" };
  return { coverage, fit: app.thesis_fit != null ? app.thesis_fit.toFixed(1) : "—" };
}

interface AxisDef {
  label: string;
  chip: ProvenanceKind;
  score: AxisScore;
  notAssessedReason: string;
}

/** Builds the explain-panel payload for a single axis cell click — every rendered
 * number is click-through (brief acceptance criteria), including a not-assessed one,
 * which must say plainly why rather than rendering a dead zero. */
function axisExplainData(axis: AxisDef, companyName: string): ExplainPanelData {
  if (!axis.score.assessed || axis.score.value == null) {
    return {
      title: `${axis.label} — ${companyName}`,
      what: `Not assessed — ${axis.notAssessedReason}`,
      chip: null,
    };
  }
  return {
    title: `${axis.label} — ${companyName}`,
    what: `${axis.label} scored ${axis.score.value} for this application, at confidence ${axis.score.confidence ?? "unknown"}.`,
    chip: axis.chip,
    unknowns: axis.score.missing.map((code) => {
      const info = gapCodeInfo(code);
      return { gap: info.label, closes: info.closes };
    }),
  };
}

const TRUST_NOT_ASSESSED_REASON =
  "this screen doesn't read a per-application trust rollup yet — open the company's Evidence tab for the per-claim ledger.";

interface FeedRowProps {
  item: FeedItem;
  className?: string;
}

export function FeedRow({ item, className }: FeedRowProps) {
  const [expanded, setExpanded] = useState(false);
  const { open } = useExplainPanel();
  const { application: app, founder } = item;
  const { coverage, fit } = formatFit(app);
  const description = feedRowDescription(app);

  const axes: AxisDef[] = [
    {
      label: "Founder",
      chip: "rule_on_model",
      score: app.score_founder,
      notAssessedReason: "no founder score exists yet for anyone on this application",
    },
    {
      label: "Market",
      chip: "model",
      score: app.score_market,
      notAssessedReason: "the market axis hasn't been computed for this application yet",
    },
    {
      label: "Idea-vs-Market",
      chip: "model",
      score: app.score_idea_vs_market,
      notAssessedReason: "the idea-vs-market axis hasn't been computed for this application yet",
    },
    {
      label: "Trust",
      chip: "rule",
      // No per-application trust rollup is read on this screen (see feed.tsx's
      // header note) — render as not-assessed unconditionally rather than guess.
      score: { value: null, trend: null, confidence: null, missing: [], assessed: false },
      notAssessedReason: TRUST_NOT_ASSESSED_REASON,
    },
  ];

  const freshness = founder?.first_seen_at
    ? `first seen ${relativeTime(founder.first_seen_at)}`
    : `submitted ${relativeTime(app.submitted_at)}`;

  const ledger = useQuery({
    queryKey: ["investor", "feed-preview", app.application_id],
    queryFn: () => getEvidenceLedger({ applicationId: app.application_id }),
    enabled: expanded,
    staleTime: 60_000,
  });

  return (
    <div className={cn("border-t border-[color:var(--color-border)]", className)}>
      <div
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          "grid min-h-[var(--row-h)] cursor-pointer items-center gap-x-3 px-2 py-1",
          ROW_GRID,
        )}
        style={{ backgroundColor: expanded ? "var(--color-surface)" : undefined }}
      >
        <span
          aria-hidden="true"
          className="font-mono text-[11px] text-[color:var(--color-text-muted)]"
        >
          {expanded ? "▾" : "▸"}
        </span>

        <span className="min-w-0">
          <Link
            to="/app/f/$applicationId"
            params={{ applicationId: app.application_id }}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-[14px] leading-[1.3] font-medium underline decoration-[color:var(--color-border)] underline-offset-[3px]"
          >
            {app.company_name || "Untitled company"}
          </Link>
          <span className="block truncate text-[12px] leading-[1.3] text-[color:var(--color-text-muted)]">
            {founder ? founder.full_name : "Founder not yet identified"}
          </span>
        </span>

        <span className="truncate pr-2 text-[13px] text-[color:var(--color-text-muted)]">
          {description ?? <span className="italic">No description available yet</span>}
        </span>

        <span className="font-mono text-[11.5px] leading-[1.5]">
          <span className="block text-[color:var(--color-text-muted)]">{coverage}</span>
          <span className="block">{fit}</span>
        </span>

        <span className="grid grid-cols-4 gap-2">
          {axes.map((axis) => (
            <AxisMiniBar
              key={axis.label}
              label={axis.label}
              assessed={axis.score.assessed}
              value={axis.score.value}
              confidence={axis.score.confidence}
              trend={axis.score.trend}
              notAssessedReason={axis.notAssessedReason}
              onClick={(e) => {
                e.stopPropagation();
                open(axisExplainData(axis, app.company_name || "this company"));
              }}
            />
          ))}
        </span>

        <span className="truncate font-mono text-[10px] text-[color:var(--color-text-muted)]">
          {founder?.channel ?? "—"}
        </span>

        <span className="text-[11px] text-[color:var(--color-text-muted)]">
          {freshness}
          {app.is_synthetic ? <SyntheticBadge className="ml-1.5" /> : null}
        </span>
      </div>

      {expanded ? (
        <div className="px-2 pt-0.5 pb-3.5 pl-11 text-[12.5px]">
          {ledger.data?.ok && ledger.data.data.length > 0 ? (
            ledger.data.data.slice(0, 3).map((claim) => (
              <div
                key={claim.claim_id}
                className="border-l border-[color:var(--color-border)] py-0.5 pl-3 text-[color:var(--color-text-muted)]"
              >
                <span className="font-mono text-[10.5px] text-[color:var(--color-text)]">
                  {claim.topic}
                </span>{" "}
                <span className="line-clamp-1">{claim.text_verbatim}</span>
              </div>
            ))
          ) : ledger.isLoading ? (
            <div className="text-[color:var(--color-text-muted)] italic">Loading evidence…</div>
          ) : (
            <div className="text-[color:var(--color-text-muted)] italic">
              Nothing collected yet. Collection runs on a schedule.
            </div>
          )}
          <Link
            to="/app/f/$applicationId"
            params={{ applicationId: app.application_id }}
            className="mt-1.5 inline-block font-medium underline decoration-[color:var(--color-border)] underline-offset-[3px]"
          >
            Open founder card →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export { ROW_GRID };
