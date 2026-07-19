export function DisclosureBanner() {
  return (
    <div
      role="note"
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4 pl-5"
      style={{ borderLeft: "3px solid var(--color-warn)" }}
    >
      <p className="text-[14px] text-[color:var(--color-text)]">
        An AI system reviews your application. It reads your deck and public information about
        your work, then a human investor reviews everything before any decision is made. No
        decision here is made by AI alone.
      </p>
      <p className="mt-2 text-[14px] text-[color:var(--color-text)]">
        You will get an answer within 24 hours.
      </p>
    </div>
  );
}
