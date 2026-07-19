import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export function PageShell({ children }: Props) {
  return (
    <div className="min-h-screen bg-[color:var(--color-bg)]">
      {/*
        Glass pill nav in the sponsor's palette, carrying the sponsor's name — an operator
        decision (Jul 19): this is a hackathon submission built FOR the Maschmeyer Group
        challenge, and showing the intake page in their brand is how you demonstrate what it
        would look like for them. It runs locally only and is never hosted, so it cannot be
        mistaken for their live product.
        Deliberately NOT restored from the generated version: the German site nav
        (Über uns / Fonds / Smart Money / Kontakt), which mimicked their actual site
        structure, and the "© Maschmeyer Group" footer, which is a legal assertion rather
        than branding. The footer names the product instead.
      */}
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
            className="pr-2 text-[15px] font-medium tracking-[-0.01em] text-[color:var(--color-text)]"
          >
            Maschmeyer Group
          </Link>

          <span className="pr-4 text-[13px] text-[color:var(--color-text-muted)]">
            Pre-seed applications
          </span>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[720px] px-6 pb-16 pt-12">
        {children}
        <footer className="mt-20 border-t pt-6 text-[12px] text-[color:var(--color-text-muted)]">
          <div className="flex items-center justify-between">
            <span>The VC Brain</span>
            <Link to="/privacy" className="hover:text-[color:var(--color-text)]">
              Privacy
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
