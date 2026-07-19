// The /app shell — feature 09 (investor dashboard). A `route.tsx` file inside the
// `app/` directory is TanStack Router's file-based-routing layout convention: this
// route owns the `/app` path AND wraps every other file in this directory via
// `<Outlet />` (verified against @tanstack/router-generator's physical-router source
// — "route" is the configured `routeToken`, default and unchanged here).
//
// Feature 08's routes (`/apply*`, `/a/:token`, `/privacy`) live outside this
// directory and are untouched. The founder app has no navigation into `/app/*`.

import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { ExplainPanelProvider } from "../../components/app/explain-panel";
import { Sidebar } from "../../components/app/sidebar";
import {
  dashboardCredentials,
  isDashboardAuthenticated,
  markDashboardAuthenticated,
} from "../../lib/dashboard-auth";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [{ title: "The VC Brain — Investor dashboard" }, { name: "robots", content: "noindex" }],
  }),
  component: AppShell,
});

function AppShell() {
  // Demo-grade login gate (operator request, 2026-07-19) — see lib/dashboard-auth.ts for what
  // this is and is not: a client-side speed bump, not real auth. `authed` starts false on both
  // the server render and the first client render (sessionStorage is unreadable on the server),
  // then a mount effect reads the real value. An already-logged-in investor briefly sees the
  // login screen flash on a hard reload as a result — acceptable, per the spec this gate is
  // built against ("a page reload may re-prompt — that is fine").
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(isDashboardAuthenticated());
  }, []);

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  return (
    <ExplainPanelProvider>
      <div className="flex min-h-screen bg-[color:var(--color-bg)] text-[15px] leading-[1.6]">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </ExplainPanelProvider>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { user, password: expected } = dashboardCredentials();
    if (username === user && password === expected) {
      markDashboardAuthenticated();
      onSuccess();
      return;
    }
    setError("Incorrect username or password.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg)] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[360px] border border-[color:var(--color-border)] px-7 py-8"
      >
        <span className="block text-[14px] font-medium tracking-[-0.01em] text-[color:var(--color-text)]">
          Maschmeyer Group
        </span>
        <span className="mt-0.5 block text-[11px] font-medium tracking-[0.02em] text-[color:var(--color-text-muted)]">
          The VC Brain
        </span>
        <div className="ms-rule mt-3 mb-5" />

        <label className="block">
          <span className="text-[13px]">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="mt-1.5 block w-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-[7px] text-[14px]"
          />
        </label>
        <label className="mt-3.5 block">
          <span className="text-[13px]">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1.5 block w-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-[7px] text-[14px]"
          />
        </label>

        {error ? (
          <div className="mt-3.5 border border-[color:var(--color-text)] px-3.5 py-2.5 text-[13px]">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          className="mt-5 w-full cursor-pointer border-none bg-[color:var(--color-accent)] px-[22px] py-[11px] text-[14px] font-medium text-white"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
