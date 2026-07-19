// The /app persistent left sidebar — brief §8.1.
//
// Deliberately light: this is shell structure, not the Feed screen. Source-filter
// chips (All · Inbound · Radar) live on the Feed screen itself, since they drive its
// query — duplicating that state here would fight the screen that owns it.

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { getTheses } from "@/lib/investor-api";
import { clearDashboardAuthentication } from "@/lib/dashboard-auth";
import { useExplainPanel } from "./explain-panel";
import { lockedChannelExplainData, type LockedChannelId } from "./locked-channels";

const LIVE_CHANNELS: Array<{ label: string }> = [{ label: "GitHub" }, { label: "Hacker News" }];

const LOCKED_CHANNELS: Array<{ id: LockedChannelId; label: string }> = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X" },
  { id: "product_hunt", label: "Product Hunt" },
];

export function Sidebar() {
  const { open } = useExplainPanel();

  const { data: thesisName } = useQuery({
    queryKey: ["investor", "active-thesis-name"],
    queryFn: async () => {
      const res = await getTheses({ filters: { active: "eq.true" }, limit: 1, select: "name" });
      return res.ok ? (res.data[0]?.name ?? null) : null;
    },
    staleTime: 60_000,
  });

  return (
    <aside className="sticky top-0 flex h-screen w-[240px] flex-none flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-5.5">
      {/* Brand hierarchy matches the intake form (PageShell.tsx): the fund's name
          leads, full text color; the product name is a smaller, muted line beneath
          it — this is a Maschmeyer Group tool named "The VC Brain", not the reverse. */}
      <Link to="/app/feed" className="px-5 pb-2.5">
        <span className="block text-[14px] font-medium tracking-[-0.01em] text-[color:var(--color-text)]">
          Maschmeyer Group
        </span>
        <span className="mt-0.5 block text-[11px] font-medium tracking-[0.02em] text-[color:var(--color-text-muted)]">
          The VC Brain
        </span>
      </Link>
      <div className="mx-5 mb-3.5 h-0.5 bg-[color:var(--color-text)]" />

      <Link
        to="/app/feed"
        activeProps={{ className: "bg-[color:var(--color-surface)]" }}
        className="block px-5 py-1.5 text-[13px] font-medium"
      >
        Feed
      </Link>
      {/* No route or data source exists for a watchlist yet (table has no writer) —
          shown as a static label so the sidebar structure matches the design without
          pretending a destination that isn't built. Visibly non-interactive (dimmed,
          not-allowed cursor) rather than merely unlinked — a label that looks
          clickable and isn't reads as broken; one that reads as "not in this build"
          reads as scoped. */}
      <div
        title="Not built in this version"
        className="cursor-not-allowed px-5 py-1.5 text-[13px] font-medium text-[color:var(--color-text-muted)] opacity-50"
      >
        Watchlist
      </div>

      <div className="mx-5 my-2.5 border-t border-[color:var(--color-border)]" />
      <div className="px-5 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        Source channels · 2 live, 3 documented
      </div>
      {LIVE_CHANNELS.map((ch) => (
        <Link
          key={ch.label}
          to="/app/feed"
          className="flex items-center gap-2 px-5 py-1 text-[13px]"
        >
          <span>{ch.label}</span>
          <span className="flex-1" />
          <span aria-hidden="true" className="font-mono text-[12px]">
            ✓
          </span>
        </Link>
      ))}
      {LOCKED_CHANNELS.map((ch) => (
        <button
          key={ch.id}
          type="button"
          onClick={() => open(lockedChannelExplainData(ch.id))}
          className={cn(
            "flex cursor-pointer items-center gap-2 px-5 py-1 text-left text-[13px] text-[color:var(--color-text-muted)]",
          )}
        >
          <span>{ch.label}</span>
          <span className="flex-1" />
          {/* A distinct lock glyph, not a greyed live checkmark — greyed reads as
              "temporarily unavailable"; this reads as "not connected". Never a
              count, not even 0 — zero implies "connected and empty". */}
          <svg aria-hidden="true" width="10" height="12" viewBox="0 0 10 12">
            <rect
              x="0.75"
              y="5.25"
              width="8.5"
              height="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      ))}

      <div className="flex-1" />
      <div className="mx-5 border-t border-[color:var(--color-border)] pt-3">
        <div className="text-[11px] text-[color:var(--color-text-muted)]">Active thesis</div>
        <Link
          to="/app/thesis"
          className="text-[13px] font-medium underline decoration-[color:var(--color-border)] underline-offset-[3px]"
        >
          {thesisName ?? "Configure thesis"}
        </Link>

        {/* Settings + Log out — the demo-grade login gate's other half (route.tsx). Grouped
            in this footer block rather than the top nav list: both are account-level utility,
            not content navigation. */}
        <div className="mt-3 border-t border-[color:var(--color-border)] pt-2.5">
          <Link to="/app/settings" className="block text-[13px] font-medium">
            Settings
          </Link>
          <button
            type="button"
            onClick={() => {
              clearDashboardAuthentication();
              window.location.reload();
            }}
            className="mt-1.5 block cursor-pointer text-left text-[13px] text-[color:var(--color-text-muted)]"
          >
            Log out
          </button>
        </div>
      </div>
    </aside>
  );
}
