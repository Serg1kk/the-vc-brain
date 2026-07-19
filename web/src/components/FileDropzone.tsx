import { useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { formatBytes } from "../lib/file";

interface Props {
  file: File | null;
  onFile: (file: File | null) => void;
  accept: string;
  error?: string | null;
  label: string;
  hint?: string;
  id?: string;
}

export function FileDropzone({ file, onFile, accept, error, label, hint, id }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    onFile(f);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0] ?? null;
    if (f) onFile(f);
  }

  return (
    <div>
      <label htmlFor={inputId} className="block">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
          {hint}
        </p>
      ) : null}
      {!file ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="mt-2 rounded-md border border-dashed p-6 text-center transition-colors"
          style={{
            borderColor: dragOver ? "var(--color-accent)" : "var(--color-border)",
            background: dragOver ? "color-mix(in oklab, var(--color-accent) 6%, transparent)" : "transparent",
          }}
        >
          <p className="text-[14px] text-[color:var(--color-text-muted)]">
            Drop your file here, or
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-2 rounded-[6px] border border-[color:var(--color-border)] bg-white px-3 py-1.5 text-[13px] font-medium hover:border-[color:var(--color-accent)]"
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            onChange={onChange}
            className="sr-only"
            aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
          />
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-[color:var(--color-border)] bg-white px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[14px] text-[color:var(--color-text)]">{file.name}</p>
            <p className="text-[12px] text-[color:var(--color-text-muted)]">{formatBytes(file.size)}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="rounded-[6px] px-2 py-1 text-[13px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"
          >
            Remove
          </button>
        </div>
      )}
      {error ? (
        <p id={errorId} className="mt-1.5 text-[13px]" style={{ color: "var(--color-warn)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
