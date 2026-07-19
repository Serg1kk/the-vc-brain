// NL-search — brief §8.4, scoring-ux.md §6. One wide field, one pass, the parsed
// plan rendered above results as the trust affordance: it proves the query was
// understood rather than keyword-matched, and it makes a miss debuggable instead of
// mysterious. "The benchmark query returning no rows is a bug; the benchmark query
// returning confident rows is a worse bug" — three of its six fragments are expected
// to fail, and showing that honestly is the point, not a defect to hide.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  nlSearch,
  type ApiError,
  type NlSearchAttribute,
  type NlSearchItem,
  type NlSearchResponse,
} from "@/lib/investor-api";
import { SyntheticBadge } from "./synthetic-badge";

const BENCHMARK_QUERY =
  "technical founder, Berlin, AI infra, enterprise traction, no prior VC backing, top-tier accelerator";

type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "ok"; query: string; response: NlSearchResponse }
  | { status: "rejected"; query: string; error: ApiError } // Fate C — whole-plan rejection
  | { status: "error"; query: string; error: ApiError };

// --- plan-attribute reading -----------------------------------------------------
//
// `NlSearchResponse.plan.attributes` is intentionally typed loosely
// (`Array<Record<string, unknown>>`) in investor-api.ts since the plan echo isn't a
// frozen per-field contract — read it defensively rather than assume every field.

interface PlanAttribute {
  id: string;
  label: string;
  broadening?: string;
  resolvedAs?: string;
  mapping: string;
}

function readPlanAttribute(raw: Record<string, unknown>): PlanAttribute {
  const target = raw.target as { value?: unknown } | undefined;
  const targetValue = typeof target?.value === "string" ? target.value : undefined;
  const resolvedAs = typeof raw.resolved_as === "string" ? raw.resolved_as : undefined;
  const op = typeof raw.op === "string" ? raw.op : undefined;
  const mapping =
    resolvedAs ??
    (targetValue && op === "eq" && raw.value != null
      ? `${targetValue} = ${String(raw.value)}`
      : (targetValue ?? ""));
  return {
    id: String(raw.id ?? ""),
    label: typeof raw.label === "string" ? raw.label : String(raw.id ?? ""),
    broadening: typeof raw.broadening === "string" ? raw.broadening : undefined,
    resolvedAs,
    mapping,
  };
}

const UNRESOLVABLE_REASON: Record<string, string> = {
  no_data_source: "we hold no data of this kind",
  not_testable: "no way to test this against what we hold",
};

function unresolvableReason(reason: string): string {
  return UNRESOLVABLE_REASON[reason] ?? reason;
}

const ATTR_STATE: Record<NlSearchAttribute["state"], { glyph: string; reads: string }> = {
  matched: { glyph: "●", reads: "matched — evidence satisfies this as asked" },
  matched_broadened: { glyph: "◐", reads: "matched only after widening the question" },
  mismatch: { glyph: "✗", reads: "evidence contradicts this" },
  unknown: { glyph: "○", reads: "never looked — free, doesn't count against rank" },
  unknown_searched: {
    glyph: "⃝",
    reads: "looked and found nothing — free, doesn't count against rank",
  },
};

function stripFragment(text: string, fragment: string): string {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(escaped, "i"), "")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s{2,}/g, " ");
}

// --- result row -------------------------------------------------------------

