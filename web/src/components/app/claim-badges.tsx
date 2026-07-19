// The verdict / tier / class badge system — brief §4.2, scoring-ux.md §3.6(b).
// Three orthogonal families, not nine colours on one scale. Labels here are the
// frozen §4.2 vocabulary verbatim — do not invent, rename or merge values.

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "./info-tooltip";

export type DerivedStatus =
  "verified" | "contradicted" | "partially_supported" | "unverified" | "missing";
export type EvidenceTier = "documented" | "discovered" | "inferred" | "missing";

const VERDICT_LABEL: Record<DerivedStatus, string> = {
  verified: "Supported",
  contradicted: "Refuted",
  partially_supported: "Conflicting",
  unverified: "Not enough evidence",
  missing: "Not disclosed",
};

// Family A — verdict. Deliberately not one colour ramp: verified and missing are
// solid chips, contradicted is a serious-but-not-alarm outline, conflicting is
// dashed (it sits between support and refutation), and "not enough evidence" carries
// no chip weight at all — it is 76% of all claims and must not read as a warning.
const VERDICT_CLASS: Record<DerivedStatus, string> = {
  verified: "chip-rule",
  contradicted:
    "inline-block border-[1.5px] border-[color:var(--color-text)] px-1.5 font-mono text-[10px] font-semibold tracking-wide",
  partially_supported:
    "inline-block border border-dashed border-[color:var(--color-text)] px-1.5 font-mono text-[10px] tracking-wide",
  unverified: "text-[12px] text-[color:var(--color-text-muted)]",
  missing:
    "inline-block bg-[color:var(--color-surface-2)] px-1.5 font-mono text-[10px] tracking-wide",
};

// Plain-language, one-sentence hover explanations — separate from VERDICT_LABEL
// above, which stays the short display label consumed by other screens
// (verdictLabel() is a live call site in the memo screen; do not fold these together).
const VERDICT_TOOLTIP: Record<DerivedStatus, string> = {
  verified: "At least one independent, credible source confirms this, and nothing contradicts it.",
  contradicted: "A credible source directly contradicts this claim.",
  partially_supported:
    "Some evidence supports this claim and some contradicts it — the picture is mixed.",
  unverified: "We haven't found enough evidence yet to confirm or refute this.",
  missing: "The founder hasn't shared this — a declared gap, not a red flag.",
};

interface VerdictBadgeProps {
  status: DerivedStatus;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

/** Family A — the five frozen verdicts (§4.2). Read from `derived_status`, never
 * `claims.verification_status`. */
export function VerdictBadge({ status, onClick, className }: VerdictBadgeProps) {
  return (
    <InfoTooltip content={VERDICT_TOOLTIP[status]}>
      <span
        onClick={onClick}
        className={cn(VERDICT_CLASS[status], onClick ? "cursor-pointer" : "", className)}
      >
        {VERDICT_LABEL[status]}
      </span>
    </InfoTooltip>
  );
}

const FORECAST_TOOLTIP =
  "A projection, not a checked fact — forecasts like TAM estimates are never verified against evidence.";

/** Family B — replaces the verdict badge ENTIRELY for forecast-class claims (TAM
 * estimates, growth projections). A forecast never receives a verdict, ever, and
 * must not read as a failed verification. */
export function ForecastBadge({ className }: { className?: string }) {
  return (
    <InfoTooltip content={FORECAST_TOOLTIP}>
      <span
        className={cn(
          "inline-block rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-2 py-0.5 font-mono text-[10px] italic text-[color:var(--color-text-muted)]",
          className,
        )}
      >
        Forecast
      </span>
    </InfoTooltip>
  );
}

const JUDGEMENT_TOOLTIP =
  "A judgement claim, not a checkable fact — we show the evidence behind it but issue no verdict on it.";

/** Family B — for the 58% of claims that are judgement, not fact. Copy owns the
 * distinction: we show the evidence behind a judgement, we do not verify it. */
export function JudgementBadge({ className }: { className?: string }) {
  return (
    <InfoTooltip content={JUDGEMENT_TOOLTIP}>
      <span
        className={cn(
          "inline-block rounded-full border border-[color:var(--color-border)] px-2 py-0.5 font-mono text-[9.5px] text-[color:var(--color-text-muted)]",
          className,
        )}
      >
        Judgement — not verifiable
      </span>
    </InfoTooltip>
  );
}

const TIER_GLOSS: Record<EvidenceTier, string> = {
  documented: "primary record — filing, commit, direct inspection",
  discovered: "third-party observation",
  inferred: "self-reported",
  missing: "we looked, nothing found",
};

// Fuller one-sentence versions for the hover tooltip — TIER_GLOSS above stays the
// short phrase `tierGloss()` returns to callers.
const TIER_TOOLTIP: Record<EvidenceTier, string> = {
  documented: "Primary record — a filing, a commit, or something we inspected directly.",
  discovered: "A third party observed and reported this.",
  inferred: "Self-reported by the founder, not independently checked.",
  missing: "We looked for evidence and found none.",
};

/** Family C — provenance tier. Small, quiet, always present alongside a verdict —
 * "where the knowledge came from" is a separate fact from "what the evidence says". */
export function TierBadge({ tier, className }: { tier: EvidenceTier; className?: string }) {
  return (
    <InfoTooltip content={TIER_TOOLTIP[tier]}>
      <span
        className={cn(
          "inline-block border-b border-dotted border-[color:var(--color-text-muted)] text-[11.5px] capitalize text-[color:var(--color-text-muted)]",
          className,
        )}
      >
        {tier}
      </span>
    </InfoTooltip>
  );
}

export function tierGloss(tier: EvidenceTier): string {
  return TIER_GLOSS[tier];
}

export function verdictLabel(status: DerivedStatus): string {
  return VERDICT_LABEL[status];
}
