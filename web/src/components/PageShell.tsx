import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  return (
    <div className="min-h-screen bg-[color:var(--color-bg)]">
      <div className="mx-auto w-full max-w-[640px] px-6 py-10">
        <Link
          to="/apply"
          className="text-[13px] font-semibold tracking-[0.02em] text-[color:var(--color-text)] hover:text-[color:var(--color-accent)]"
        >
          The VC Brain
        </Link>
        <div className="mt-8">{children}</div>
        <footer className="mt-16 border-t border-[color:var(--color-border)] pt-4 text-[12px] text-[color:var(--color-text-muted)]">
          <Link to="/privacy" className="hover:text-[color:var(--color-text)]">
            Privacy
          </Link>
        </footer>
      </div>
    </div>
  );
}
