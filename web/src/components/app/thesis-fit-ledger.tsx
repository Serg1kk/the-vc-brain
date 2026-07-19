// Thesis fit — a ledger of rules, not a score. scoring-ux.md §4.5.
//
// Four outcome groups, never three: `unknown` is a first-class row with its own
// glyph and its own copy — "could not check", never "did not match". A generated UI
// collapses this into "missed" if not told otherwise; that is the single highest-
// value line on this panel.

import { cn } from "@/lib/utils";
import type { FiredRule } from "@/lib/investor-api";
import { ProvenanceChip } from "./provenance-chip";

const GROUPS: Array<{ key: FiredRule["outcome"]; heading: string; glyph: string }> = [
  { key: "triggered", heading: "Triggered", glyph: "⛔" },
  { key: "missed", heading: "Missed", glyph: "○" },
  { key: "satisfied", heading: "Satisfied", glyph: "●" },
  { key: "unknown", heading: "Could not check", glyph: "◌" },
];

function formatExpected(expected: unknown): string {
  if (Array.isArray(expected)) return `one of [${expected.join(", ")}]`;
  return String(expected);
}

interface ThesisFitLedgerProps {
  /** Null when the evaluation verdict is `insufficient_evidence` — suppress the
   * number entirely and lead with the gaps instead. Never render it as 0. */
  fit: number | null;
  coverage: number | null;
  rules: FiredRule[];
  /** e.g. "we could check 31% of it. Missing: business_model, sector." — shown when
   * `fit` is null. */
  insufficientReason?: string | null;
  /** "Screened on keywords only — no deck was read." context, so a `borderline`
   * verdict with a null fit doesn't read as broken. */
  keywordModeOnly?: boolean;
  className?: string;
}

export function ThesisFitLedger({
  fit,
  coverage,
  rules,
  insufficientReason,
  keywordModeOnly,
  className,
}: ThesisFitLedgerProps) {
  const grouped = GROUPS.map((g) => ({ ...g, rows: rules.filter((r) => r.outcome === g.key) }));

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <span className="font-mono">
          {fit == null ? (
            "Not assessable against this thesis"
          ) : (
            <>
              WHY THIS FIT — <span className="font-semibold">{fit}</span>
            </>
          )}
        </span>
        {coverage != null ? (
          <span className="text-[color:var(--color-text-muted)]">
            coverage {Math.round(coverage * 100)}%
          </span>
        ) : null}
        <ProvenanceChip kind="rule" />
      </div>

      {fit == null && insufficientReason ? (
        <p className="mt-1.5 text-[13px] text-[color:var(--color-text-muted)]">
          {insufficientReason}
        </p>
      ) : null}
      {keywordModeOnly ? (
        <p className="mt-1.5 text-[13px] text-[color:var(--color-text-muted)]">
          Screened on keywords only — no deck was read. This can rule a company out, never in.
        </p>
      ) : null}

      <div className="mt-3 divide-y divide-[color:var(--color-border)] border-t border-[color:var(--color-border)]">
        {grouped.map((g) => (
          <div key={g.key} className="py-2.5">
            <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
              {g.heading}
            </div>
            {g.rows.length === 0 ? (
              <div className="mt-1 text-[12.5px] text-[color:var(--color-text-muted)] italic">
                none
              </div>
            ) : (
              g.rows.map((r) => (
                <div key={r.id} className="mt-1.5">
                  <div className="flex items-baseline gap-2 text-[13.5px]">
                    <span aria-hidden="true" className="font-mono">
                      {g.glyph}
                    </span>
                    <span className="flex-1">{r.label}</span>
                    <span
                      className={cn("font-mono text-[11.5px] text-[color:var(--color-text-muted)]")}
                    >
                      {r.kind} · {r.enforcement}
                      {/* Deal-breakers are always weight 0 by construction — render
                          them as a flag, never as a weight bar. */}
                      {r.kind !== "deal_breaker" && r.weight_applied
                        ? ` · weight ${r.weight_applied}`
                        : ""}
                    </span>
                  </div>
                  <div className="ml-5 text-[12px] text-[color:var(--color-text-muted)]">
                    expected {formatExpected(r.expected)} — observed {String(r.observed)}
                  </div>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
