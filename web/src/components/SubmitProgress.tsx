import { useEffect, useState } from "react";

const STAGES = ["Uploading your deck", "Reading it", "Checking public sources"] as const;

// Cosmetic staged progress while the intake request is in flight.
// The API is a single call; timings are approximate.
export function SubmitProgress() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 1200);
    const t2 = setTimeout(() => setStage(2), 4500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
    >
      <ol className="space-y-2">
        {STAGES.map((label, i) => {
          const state: "done" | "active" | "pending" =
            i < stage ? "done" : i === stage ? "active" : "pending";
          const color =
            state === "done"
              ? "var(--color-ok)"
              : state === "active"
                ? "var(--color-accent)"
                : "var(--color-text-muted)";
          return (
            <li key={label} className="flex items-center gap-3 text-[14px]">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: color }}
              />
              <span
                style={{
                  color: state === "pending" ? "var(--color-text-muted)" : "var(--color-text)",
                }}
              >
                {label}
                {state === "active" ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