function ResultRow({ item }: { item: NlSearchItem }) {
  const [expanded, setExpanded] = useState(false);
  const attributes = item.attributes;
  const assessed = attributes.filter(
    (a) => a.state === "matched" || a.state === "matched_broadened" || a.state === "mismatch",
  ).length;

  return (
    <div className="border-t border-[color:var(--color-border)]">
      <div
        onClick={() => setExpanded((e) => !e)}
        className="grid min-h-[var(--row-h)] cursor-pointer grid-cols-[24px_1fr_190px_120px] items-center gap-x-3 px-2 py-1"
        style={{ backgroundColor: expanded ? "var(--color-surface)" : undefined }}
      >
        <span
          aria-hidden="true"
          className="font-mono text-[11px] text-[color:var(--color-text-muted)]"
        >
          {expanded ? "▾" : "▸"}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 truncate text-[14px] font-medium">
            {item.company_name}
            {item.is_synthetic ? <SyntheticBadge /> : null}
          </span>
          <span className="block truncate text-[12px] text-[color:var(--color-text-muted)]">
            {item.full_name}
          </span>
        </span>
        {/* Coverage before rank, always — a row showing only rank appears mis-sorted
            against bucket-first ordering (scoring-ux.md §6.5). */}
        <span className="font-mono text-[11.5px] text-[color:var(--color-text-muted)]">
          assessed {assessed} of {attributes.length} attributes
        </span>
        <span className="font-mono text-[13px]">
          {item.rank_score != null ? Math.round(item.rank_score) : "not ranked"}
          <span className="ml-1.5 text-[10px] text-[color:var(--color-text-muted)]">
            {item.confidence_bucket ?? "confidence unknown"}
          </span>
        </span>
      </div>
      {expanded ? (
        <div className="px-2 pt-1 pb-3.5 pl-11 text-[12.5px]">
          {item.founder_score_assessed && item.founder_score != null ? (
            <div className="mb-1.5 font-mono text-[11px] text-[color:var(--color-text-muted)]">
              founder score {item.founder_score.toFixed(2)}
            </div>
          ) : null}
          {attributes.map((a) => {
            const st = ATTR_STATE[a.state];
            return (
              <div key={a.id} className="border-t border-[color:var(--color-border)] py-1.5">
                <div className="flex items-baseline gap-2.5">
                  <span aria-hidden="true" title={st.reads} className="font-mono">
                    {st.glyph}
                  </span>
                  <span className="flex-1 text-[13px]">{a.label}</span>
                  <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
                    weight {a.weight}
                  </span>
                </div>
                {a.broadening && a.resolved_as ? (
                  <div className="mt-0.5 ml-5 text-[11.5px] text-[color:var(--color-text-muted)]">
                    <span aria-hidden="true">ⓘ</span> widened: {a.broadening} — {a.resolved_as}
                  </div>
                ) : null}
                {a.evidence?.quote_verbatim ? (
                  <div className="mt-1 ml-5 border-l-2 border-[color:var(--color-lavender)] pl-2.5 text-[12px]">
                    “{a.evidence.quote_verbatim}”{" "}
                    {a.evidence.source_url ? (
                      <a
                        href={a.evidence.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10.5px]"
                      >
                        ↗ {a.evidence.tier ?? "source"}
                      </a>
                    ) : null}
                  </div>
                ) : a.note ? (
                  <div className="mt-0.5 ml-5 text-[11.5px] text-[color:var(--color-text-muted)]">
                    {a.note}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// --- panel --------------------------------------------------------------------

interface NlSearchPanelProps {
  onActiveChange?: (active: boolean) => void;
  className?: string;
}

export function NlSearchPanel({ onActiveChange, className }: NlSearchPanelProps) {
  const [queryText, setQueryText] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onActiveChange?.(state.status !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  async function runSearch(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setState({ status: "loading", query: trimmed });
    const res = await nlSearch(trimmed, 20);
    if (res.ok) {
      setState({ status: "ok", query: trimmed, response: res.data });
    } else if (res.error.upstreamKind === "unresolvable_query") {
      setState({ status: "rejected", query: trimmed, error: res.error });
    } else {
      setState({ status: "error", query: trimmed, error: res.error });
    }
  }

  function clear() {
    setState({ status: "idle" });
    setQueryText("");
  }

  function removeUnderstood(label: string) {
    const next = stripFragment(queryText, label);
    setQueryText(next);
    if (next) void runSearch(next);
    else clear();
  }

  const planAttributes: PlanAttribute[] =
    state.status === "ok" ? state.response.plan.attributes.map(readPlanAttribute) : [];
  const unresolvable = state.status === "ok" ? state.response.plan.unresolvable : [];

  return (
    <div className={className}>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(queryText);
          }}
          placeholder={BENCHMARK_QUERY}
          aria-label="Search the corpus in plain language"
          className="w-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3.5 py-2.5 text-[14px] outline-none focus-visible:border-[color:var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => void runSearch(queryText)}
          className="shrink-0 cursor-pointer border border-[color:var(--color-border)] px-3 text-[13px] font-medium"
        >
          Search
        </button>
        {state.status !== "idle" ? (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 cursor-pointer border border-[color:var(--color-border)] px-3 text-[13px] text-[color:var(--color-text-muted)]"
          >
            Clear search
          </button>
        ) : null}
      </div>

      {state.status === "loading" ? (
        <div className="mt-2">
          <div className="h-[3px] w-full bg-[color:var(--color-track)]">
            <div className="h-full w-2/3 animate-pulse bg-[color:var(--color-text)]" />
          </div>
          <div className="mt-1 text-[12px] text-[color:var(--color-text-muted)]">Searching…</div>
        </div>
      ) : null}

      {state.status === "rejected" ? (
        <div className="mt-2 border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3.5 text-[13.5px]">
          The search couldn't be interpreted safely, so nothing was run rather than running the
          wrong search.
          <div className="mt-1 text-[12px] text-[color:var(--color-text-muted)]">
            Edit the query above and search again.
          </div>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="mt-2 flex items-baseline justify-between gap-3 border border-[color:var(--color-border)] p-3.5 text-[13.5px]">
          <span>{state.error.message}</span>
          {state.error.retryable !== false ? (
            <button
              type="button"
              onClick={() => void runSearch(state.query)}
              className="shrink-0 cursor-pointer border border-[color:var(--color-border)] px-2.5 py-1 text-[12.5px] font-medium"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {state.status === "ok" ? (
        <>
          <div className="border border-t-0 border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3.5 text-[13px]">
            <div className="grid grid-cols-[96px_1fr] items-start gap-x-3.5 gap-y-2">
              <div className="pt-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                Understood
              </div>
              <div className="flex flex-wrap gap-2">
                {planAttributes.length === 0 ? (
                  <span className="text-[12.5px] text-[color:var(--color-text-muted)] italic">
                    Nothing resolved.
                  </span>
                ) : (
                  planAttributes.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1.5 border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1"
                    >
                      <span aria-hidden="true" className="font-mono text-[12px]">
                        {a.broadening ? "◐" : "●"}
                      </span>
                      <span className="text-[13px]">
                        {a.label}{" "}
                        <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
                          → {a.mapping}
                        </span>
                      </span>
                      {a.broadening ? (
                        <span
                          title={`widened: ${a.broadening}`}
                          className="border-b border-dotted border-[color:var(--color-text-muted)] font-mono text-[10.5px] text-[color:var(--color-text-muted)]"
                        >
                          ⓘ widened: {a.broadening}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        title="Remove this from the query"
                        onClick={() => removeUnderstood(a.label)}
                        className="cursor-pointer pl-0.5 text-[12px] text-[color:var(--color-text-muted)]"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="pt-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
                Not searched
              </div>
              <div className="flex flex-wrap gap-2">
                {unresolvable.length === 0 ? (
                  <span className="text-[12.5px] text-[color:var(--color-text-muted)]">none</span>
                ) : (
                  unresolvable.map((u, i) => (
                    <span
                      key={`${u.label}-${i}`}
                      title="Unresolved fragments are never hidden and cannot be removed"
                      className="inline-flex items-baseline gap-1.5 border border-dashed border-[color:var(--color-border)] px-2 py-1 text-[color:var(--color-text-muted)]"
                    >
                      <span aria-hidden="true" className="font-mono text-[12px]">
                        ○
                      </span>
                      <span className="text-[13px]">{u.label}</span>
                      <span className="text-[11.5px] italic">{unresolvableReason(u.reason)}</span>
                    </span>
                  ))
                )}
              </div>
            </div>
            <div className="mt-2.5 text-[12px] text-[color:var(--color-text-muted)]">
              {planAttributes.length} of {planAttributes.length + unresolvable.length} fragments
              resolved. Unresolved fragments cost nothing in ranking and are never silently dropped
              — a search that hid them would answer a different question than the one asked.
            </div>
            {state.response.note ? (
              <div className="mt-1.5 text-[12px] text-[color:var(--color-text-muted)] italic">
                {state.response.note}
              </div>
            ) : null}
          </div>

          {state.response.items.length === 0 && state.response.low_confidence.length === 0 ? (
            <div className="mt-4 border border-[color:var(--color-border)] p-5 text-[13.5px]">
              No founders match that description.
              <div className="mt-1 text-[12.5px] text-[color:var(--color-text-muted)]">
                Try clearing search terms above, or clear the search to return to the ranked feed.
              </div>
            </div>
          ) : (
            <>
              <div className="mt-2">
                {state.response.items.map((item) => (
                  <ResultRow key={item.founder_id} item={item} />
                ))}
              </div>
              {state.response.low_confidence.length > 0 ? (
                <div className="mt-6 border-t-2 border-[color:var(--color-text)] pt-3">
                  <div className="text-[11.5px] font-semibold tracking-[0.08em] uppercase">
                    Below the confidence floor
                  </div>
                  <div className="mb-1 text-[12.5px] text-[color:var(--color-text-muted)]">
                    Too little assessed to rank fairly. Shown, not dropped.
                  </div>
                  {state.response.low_confidence.map((item) => (
                    <ResultRow key={item.founder_id} item={item} />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

export { BENCHMARK_QUERY };
