// The explain panel — one component, used everywhere. brief §4.4.
//
// Every number, badge and chip on every screen is click-through to the same
// right-side sheet. Built directly on @radix-ui/react-dialog (already a project
// dependency) rather than the shared `ui/sheet.tsx` wrapper, so this panel can match
// the brief's exact 420px width and light overlay without forking a shared primitive.
//
// Usage: wrap the app shell once in <ExplainPanelProvider>, then anywhere deeper call
// `const { open } = useExplainPanel()` and `open(data)` from a click handler.

import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ProvenanceChip, type ProvenanceKind } from "./provenance-chip";

export interface ExplainFormulaLine {
  /** e.g. "", "×", "−", "=". */
  op: string;
  label: string;
  value: string;
  note: string;
}

export interface ExplainModelInfo {
  modelName: string;
  asked: string;
  shown: string;
}

export interface ExplainEvidenceItem {
  claim: string;
  /** Verbatim quote where one exists — never a summary. Omit rather than paraphrase. */
  quote?: string | null;
  sourceUrl?: string;
  sourceLabel?: string;
  tier?: string;
  verdict?: string;
  date?: string;
}

export interface ExplainUnknown {
  gap: string;
  /** The stored `what_would_close_it` string — render verbatim, do not rewrite. */
  closes: string;
}

export interface ExplainAudit {
  checkedAt: string;
  check: string;
  runId: string;
}

export interface ExplainPanelData {
  title: string;
  /** Plain-language sentence. No jargon, no formula. */
  what: string;
  /** null when nothing was computed at all (e.g. a locked source-channel disclosure)
   * — the "How it was produced" section is omitted entirely in that case. */
  chip: ProvenanceKind | null;
  /** For `rule` / `rule_on_model`: the formula, its named constants, each input with
   * its own value. */
  formula?: ExplainFormulaLine[];
  /** For `model` / `rule_on_model`: which model, what it was asked, what it was shown. */
  model?: ExplainModelInfo;
  evidence?: ExplainEvidenceItem[];
  unknowns?: ExplainUnknown[];
  /** Brief §4.4's dedicated section: "Coverage x% · Confidence y — always both,
   * always next to the value. Never the value alone." A plain number 0–1, or
   * omitted when this number genuinely has no confidence (e.g. a locked-channel
   * disclosure). */
  confidence?: number | null;
  /**
   * A real number (0–1) when one exists. When it doesn't — true for the three
   * application axes, which carry no coverage figure in `api_applications` — pass
   * an honest plain-language proxy string instead (e.g. `"7 of 12 signals
   * present"` derived from the axis's `missing[]` gap codes, or `"Coverage not
   * separately measured for this axis."`). Never fabricate a number and never
   * omit both this and `confidence` when either is knowable — the whole point of
   * this section is not to hide the limit.
   */
  coverage?: number | string | null;
  audit?: ExplainAudit;
}

interface ExplainPanelContextValue {
  open: (data: ExplainPanelData) => void;
  close: () => void;
}

const ExplainPanelContext = createContext<ExplainPanelContextValue | null>(null);

export function useExplainPanel(): ExplainPanelContextValue {
  const ctx = useContext(ExplainPanelContext);
  if (!ctx) {
    throw new Error("useExplainPanel must be called inside <ExplainPanelProvider>.");
  }
  return ctx;
}

export function ExplainPanelProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ExplainPanelData | null>(null);

  const value = useMemo<ExplainPanelContextValue>(
    () => ({
      open: (next) => setData(next),
      close: () => setData(null),
    }),
    [],
  );

  return (
    <ExplainPanelContext.Provider value={value}>
      {children}
      <ExplainPanel data={data} onOpenChange={(next) => (!next ? setData(null) : undefined)} />
    </ExplainPanelContext.Provider>
  );
}

function SectionHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={cn(
        "mt-4.5 mb-[5px] pt-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase",
        first
          ? "border-t-2 border-[color:var(--color-text)]"
          : "border-t border-[color:var(--color-border)]",
      )}
    >
      {children}
    </div>
  );
}

