import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  return (
    <div className="min-h-screen bg-[color:var(--color-bg)]">
      {/* Glass pill nav — matches maschmeyer-group.de */}
      <header className="sticky top-4 z-40 px-4">
        <nav
          className="mx-auto flex h-[56px] max-w-[1120px] items-center justify-between rounded-full border pl-6 pr-2 backdrop-blur-xl"
          style={{
            background: "rgba(241, 238, 232, 0.75)",
            borderColor: "rgba(10,15,60,0.10)",
            boxShadow: "0 1px 2px rgba(10,15,60,0.04), 0 8px 24px -12px rgba(10,15,60,0.12)",
          }}
        >
          <Link
            to="/apply"
            className="text-[15px] font-medium tracking-[-0.01em] text-[color:var(--color-text)]"
          >
            Maschmeyer Group
          </Link>

          <div className="hidden items-center gap-10 text-[14px] text-[color:var(--color-text)] md:flex">
            <span>Über uns</span>
            <span>Fonds</span>
            <span>Smart Money</span>
          </div>

          <span
            className="inline-flex items-center rounded-full px-5 py-2 text-[14px] font-medium"
            style={{
              background: "var(--color-lavender)",
              color: "var(--color-text)",
            }}
          >
            Kontakt
          </span>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[720px] px-6 pb-16 pt-12">
        {children}
        <footer className="mt-20 border-t pt-6 text-[12px] text-[color:var(--color-text-muted)]">
          <div className="flex items-center justify-between">
            <span>© Maschmeyer Group</span>
            <Link to="/privacy" className="hover:text-[color:var(--color-text)]">
              Privacy
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
