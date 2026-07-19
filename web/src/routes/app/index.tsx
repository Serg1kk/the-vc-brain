// `/app` → `/app/feed`. brief §1: "/app — redirect to /app/feed". A `beforeLoad`
// redirect (not a render-time <Navigate>) means the redirect happens before
// anything paints — no flash of an empty shell.

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/")({
  beforeLoad: () => {
    throw redirect({ to: "/app/feed", replace: true });
  },
});
