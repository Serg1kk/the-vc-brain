interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorNotice({ message, onRetry }: Props) {
  return (
    <div role="alert" className="ms-rule">
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
