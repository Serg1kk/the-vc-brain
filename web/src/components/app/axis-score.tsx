// Founder / Market / Idea-vs-Market axis display — brief §8.2, §9.1.
//
// Two sizes for the same underlying rule, not two different rules: a feed row needs
// a 48px scan-glance; a card hero needs the full value + confidence + coverage
// object. Both obey brief §4.5 rule 3 — a score is never shown without confidence
// and coverage beside it — and both use the hatched not-assessed track (§4.3)
// instead of a zero.
//
// Trend only ever exists on the market axis in the data (founder-axis and
// idea-vs-market trend are always null); this component doesn't special-case that —
// it simply renders nothing when `trend` is absent, which the null data already
// guarantees.

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { NotAssessedTrack } from "./not-known-states";
import { ProvenanceChip, type ProvenanceKind } from "./provenance-chip";

export type AxisTrendDirection = "improving" | "stable" | "declining";

const TREND_ARROW: Record<AxisTrendDirection, string> = {
  improving: "▲",
  stable: "—",
  declining: "▼",
};

interface AxisMiniBarProps {
  /** Used only for the title/aria text — the header letter (F/M/I/T) is rendered
   * once by the caller in the column header, not per row. */
  label: string;
  assessed: boolean;
  value: number | null;
  confidence: number | null;
  /** e.g. "3 of 4". */
  coverage?: string | null;
  trend?: AxisTrendDirection | null;
  notAssessedReason?: string;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

/** The 48px-wide feed-row axis cell (brief §8.2). */
export function AxisMiniBar({
  label,
  assessed,
  value,
  confidence,
  coverage,
  trend,
  notAssessedReason,
  onClick,
  className,
}: AxisMiniBarProps) {
  const title = assessed
    ? `${label}: value ${value}${confidence != null ? ` · confidence ${confidence}` : ""}${coverage ? ` · coverage ${coverage}` : ""}`
    : `${label}: Not assessed${notAssessedReason ? ` — ${notAssessedReason}` : ""}`;

  return (
    <span
      onClick={onClick}
      title={title}
      className={cn("block pt-0.5", onClick && "cursor-pointer", className)}
    >
      {assessed && value != null ? (
        <>
          <span className="relative block h-1 bg-[color:var(--color-track)]">
            <span
              className="absolute inset-y-0 left-0 bg-[color:var(--color-text)]"
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            />
          </span>
          <span className="mt-[3px] flex justify-between font-mono text-[10px] text-[color:var(--color-text-muted)]">
            <span>{Math.round(value)}</span>
            <span aria-hidden="true">{trend ? TREND_ARROW[trend] : ""}</span>
          </span>
        </>
      ) : (
        <>
          <NotAssessedTrack reason={notAssessedReason} className="h-[3px]" />
          <span className="mt-[3px] block text-[8.5px] text-[color:var(--color-text-muted)] italic">
            not assessed
          </span>
        </>
      )}
    </span>
  );
}

interface AxisScoreHeroProps {
  /** Display label, e.g. "Founder", "Market", "Idea-vs-Market". */
  axis: string;
  chip: ProvenanceKind;
  assessed: boolean;
  value: number | null;
  confidence: number | null;
  /** e.g. "3 of 3 inputs". */
  assessedOf?: string;
  notAssessedReason?: string;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

/** The large per-axis block in the card hero (brief §9.1). Confidence below 0.2
 * renders the numeral hollow/outline rather than solid — the one mechanism that
 * survives a screenshot or a paused video frame; a tooltip survives neither
 * (scoring-ux.md §2.7(a)). A model (◇) value is always an integer — a ◇ number must
 * never carry more precision than it has. */
export function AxisScoreHero({
  axis,
  chip,
  assessed,
  value,
  confidence,
  assessedOf,
  notAssessedReason,
  onClick,
  className,
}: AxisScoreHeroProps) {
  const lowConfidence = assessed && confidence != null && confidence < 0.2;

  return (
    <div onClick={onClick} className={cn("p-4.5", onClick && "cursor-pointer", className)}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        {axis} <ProvenanceChip kind={chip} />
      </div>
      {assessed && value != null ? (
        <>
          <div
            title={lowConfidence ? "Confidence below 0.2 — the numeral renders hollow" : undefined}
            className={cn(
              "mt-1 font-mono text-[34px] leading-[1.25] font-medium",
              lowConfidence
                ? "text-transparent [-webkit-text-stroke:1.2px_var(--color-text)]"
                : "text-[color:var(--color-text)]",
            )}
          >
            {Math.round(value)}
          </div>
          <div className="font-mono text-[11px] leading-[1.5] text-[color:var(--color-text-muted)]">
            confidence {confidence ?? "—"}
            {assessedOf ? (
              <>
                <br />
                assessed {assessedOf}
              </>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <NotAssessedTrack reason={notAssessedReason} className="mt-3 h-2" />
          <div className="mt-1.5 text-[12px] text-[color:var(--color-text-muted)]">
            Not assessed{notAssessedReason ? ` — ${notAssessedReason}` : ""}
          </div>
        </>
      )}
    </div>
  );
}
