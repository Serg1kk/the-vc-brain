// The /app shell — feature 09 (investor dashboard). A `route.tsx` file inside the
// `app/` directory is TanStack Router's file-based-routing layout convention: this
// route owns the `/app` path AND wraps every other file in this directory via
// `<Outlet />` (verified against @tanstack/router-generator's physical-router source
// — "route" is the configured `routeToken`, default and unchanged here).
//
// Feature 08's routes (`/apply*`, `/a/:token`, `/privacy`) live outside this
// directory and are untouched. The founder app has no navigation into `/app/*`.

import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ExplainPanelProvider } from "../../components/app/explain-panel";
import { Sidebar } from "../../components/app/sidebar";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [{ title: "The VC Brain — Investor dashboard" }, { name: "robots", content: "noindex" }],
  }),
  component: AppShell,
});

function AppShell() {
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
