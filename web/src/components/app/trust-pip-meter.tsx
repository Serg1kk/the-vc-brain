// Per-claim trust — a decomposed meter, never a percentage. scoring-ux.md §3.6(a).
//
// The formula caps a single-source claim at 0.63, and 137 of 139 verified claims in
// the live corpus have exactly one source. Rendering that as "63%" reads as "the
// system is 63% sure this is true" to a non-technical investor — wrong, and it
// damages the honest founders it hits hardest. Four pips preserve the ordering the
// formula gives without implying that false precision. The raw decimal belongs only
// inside the explain panel, next to the arithmetic that produced it.

import { cn } from "@/lib/utils";
import type { EvidenceTier } from "./claim-badges";
import { InfoTooltip } from "./info-tooltip";

const TRUST_PIP_EXPLANATION =
  "Per-claim trust: how well-evidenced this specific claim is, 0–4 pips. More independent sources and stronger evidence = more pips.";

export interface TrustPipInput {
  hasSupport: boolean;
  /** The best-tier supporting evidence row for this claim, or null if none supports it. */
  bestSupportingTier: EvidenceTier | null;
  independentCount: number;
}

/** pip 1 = has any support · pip 2 = documented/discovered tier · pip 3 = ≥1
 * independent source · pip 4 = ≥2 independent sources. Driven by the same structural
 * facts the `trust` arithmetic uses — never invented. */
export function computeTrustPips(input: TrustPipInput): number {
  let pips = 0;
  if (input.hasSupport) pips += 1;
  if (input.bestSupportingTier === "documented" || input.bestSupportingTier === "discovered")
    pips += 1;
  if (input.independentCount >= 1) pips += 1;
  if (input.independentCount >= 2) pips += 1;
  return pips;
}

interface TrustPipMeterProps {
  /** 0–4. Use `computeTrustPips` unless the caller already has the count. */
  pips: number;
  /** Hover/sr-only context, e.g. "1 independent source · documented". */
  title?: string;
  className?: string;
}

export function TrustPipMeter({ pips, title, className }: TrustPipMeterProps) {
  const clamped = Math.max(0, Math.min(4, Math.round(pips)));
  return (
    <InfoTooltip content={title ? `${TRUST_PIP_EXPLANATION} ${title}.` : TRUST_PIP_EXPLANATION}>
      <span
        aria-label={title ? `Trust ${clamped} of 4 — ${title}` : `Trust ${clamped} of 4`}
        className={cn("font-mono text-[12px] tracking-[2px]", className)}
      >
        {"●".repeat(clamped)}
        {"○".repeat(4 - clamped)}
      </span>
    </InfoTooltip>
  );
}
