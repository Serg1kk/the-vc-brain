// The four states of "we don't know" — brief §4.3, the highest-value detail in the
// product. Different things, must look different. None of the four may EVER render
// as 0, 0%, an empty bar, or a dash — an absent number and a low number are opposite
// findings.

import { cn } from "@/lib/utils";
import { VerdictBadge } from "./claim-badges";

// --- 1. Not assessed — no `scores` row exists for an axis --------------------

interface NotAssessedTrackProps {
  /** e.g. the `<axis>_insufficient_evidence` event's reason, when known. */
  reason?: string;
  className?: string;
}

/** A hatched track, never an empty or 0%-filled bar. Sorting must treat this as
 * absent, never as zero — that is a caller concern (the axis has no `value` to sort
 * on in the first place; see `investor-api.ts`'s `AxisScore.assessed`). */
export function NotAssessedTrack({ reason, className }: NotAssessedTrackProps) {
  const title = reason ? `Not assessed — ${reason}` : "Not assessed — no score row exists";
  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className={cn("track-hatch h-1 w-full", className)}
    />
  );
}

// --- 2. Not checked — the claim has no evidence rows at all -------------------

interface NotCheckedNoticeProps {
  what: string;
  /** What would trigger a check, when the system records that. */
  trigger?: string;
  className?: string;
}

export function NotCheckedNotice({ what, trigger, className }: NotCheckedNoticeProps) {
  return (
    <div className={cn("grid grid-cols-2 gap-x-4 text-[13.5px]", className)}>
      <span className="italic text-[color:var(--color-text-muted)]">{what}</span>
      {trigger ? (
        <span className="text-[12.5px] text-[color:var(--color-text-muted)]">
          would trigger a check: {trigger}
        </span>
      ) : null}
    </div>
  );
}

// --- 3. Searched, nothing found — a positive finding, must look like one ------
//
// The `claim_verification_attempted` event that would fully populate this state has
// zero rows today (its writer is unshipped). Render this component anyway and let it
// stay empty where there is nothing to show — a named, honestly-empty place is the
// behaviour the product argues for, not a bug to design around.

interface SearchedNothingFoundCardProps {
  /** e.g. "GitHub API · github.com/ayuhito/safehttp" */
  checked: string;
  checkedAt: string;
  lookingFor: string;
  result: string;
  onDetails?: () => void;
  className?: string;
}

export function SearchedNothingFoundCard({
  checked,
  checkedAt,
  lookingFor,
  result,
  onDetails,
  className,
}: SearchedNothingFoundCardProps) {
  return (
    <div className={cn("border border-[color:var(--color-border)] p-4", className)}>
      <div className="flex items-baseline gap-2.5">
        <span
          aria-hidden="true"
          className="inline-block h-[13px] w-[13px] translate-y-px rounded-full border-[1.5px] border-[color:var(--color-text)]"
        />
        <span className="text-[15px] font-medium">We looked and found nothing</span>
      </div>
      <dl className="mt-3 ml-[23px] grid grid-cols-[110px_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-[color:var(--color-text-muted)]">Checked</dt>
        <dd className="font-mono text-[12.5px]">{checked}</dd>
        <dt className="text-[color:var(--color-text-muted)]">When</dt>
        <dd className="font-mono text-[12.5px]">{checkedAt}</dd>
        <dt className="text-[color:var(--color-text-muted)]">Looking for</dt>
        <dd>{lookingFor}</dd>
        <dt className="text-[color:var(--color-text-muted)]">Result</dt>
        <dd>{result}</dd>
      </dl>
      <div className="mt-3 ml-[23px] flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] font-medium">This does not count against the founder.</span>
        {onDetails ? (
          <button
            type="button"
            onClick={onDetails}
            className="border border-[color:var(--color-border)] px-2 py-0.5 font-mono text-[11.5px] text-[color:var(--color-text-muted)]"
          >
            details
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface SearchedNothingFoundAggregateProps {
  count: number;
  /** e.g. "GitHub, no commit history available" */
  topic: string;
  className?: string;
}

/** When many claims share the same "nothing found" result (e.g. 74 of 103 rows on
 * one topic), collapse to one line — ninety-six identical cards is noise, not
 * transparency. */
export function SearchedNothingFoundAggregate({
  count,
  topic,
  className,
}: SearchedNothingFoundAggregateProps) {
  return (
    <div
      className={cn(
        "border border-t-0 border-[color:var(--color-border)] px-4.5 py-2.5 text-[13px] text-[color:var(--color-text-muted)]",
        className,
      )}
    >
      <span aria-hidden="true" className="font-mono text-[12px]">
        ⃝
      </span>{" "}
      Provenance: checked {count} claims across {topic}.
    </div>
  );
}

// --- 4. Not disclosed — verdict `missing`, never phrased as the founder's fault ---

interface NotDisclosedNoteProps {
  what: string;
  /** The stored `what_would_close_it` string, rendered verbatim. */
  closes: string;
  className?: string;
}

export function NotDisclosedNote({ what, closes, className }: NotDisclosedNoteProps) {
  return (
    <div className={cn("border-t border-[color:var(--color-border)] py-2.5", className)}>
      <div className="text-[13.5px] font-medium">
        {what} <VerdictBadge status="missing" className="ml-1.5" />
      </div>
      <div className="mt-1 max-w-[680px] text-[13px] text-[color:var(--color-text-muted)]">
        {closes}
      </div>
    </div>
  );
}
