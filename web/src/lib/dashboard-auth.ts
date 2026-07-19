// Demo-grade login gate for /app/* — operator request, 2026-07-19. See the long comment on
// AppShell in routes/app/route.tsx for how this is wired in.
//
// This is NOT real authentication. `VITE_`-prefixed env vars are inlined into the built JS
// bundle by Vite at build time, so the credentials below are readable by anyone who opens
// devtools on the shipped site — this keeps out a casual visitor, it does not protect data
// from a determined one. Real auth (a backend session + Postgres RLS) is post-MVP; no auth
// backend exists yet (lovable-brief.md §1: "No authentication of any kind" was the original
// brief for this feature — this gate is a later, explicit exception, not a contradiction of it).
//
// Founder-side routes (/apply*, /a/:token, /privacy) never import this file — they live
// outside the app/ directory and are never wrapped by the gate.

const STORAGE_KEY = "vcbrain_auth";

const DEFAULT_USER = "investor";
const DEFAULT_PASSWORD = "maschmeyer";

// `.env.example` ships these two vars present but empty (never commit a real default secret) —
// a plain `??` only catches `undefined`, not `""`, so a copied-but-unfilled `.env` would
// silently require blank-string credentials instead of falling back. Treat empty the same as
// unset.
function envOrDefault(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

export function dashboardCredentials(): { user: string; password: string } {
  return {
    user: envOrDefault(import.meta.env.VITE_DASHBOARD_USER as string | undefined, DEFAULT_USER),
    password: envOrDefault(
      import.meta.env.VITE_DASHBOARD_PASSWORD as string | undefined,
      DEFAULT_PASSWORD,
    ),
  };
}

export function isDashboardAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(STORAGE_KEY) === "1";
}

export function markDashboardAuthenticated(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, "1");
}

export function clearDashboardAuthentication(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}