function ExplainPanel({
  data,
  onOpenChange,
}: {
  data: ExplainPanelData | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={data !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[color:var(--color-text)]/[0.08]" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 w-[420px] max-w-[90vw] overflow-y-auto border-l-2 border-[color:var(--color-text)] bg-[color:var(--color-bg)] px-6 pt-[22px] pb-11 text-[13.5px] focus:outline-none">
          {data ? (
            <>
              <div className="flex items-baseline gap-2.5">
                <Dialog.Title className="flex-1 text-[17px] font-medium">{data.title}</Dialog.Title>
                <Dialog.Close
                  aria-label="Close"
                  title="Esc"
                  className="cursor-pointer text-[16px] text-[color:var(--color-text-muted)]"
                >
                  ×
                </Dialog.Close>
              </div>
              <Dialog.Description className="sr-only">{data.what}</Dialog.Description>

              <SectionHeading first>What this number is</SectionHeading>
              <p>{data.what}</p>

              {data.chip !== null ? (
                <>
                  <SectionHeading>How it was produced</SectionHeading>
                  <div className="mb-2">
                    <ProvenanceChip kind={data.chip} showLabel />
                  </div>
                  {data.formula && data.formula.length > 0 ? (
                    <div className="border border-[color:var(--color-border)] p-2.5">
                      {data.formula.map((line, i) => (
                        <div
                          key={i}
                          className={cn(
                            "grid grid-cols-[16px_150px_60px_1fr] gap-2 py-0.5 font-mono text-[12px]",
                            i > 0 && "border-t border-[color:var(--color-border)]",
                          )}
                        >
                          <span>{line.op}</span>
                          <span>{line.label}</span>
                          <span>{line.value}</span>
                          <span className="font-sans text-[11.5px] text-[color:var(--color-text-muted)]">
                            {line.note}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {data.model ? (
                    <div className="border border-[color:var(--color-border)] p-2.5 text-[13px]">
                      <div>
                        <span className="text-[color:var(--color-text-muted)]">Model</span>{" "}
                        <span className="font-mono text-[12px]">{data.model.modelName}</span>
                      </div>
                      <div className="mt-1.5">
                        <span className="text-[color:var(--color-text-muted)]">Asked</span>{" "}
                        {data.model.asked}
                      </div>
                      <div className="mt-1.5">
                        <span className="text-[color:var(--color-text-muted)]">Shown</span>{" "}
                        {data.model.shown}
                      </div>
                    </div>
                  ) : null}
                  {data.chip === "rule_on_model" ? (
                    <div className="mt-2 bg-[color:var(--color-surface)] p-2.5 text-[12.5px]">
                      This number is computed from the evidence we hold. No AI model reports its own
                      confidence anywhere in this system.
                    </div>
                  ) : null}
                </>
              ) : null}

              {data.evidence && data.evidence.length > 0 ? (
                <>
                  <SectionHeading>Evidence</SectionHeading>
                  {data.evidence.map((ev, i) => (
                    <div key={i} className="border-b border-[color:var(--color-border)] py-2">
                      <div className="text-[13px]">{ev.claim}</div>
                      {ev.quote ? (
                        <div className="mt-1 border-l-2 border-[color:var(--color-lavender)] pl-2.5 text-[12.5px]">
                          “{ev.quote}”
                        </div>
                      ) : null}
                      <div className="mt-1 font-mono text-[10.5px] text-[color:var(--color-text-muted)]">
                        {ev.sourceUrl ? (
                          <a href={ev.sourceUrl} target="_blank" rel="noreferrer">
                            ↗ {ev.sourceLabel ?? ev.sourceUrl}
                          </a>
                        ) : null}
                        {ev.tier ? <> · {ev.tier}</> : null}
                        {ev.verdict ? <> · {ev.verdict}</> : null}
                        {ev.date ? <> · {ev.date}</> : null}
                      </div>
                    </div>
                  ))}
                </>
              ) : null}

              {data.unknowns && data.unknowns.length > 0 ? (
                <>
                  <SectionHeading>What we don&apos;t know</SectionHeading>
                  {data.unknowns.map((u, i) => (
                    <div key={i} className="py-1.5">
                      <div className="text-[13px] font-medium">{u.gap}</div>
                      <div className="text-[12.5px] text-[color:var(--color-text-muted)]">
                        {u.closes}
                      </div>
                    </div>
                  ))}
                </>
              ) : null}

              {data.confidence != null || data.coverage != null ? (
                <>
                  <SectionHeading>Coverage &amp; confidence</SectionHeading>
                  <div className="text-[13px] text-[color:var(--color-text-muted)]">
                    {data.coverage != null ? (
                      <div>
                        {typeof data.coverage === "number"
                          ? `Coverage ${Math.round(data.coverage * 100)}%`
                          : data.coverage}
                      </div>
                    ) : null}
                    {data.confidence != null ? (
                      <div className={data.coverage != null ? "mt-1" : undefined}>
                        Confidence {data.confidence.toFixed(2)}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {data.audit ? (
                <>
                  <SectionHeading>Audit</SectionHeading>
                  <div className="font-mono text-[11.5px] leading-[1.8] text-[color:var(--color-text-muted)]">
                    checked &nbsp;{data.audit.checkedAt}
                    <br />
                    check &nbsp;&nbsp;&nbsp;{data.audit.check}
                    <br />
                    run &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{data.audit.runId}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
