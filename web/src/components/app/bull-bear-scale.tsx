// Bull / neutral / bear without a traffic light — scoring-ux.md §2.7(c).
//
// A positional scale marker, not a chip: how bullish is read from geometry, so
// adjacent cards become comparable at a glance. `undetermined` is not a fourth
// position on the track — it replaces the track with a dashed empty rail, because
// "middling" and "could not assess" must differ in component, not in colour or copy.

import { cn } from "@/lib/utils";

interface BullBearScaleProps {
  /** false when no TAM was ever established — the market categoriser ran, but
   * nothing grounds a stance. Replaces the whole track. */
  determined: boolean;
  /** 0–100, the market score's position on the scale. Ignored when !determined. */
  value: number | null;
  confidence: number | null;
  className?: string;
}

export function BullBearScale({ determined, value, confidence, className }: BullBearScaleProps) {
  const labels = (
    <div className="flex justify-between px-0.5 text-[11.5px] text-[color:var(--color-text-muted)]">
      <span>bear</span>
      <span>neutral</span>
      <span>bullish</span>
    </div>
  );

  if (!determined || value == null) {
    return (
      <div className={cn("max-w-[420px]", className)}>
        {labels}
        <div className="relative mt-0.5 h-[18px]">
          <div className="track-hatch absolute inset-x-0 top-[7px] h-1" />
        </div>
        <div className="mt-0.5 text-[12px] text-[color:var(--color-text-muted)]">
          not assessed — no TAM established
        </div>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, value));
  // Confidence modulates the marker, never the track's meaning: high → solid dot,
  // low → hollow ring, below 0.2 → hollow ring on a dashed rail — so a judge
  // scrubbing the demo with the sound off can tell a well-evidenced bull from a
  // guessed one.
  const solid = confidence != null && confidence >= 0.5;
  const veryLow = confidence == null || confidence < 0.2;

  return (
    <div className={cn("max-w-[420px]", className)}>
      {labels}
      <div className="relative mt-0.5 h-[18px]">
        <div
          className={cn(
            "absolute inset-x-0 top-2 border-t",
            veryLow ? "border-dashed" : "border-solid",
            "border-[color:var(--color-text)]",
          )}
        />
        <div className="absolute top-1 left-0 h-[9px] w-px bg-[color:var(--color-text)]" />
        <div className="absolute top-1 right-0 h-[9px] w-px bg-[color:var(--color-text)]" />
        <div
          title={confidence != null ? `confidence ${confidence}` : "confidence unknown"}
          className={cn(
            "absolute top-0.5 h-[11px] w-[11px] -translate-x-1/2 rounded-full border-2 border-[color:var(--color-text)]",
            solid ? "bg-[color:var(--color-text)]" : "bg-[color:var(--color-bg)]",
          )}
          style={{ left: `${pct}%` }}
        />
        <div
          className="absolute top-[18px] -translate-x-1/2 font-mono text-[11px]"
          style={{ left: `${pct}%` }}
        >
          {Math.round(value)}
        </div>
      </div>
    </div>
  );
}
