export function NextPhasePanel() {
  return (
    <aside
      aria-labelledby="next-phase-heading"
      className="rounded-md border border-[color:var(--color-border)] bg-transparent p-5 text-[color:var(--color-text-muted)]"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-text-muted)]">
        Next phase
      </p>
      <h2
        id="next-phase-heading"
        className="mt-1 text-[16px] font-semibold text-[color:var(--color-text)]"
      >
        Voice conversations
      </h2>
      <p className="mt-3 text-[14px]">
        Today we read your deck and your public work. Next, founders will be able to answer in
        their own voice instead of typing.
      </p>
      <p className="mt-4 text-[13px] font-medium text-[color:var(--color-text)]">
        Why it matters:
      </p>
      <ul className="mt-2 space-y-2 text-[14px]">
        <li>
          · A spoken answer is far harder to fake than pasted text, so it counts as stronger
          evidence.
        </li>
        <li>
          · Hesitation, pacing and latency carry signal that written answers cannot — which is
          what makes a voice answer resistant to being generated on the fly.
        </li>
        <li>
          · Voice answers will be scored separately and shown to investors alongside, never
          merged into, the evidence we gather ourselves.
        </li>
      </ul>
      <p className="mt-4 text-[13px]">Not available yet. Nothing on this page records audio.</p>
    </aside>
  );
}
