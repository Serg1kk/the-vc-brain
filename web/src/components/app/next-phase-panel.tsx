// The card's mandatory next-phase teaser — brief §9.5. Own copy, own component: the
// founder-facing NextPhasePanel (src/components/NextPhasePanel.tsx) belongs to
// feature 08 and describes a different phase; this is not a fork of it.

export function NextPhasePanel() {
  return (
    <aside
      aria-labelledby="f09-next-phase-heading"
      className="border border-[color:var(--color-border)] p-5 text-[color:var(--color-text-muted)]"
    >
      <p className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--color-text-muted)] uppercase">
        Next phase
      </p>
      <h2
        id="f09-next-phase-heading"
        className="mt-1 text-[16px] font-semibold text-[color:var(--color-text)]"
      >
        Interview signals
      </h2>
      <p className="mt-3 text-[14px]">
        Founders will answer in their own voice. Spoken answers will be scored on a separate axis
        and shown alongside the evidence we gather ourselves — never merged into it. Hesitation,
        pacing and latency carry signal that written answers cannot.
      </p>
      <p className="mt-4 text-[13px]">Not available yet.</p>
    </aside>
  );
}
