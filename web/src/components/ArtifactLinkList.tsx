import { useId, useState } from "react";
import { MAX_LINK_COUNT, validateLinkUrl } from "../lib/validation";

interface Props {
  values: string[];
  onChange: (next: string[]) => void;
}

export function ArtifactLinkList({ values, onChange }: Props) {
  const baseId = useId();
  const [errors, setErrors] = useState<Record<number, string | null>>({});

  function update(i: number, v: string) {
    const next = values.slice();
    next[i] = v;
    onChange(next);
  }

  function remove(i: number) {
    const next = values.slice();
    next.splice(i, 1);
    onChange(next.length ? next : [""]);
    setErrors({});
  }

  function add() {
    if (values.length >= MAX_LINK_COUNT) return;
    onChange([...values, ""]);
  }

  return (
    <div>
      <div className="space-y-2">
        {values.map((v, i) => {
          const id = `${baseId}-${i}`;
          const err = errors[i];
          return (
            <div key={i}>
              <div className="flex gap-2">
                <input
                  id={id}
                  type="url"
                  inputMode="url"
                  value={v}
                  onChange={(e) => update(i, e.target.value)}
                  onBlur={() => setErrors((prev) => ({ ...prev, [i]: validateLinkUrl(v) }))}
                  placeholder="https://github.com/you/project"
                  className="flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-[14px] focus:border-[color:var(--color-accent)] focus:outline-none"
                  aria-invalid={err ? "true" : undefined}
                  aria-describedby={err ? `${id}-err` : undefined}
                />
                {values.length > 1 || v ? (
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="rounded-[6px] px-2 py-1 text-[13px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {err ? (
                <p id={`${id}-err`} className="mt-1 text-[13px]" style={{ color: "var(--color-warn)" }}>
                  {err}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {values.length < MAX_LINK_COUNT ? (
        <button
          type="button"
          onClick={add}
          className="mt-2 text-[13px] font-medium text-[color:var(--color-accent)] hover:underline"
        >
          Add another link
        </button>
      ) : null}
    </div>
  );
}
