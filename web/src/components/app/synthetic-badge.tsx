// Persistent SYNTHETIC badge — brief §4.6. A hard QA gate: it must never be possible
// to see a synthetic record without this badge, in the feed row, the card hero and
// the memo header.

import { cn } from "@/lib/utils";

export function SyntheticBadge({ className }: { className?: string }) {
  return (
    <span
      title="Synthetic fixture — a demo profile with deliberately seeded contradictions, not a real person."
      className={cn(
        "inline-block border border-[color:var(--color-border)] px-1 font-mono text-[9px] text-[color:var(--color-text-muted)]",
        className,
      )}
    >
      SYNTHETIC
    </span>
  );
}
