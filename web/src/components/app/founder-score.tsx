// Founder Score — the evidence ledger. scoring-ux.md §1.11.
//
// This is the whole point of the score being reproducible: the sponsor requires the
// investor see HOW it was derived, not just what it is. No gauge, no dial, no
// percentage — a weighted-credit ledger with a footer an investor can audit by
// reading. It is an input to the `founder` screening axis, never the axis itself —
// never label this component "the Founder axis".

import { useState, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import type { CriterionVerdict } from "@/lib/investor-api";
import { InfoTooltip } from "./info-tooltip";

const FOUNDER_SCORE_EXPLANATION =
  "A persistent score for this person, not this application — it follows them across every company they found, and never resets.";

export type FounderScoreTrendDirection = "improving" | "stable" | "declining";

export interface FounderScoreCriterionView {
  criterionId: string;
  /** Plain English — never the raw id as the primary label. */
  label: string;
  verdict: CriterionVerdict;
  /** Human word: "documented", "self-asserted", "not assessed", etc. */
  tierLabel: string;
  /** Signed percentage points. Null renders as "—", never as 0. */
  contribution: number | null;
  /** Red-flag id, if a flag demoted this verdict. Never render as a point deduction
   * — it demotes the verdict, it does not subtract from the score. */
  demotedBy?: string | null;
  /** Substring-verified quote. A null quote beside a non-null rationale is the
   * backend rejecting the model's quote — a feature, not a blank; render both fields
   * independently, never fall back from one to the other. */
  quote?: string | null;
  quoteUrl?: string | null;
  quoteSourceLabel?: string | null;
  /** The model's interpretation — must never share styling with `quote`; that
   * distinction is what stops a paraphrase being laundered as a verified quote. */
  rationale?: string | null;
  whatWouldCloseIt?: string | null;
}

export interface FounderScoreGroupView {
  /** e.g. "Execution signals". */
  name: string;
  /** 0–1, e.g. 0.40. */
  weight: number;
  criteria: FounderScoreCriterionView[];
}

export interface FounderScorePedigree {
  text: string;
  tags: string[];
}

export interface FounderScoreCardProps {
  formulaVersion: string;
  /** false = the insufficient-evidence branch. Coverage fell below 0.25 (or nothing
   * was assessed), so no score row exists — but the ledger below still renders in
   * full; only the headline number is replaced. */
  scored: boolean;
  value: number | null;
  assessedCount: number;
  totalCriteria: number;
  coverage: number;
  confidence: number | null;
  /** e.g. "below the 0.25 threshold" — shown on the insufficient-evidence branch. */
  belowThresholdNote?: string | null;
  /** Event-spaced, never time-spaced. Null renders nothing at all — not a flat line,
   * not "stable"; "stable" is a claim about history that isn't earned without a
   * prior row. */
  trend?: { direction: FounderScoreTrendDirection; delta: string } | null;
  gapsCount?: number | null;
  /** Always present, grouped by family, even when `scored` is false. */
  groups: FounderScoreGroupView[];
  pedigree?: FounderScorePedigree | null;
  defaultExpanded?: boolean;
  className?: string;
}

const TREND_ARROW: Record<FounderScoreTrendDirection, string> = {
  improving: "▲",
  stable: "—",
  declining: "▼",
};

const VERDICT_MARK: Record<CriterionVerdict, { glyph: string; className: string; reads: string }> =
  {
    met: { glyph: "✓", className: "text-[color:var(--color-text)]", reads: "evidenced" },
    self_asserted: {
      glyph: "◐",
      className: "text-[color:var(--color-text-muted)]",
      reads: "they say so; nobody else does",
    },
    // A finding must read as MORE confident than "we haven't looked" — inverting the
    // usual convention that grey is softer than red is the point of this whole
    // feature, not an accident.
    not_met: {
      glyph: "✗",
      className: "font-semibold text-[color:var(--color-text)]",
      reads: "we checked; it isn't there",
    },
    // Achromatic and desaturated, on purpose — the moment this takes on a warning
    // colour it reads as a failing grade and the sponsor's invariant dies at the UI
    // layer.
    cannot_assess: {
      glyph: "○",
      className: "text-[color:var(--color-text-muted)] opacity-50",
      reads: "we haven't looked",
    },
  };

function formatContribution(c: number | null): string {
  if (c == null) return "—";
  const sign = c > 0 ? "+" : "";
  return `${sign}${c.toFixed(2)}`;
}

interface FounderScoreChipProps {
  founderName: string;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

/** The persistent identity chip that follows a person across companies — feed row,
 * card header, memo header. A rounded rectangle with a person glyph, distinct in
 * shape from the tile-treatment application-scoped axes use, so the same chip on two
 * different deals reads as "the score follows the person" without a tooltip. */
export function FounderScoreChip({ founderName, onClick, className }: FounderScoreChipProps) {
  return (
    <InfoTooltip content={FOUNDER_SCORE_EXPLANATION}>
      <span
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] px-2.5 py-0.5 text-[12.5px]",
          onClick && "cursor-pointer",
          className,
        )}
      >
        <span aria-hidden="true" className="font-mono">
          ⌾
        </span>{" "}
        {founderName} · person-scoped
      </span>
    </InfoTooltip>
  );
}

