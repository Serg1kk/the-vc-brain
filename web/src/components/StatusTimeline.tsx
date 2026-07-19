import type { ApplicationStatus } from "../lib/types";

const STEPS: { key: ApplicationStatus; label: string }[] = [
  { key: "screening", label: "Received" },
  { key: "diligence", label: "Under review" },
  { key: "decision", label: "Verdict" },
];

interface Props {
  status: ApplicationStatus;
}

export function StatusTimeline({ status }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="mt-4 flex items-center gap-2" aria-label="Application progress">
      {STEPS.map((s, i) => {
        const active = i === currentIndex;
        const past = i < currentIndex;
        const color = active
          ? "var(--color-accent)"
          : past
          ? "var(--color-text)"
          : "var(--color-text-muted)";
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: color }}
              />
              <span
                className="text-[13px]"
                style={{ color, fontWeight: active ? 600 : 400 }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden
                className="h-px flex-1"
                style={{ background: "var(--color-border)" }}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
