interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorNotice({ message, onRetry }: Props) {
  return (
    <div
      role="alert"
      className="rounded-md border p-4"
      style={{ borderColor: "var(--color-warn)", background: "color-mix(in oklab, var(--color-warn) 8%, transparent)" }}
    >
      <p className="text-[14px] text-[color:var(--color-text)]">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-[13px] font-medium text-[color:var(--color-accent)] hover:underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
