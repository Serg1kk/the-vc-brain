import { useId, useRef, type ChangeEvent } from "react";
import { formatBytes } from "../lib/file";
import { MAX_EXTRA_COUNT, validateExtraFile } from "../lib/validation";

interface Props {
  files: File[];
  errors: Record<string, string>;
  onFiles: (files: File[]) => void;
  onErrors: (errors: Record<string, string>) => void;
}

export function ExtraFilesList({ files, errors, onFiles, onErrors }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function add(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    const nextErrors = { ...errors };
    const accepted: File[] = [];
    for (const f of chosen) {
      if (files.length + accepted.length >= MAX_EXTRA_COUNT) {
        nextErrors[f.name] = "You can add at most 3 extra files.";
        continue;
      }
      const err = validateExtraFile(f);
      if (err) {
        nextErrors[f.name] = err;
        continue;
      }
      accepted.push(f);
      delete nextErrors[f.name];
    }
    onFiles([...files, ...accepted]);
    onErrors(nextErrors);
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(name: string) {
    onFiles(files.filter((f) => f.name !== name));
    const next = { ...errors };
    delete next[name];
    onErrors(next);
  }

  return (
    <div>
      {files.length > 0 ? (
        <ul className="mb-2 space-y-2">
          {files.map((f) => (
            <li
              key={f.name}
              className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px]">{f.name}</p>
                <p className="text-[12px] text-[color:var(--color-text-muted)]">
                  {formatBytes(f.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(f.name)}
                className="rounded-[6px] px-2 py-1 text-[13px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {Object.entries(errors).map(([name, err]) => (
        <p key={name} className="mb-1 text-[13px]" style={{ color: "var(--color-warn)" }}>
          {name}: {err}
        </p>
      ))}
      {files.length < MAX_EXTRA_COUNT ? (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-[6px] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-1.5 text-[13px] font-medium hover:border-[color:var(--color-accent)]"
          >
            Add a file
          </button>
          <input
            ref={inputRef}
            id={id}
            type="file"
            multiple
            onChange={add}
            className="sr-only"
          />
        </>
      ) : null}
    </div>
  );
}
