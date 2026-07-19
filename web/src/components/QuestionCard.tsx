import { useEffect, useId, useRef } from "react";
import type { GapQuestion } from "../lib/types";

interface Props {
  question: GapQuestion;
  value: string;
  onChange: (v: string) => void;
  index: number;
  total: number;
}

const SOFT_CAP = 2000;
const COUNTER_THRESHOLD = 800;

export function QuestionCard({ question, value, onChange, index, total }: Props) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 24;
    const min = lineHeight * 3;
    const max = lineHeight * 10;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`;
  }, [value]);

  const showCounter = value.length > COUNTER_THRESHOLD;

  return (
    <section
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-5"
      aria-labelledby={`${id}-q`}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-text-muted)]">
        Question {index + 1} of {total}
      </p>
      <label
        id={`${id}-q`}
        htmlFor={id}
        className="mt-2 block text-[16px] font-normal text-[color:var(--color-text)]"
        style={{ fontWeight: 500 }}
      >
        {question.question}
      </label>
      <p className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
        <span className="mr-1 uppercase tracking-[0.08em]" style={{ fontSize: 11 }}>
          Why we're asking —
        </span>
        {question.why}
      </p>
      <textarea
        ref={ref}
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, SOFT_CAP))}
        placeholder={question.placeholder}
        className="mt-3 w-full resize-none rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-[14px] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {showCounter ? (
        <p className="mt-1 text-right text-[12px] text-[color:var(--color-text-muted)]">
          {value.length} / {SOFT_CAP}
        </p>
      ) : null}
    </section>
  );
}