export function FounderScoreCard({
  formulaVersion,
  scored,
  value,
  assessedCount,
  totalCriteria,
  coverage,
  confidence,
  belowThresholdNote,
  trend,
  gapsCount,
  groups,
  pedigree,
  defaultExpanded = false,
  className,
}: FounderScoreCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const allCriteria = groups.flatMap((g) => g.criteria);
  const sum = allCriteria.reduce((acc, c) => acc + (c.contribution ?? 0), 0);
  const verified = scored && value != null && Math.abs(sum - value) < 0.05;

  return (
    <div className={cn("border border-[color:var(--color-border)] p-4", className)}>
      <div className="flex items-center gap-2.5">
        <InfoTooltip content={FOUNDER_SCORE_EXPLANATION}>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] px-2.5 py-0.5 text-[11.5px]">
            <span aria-hidden="true" className="font-mono">
              ⌾
            </span>{" "}
            FOUNDER SCORE · person-scoped
          </span>
        </InfoTooltip>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
          {formulaVersion}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="cursor-pointer border border-[color:var(--color-border)] px-1.5 py-px font-mono text-[12px]"
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {scored && value != null ? (
        <div className="mt-3.5 grid grid-cols-[180px_1fr_220px] items-start gap-6">
          <div>
            <div className="font-mono text-[38px] leading-[1.1] font-medium">
              {value.toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] leading-[1.45] text-[color:var(--color-text-muted)]">
              weighted score over {assessedCount} assessed criteria — not a percentage, not a
              prediction
            </div>
          </div>
          <div>
            <div className="relative h-1 max-w-[300px] bg-[color:var(--color-track)]">
              <div
                className="absolute inset-y-0 left-0 bg-[color:var(--color-text)]"
                style={{ width: `${Math.round(coverage * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 font-mono text-[10.5px] text-[color:var(--color-text-muted)]">
              coverage {coverage.toFixed(2)}
              {confidence != null ? ` · confidence ${confidence.toFixed(2)}` : ""}
            </div>
            <div className="mt-2 border-t border-[color:var(--color-border)] pt-2 text-[12px] text-[color:var(--color-text-muted)]">
              This number is computed from the evidence we hold. No AI model reports its own
              confidence anywhere in this system.
            </div>
          </div>
          <div className="text-[12.5px] leading-[1.6]">
            <div>
              <span className="font-mono">●</span> {assessedCount} of {totalCriteria} assessed
            </div>
            <div className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
              coverage {coverage.toFixed(2)}
            </div>
            {trend ? (
              <div className="mt-1.5 font-mono text-[11px]">
                {TREND_ARROW[trend.direction]} {trend.direction} · {trend.delta}
              </div>
            ) : null}
            {gapsCount != null && gapsCount > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-1.5 cursor-pointer text-left font-medium"
              >
                {gapsCount} gaps ▸ what would close them
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3.5 grid grid-cols-[1fr_220px] items-start gap-6">
          <div>
            <div className="text-[24px] leading-[1.2] font-medium">
              Not enough evidence to score
            </div>
            <div className="my-2 h-0.5 w-[220px] bg-[color:var(--color-text)]" />
            <div className="text-[14px] font-medium">We looked. We are not guessing.</div>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2.5 cursor-pointer text-[13px] font-medium"
            >
              ▸ {totalCriteria - assessedCount} things that would produce a score
            </button>
          </div>
          <div className="text-[12.5px] leading-[1.6]">
            <div>
              <span className="font-mono">●</span> {assessedCount} of {totalCriteria} assessed
            </div>
            <div className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
              coverage {coverage.toFixed(2)}
              {belowThresholdNote ? (
                <>
                  <br />
                  {belowThresholdNote}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {expanded ? (
        <div className="mt-4 border-t border-[color:var(--color-border)]">
          {groups.map((group) => (
            <div key={group.name}>
              <div className="flex justify-between pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                <span>{group.name}</span>
                <span className="font-mono font-normal normal-case">
                  weight {group.weight.toFixed(2)}
                </span>
              </div>
              {group.criteria.map((c) => {
                const mark = VERDICT_MARK[c.verdict];
                return (
                  <div
                    key={c.criterionId}
                    className="border-t border-[color:var(--color-border)] py-2 pl-1"
                  >
                    <div className="grid grid-cols-[26px_1fr_130px_80px] items-baseline gap-2.5">
                      <span
                        aria-hidden="true"
                        title={mark.reads}
                        className={cn("font-mono", mark.className)}
                      >
                        {mark.glyph}
                      </span>
                      <span className="text-[13.5px]">
                        {c.label}{" "}
                        <span className="border border-[color:var(--color-border)] px-1 font-mono text-[9.5px] text-[color:var(--color-text-muted)]">
                          {c.criterionId}
                        </span>
                      </span>
                      <span className="text-[12px] text-[color:var(--color-text-muted)]">
                        {c.tierLabel}
                      </span>
                      <span className="text-right font-mono text-[12px]">
                        {formatContribution(c.contribution)}
                      </span>
                    </div>
                    {c.demotedBy ? (
                      <div className="mt-1 ml-9 text-[12px]">
                        <span className="font-mono">⚑</span> demoted by {c.demotedBy}
                      </div>
                    ) : null}
                    {c.quote ? (
                      <div className="mt-1 ml-9 border-l-2 border-[color:var(--color-lavender)] pl-2.5 text-[12.5px]">
                        “{c.quote}”{" "}
                        {c.quoteUrl ? (
                          <a
                            href={c.quoteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[10.5px]"
                          >
                            ↗ {c.quoteSourceLabel ?? c.quoteUrl}
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                    {c.rationale ? (
                      <div className="mt-0.5 ml-9 text-[11.5px] text-[color:var(--color-text-muted)]">
                        <span className="rounded-full border border-[color:var(--color-border)] px-1.5 font-mono text-[9.5px]">
                          model interpretation ◇
                        </span>{" "}
                        {c.rationale}
                      </div>
                    ) : null}
                    {c.whatWouldCloseIt ? (
                      <div className="mt-1 ml-9 text-[12px] text-[color:var(--color-text-muted)]">
                        ▸ What would close it: {c.whatWouldCloseIt}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}

          {scored && value != null ? (
            <div className="flex justify-end gap-2 border-t-2 border-[color:var(--color-text)] py-2 font-mono text-[12.5px]">
              <span>Σ contributions = {sum.toFixed(2)}</span>
              {verified ? <span style={{ color: "var(--color-ok)" }}>✓ verified</span> : null}
            </div>
          ) : null}

          {pedigree ? (
            <div className="mt-2.5 bg-[color:var(--color-surface)] p-3">
              <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                Pedigree (not scored)
              </div>
              <div className="mt-0.5 text-[13px]">{pedigree.text}</div>
              {pedigree.tags.length > 0 ? (
                <div className="mt-1.5 font-mono text-[11.5px] text-[color:var(--color-text-muted)]">
                  {pedigree.tags.join(" · ")}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 bg-[color:var(--color-surface)] p-3 text-[12px] text-[color:var(--color-text-muted)]">
            <span className="text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              Personality (research)
            </span>{" "}
            — parked; not scored, not shown until this ships.
          </div>
        </div>
      ) : null}
    </div>
  );
}
