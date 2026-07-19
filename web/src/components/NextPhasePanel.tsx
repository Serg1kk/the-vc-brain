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
        Soon, founders will be able to answer in their own voice instead of typing.
      </p>
      <p className="mt-4 text-[13px]">Not available yet. Nothing on this page records audio.</p>
    </aside>
  );
}
