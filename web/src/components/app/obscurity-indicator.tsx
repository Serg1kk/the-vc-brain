// Obscurity — a fact, not a score. scoring-ux.md §5.
//
// Design it as a proud column, not a warning: the whole thesis is finding people
// before conventional databases do. Renders the bar, the number and the basis chip
// together, always — a one-term basis is weaker evidence than a two-term one, and
// that difference is the cheapest honesty win available here.

import { cn } from "@/lib/utils";
import { ProvenanceChip } from "./provenance-chip";

const BASIS_LABEL: Record<string, string> = {
  gh_followers: "followers only",
  hn_karma: "karma only",
};

interface ObscurityIndicatorProps {
  /** 0–1. Null when no metric was ever observed — never a computed 0. */
  obscurity: number | null;
  basis: string[] | null;
  className?: string;
}

export function ObscurityIndicator({ obscurity, basis, className }: ObscurityIndicatorProps) {
  if (obscurity == null) {
    return (
      <span className={cn("text-[12px] text-[color:var(--color-text-muted)] italic", className)}>
        obscurity not yet observed
      </span>
    );
  }

  const basisLabel =
    !basis || basis.length === 0
      ? null
      : basis.length >= 2
        ? "both signals"
        : (BASIS_LABEL[basis[0]] ?? basis[0]);

  // A live defect (data-contracts.md §5): negative HN karma is floored to 0 before
  // the log, so a downvoted account can read as "observed and maximally obscure"
  // instead of "unobserved". Flag the karma-only extreme until it's reconciled
  // upstream — a perfect 1.0 from one karma term is more likely a downvote than a
  // discovery.
  const suspicious = obscurity >= 0.99 && basis?.length === 1 && basis[0] === "hn_karma";

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <ProvenanceChip kind="rule" />
      <span className="font-mono text-[12px]">{obscurity.toFixed(2)}</span>
      <span className="relative block h-1 w-16 bg-[color:var(--color-track)]">
        <span
          className="absolute inset-y-0 left-0 bg-[color:var(--color-text)]"
          style={{ width: `${obscurity * 100}%` }}
        />
      </span>
      {basisLabel ? (
        <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">
          basis: {basisLabel}
        </span>
      ) : null}
      {suspicious ? (
        <span
          title="A perfect 1.0 from a single karma term is more likely a downvoted account than a discovery."
          className="font-mono text-[10px] text-[color:var(--color-text-muted)]"
        >
          ⚑ check karma sign
        </span>
      ) : null}
    </span>
  );
}
