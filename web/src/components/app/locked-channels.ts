// Honest disclosure content for locked source channels — brief §12.4,
// scoring-ux.md §5.6. Clicking a locked channel opens the same explain panel
// everything else uses (`chip: null` omits the "How it was produced" section, since
// nothing was computed) — never a bare "coming soon".

import type { ExplainPanelData } from "./explain-panel";

export type LockedChannelId = "linkedin" | "x" | "product_hunt";

export interface LockedChannelInfo {
  name: string;
  /** "What it would add" */
  what: string;
  /** "Why it is not here" */
  why: string;
}

export const LOCKED_CHANNELS: Record<LockedChannelId, LockedChannelInfo> = {
  linkedin: {
    name: "LinkedIn",
    what: "Employment history and role tenure, which would strengthen the domain-expertise signal and help resolve identity across sources.",
    why: "It needs an access path we would not take without permission.",
  },
  x: {
    name: "X",
    what: "Public communication signal. Hacker News author replies currently proxy this: a founder's replies in their own thread are a direct proxy for coachability that VCs normally only observe on a live call.",
    why: "API pricing makes per-candidate lookups uneconomical at this fund's volume, and the signal duplicated Hacker News in the pilot corpus.",
  },
  product_hunt: {
    name: "Product Hunt",
    what: "Consumer launch traction, if the fund's mandate ever includes consumer.",
    why: "Launch-day metrics are gameable and decay within a week; the pilot found no criterion they could support.",
  },
};

export function lockedChannelExplainData(id: LockedChannelId): ExplainPanelData {
  const info = LOCKED_CHANNELS[id];
  return {
    title: `${info.name} — not connected in this build`,
    what: `What it would add: ${info.what}`,
    chip: null,
    unknowns: [{ gap: "Why it is not here", closes: info.why }],
  };
}
