// Pure lane-bucketing, sorting and copy helpers for the ranked feed (brief §8.3) —
// kept out of the row markup so the thesis-lens rules are a small set of testable
// functions rather than tangled into JSX.

import type { ApplicationRow, FounderRow } from "@/lib/investor-api";

/**
 * `api_applications` exposes `is_synthetic` directly on the live view (verified over
 * REST 2026-07-19 — the brief's own instruction: "use that column for the badge, do
 * not join through api_founders") but the column predates the `ApplicationRow`
 * interface in investor-api.ts. Extending locally rather than forking the foundation
 * file for one field already present on the wire — flagged to the owner to fold into
 * the canonical type.
 */
export interface FeedApplicationRow extends ApplicationRow {
  is_synthetic: boolean;
}

export interface FeedItem {
  application: FeedApplicationRow;
  founder: FounderRow | null;
}

export type LaneKey =
  | "exceptional"
  | "in_thesis"
  | "outside_thesis"
  | "not_assessable"
  | "not_yet_screened"
  | "excluded";

export interface Lane {
  key: LaneKey;
  title: string;
  note: string;
  items: FeedItem[];
}

const LANE_META: Record<LaneKey, { title: string; note: string }> = {
  exceptional: {
    title: "Off-thesis but exceptional",
    note: "Outside the stated mandate, but the founder scores in the top band. Shown so a strong founder is never silently filtered out.",
  },
  in_thesis: { title: "In thesis", note: "Passed the fund's mandate rules." },
  outside_thesis: {
    title: "Outside thesis",
    note: "Does not match the stated mandate — not a quality judgement.",
  },
  not_assessable: {
    title: "Not yet assessable",
    note: "The thesis gate ran but couldn't assess enough of the application to reach a verdict.",
  },
  not_yet_screened: {
    title: "Not yet screened",
    note: "The thesis gate hasn't run against this application yet.",
  },
  excluded: {
    title: "Excluded",
    note: "A hard mandate rule fired on a confirmed match — this is rare by construction.",
  },
};

function byThesisFitDesc(a: FeedItem, b: FeedItem): number {
  const av = a.application.thesis_fit;
  const bv = b.application.thesis_fit;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return bv - av;
}

function byCoverageDesc(a: FeedItem, b: FeedItem): number {
  const av = a.application.thesis_coverage;
  const bv = b.application.thesis_coverage;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return bv - av;
}

function bySubmittedDesc(a: FeedItem, b: FeedItem): number {
  const av = a.application.submitted_at;
  const bv = b.application.submitted_at;
  return av < bv ? 1 : av > bv ? -1 : 0;
}

/**
 * The thesis lens — brief §8.3, frozen spec. Lane 3 removes matching rows from
 * lane 2, never duplicates them. An absent `founder_score` excludes a row from lane 3
 * *without implying a low score* (§8.3's own warning) — gated on `score_assessed`,
 * never on a numeric fallback like `?? 0`.
 *
 * `thesis_verdict` is NULL, not one of the four documented values, for any
 * application the thesis gate has never run against at all — 126 of 359 live rows on
 * 2026-07-19. That is a different finding from `insufficient_evidence` (the gate ran
 * and couldn't reach a verdict), so it gets its own lane rather than being folded into
 * the closest-looking documented state.
 */
export function bucketIntoLanes(items: FeedItem[], exceptionalMinValue: number): Lane[] {
  const buckets: Record<LaneKey, FeedItem[]> = {
    exceptional: [],
    in_thesis: [],
    outside_thesis: [],
    not_assessable: [],
    not_yet_screened: [],
    excluded: [],
  };

  for (const item of items) {
    const verdict = item.application.thesis_verdict;
    const founderScore = item.founder?.founder_score ?? null;
    const founderAssessed = item.founder?.score_assessed ?? false;

    if (verdict === "passed") {
      buckets.in_thesis.push(item);
    } else if (verdict === "borderline") {
      if (founderAssessed && founderScore != null && founderScore >= exceptionalMinValue) {
        buckets.exceptional.push(item);
      } else {
        buckets.outside_thesis.push(item);
      }
    } else if (verdict === "insufficient_evidence") {
      buckets.not_assessable.push(item);
    } else if (verdict === "failed") {
      buckets.excluded.push(item);
    } else {
      buckets.not_yet_screened.push(item);
    }
  }

  buckets.exceptional.sort(byThesisFitDesc);
  buckets.in_thesis.sort(byThesisFitDesc);
  buckets.outside_thesis.sort(byThesisFitDesc);
  buckets.not_assessable.sort(byCoverageDesc);
  buckets.not_yet_screened.sort(bySubmittedDesc);
  buckets.excluded.sort(bySubmittedDesc);

  const order: LaneKey[] = [
    "exceptional",
    "in_thesis",
    "outside_thesis",
    "not_assessable",
    "not_yet_screened",
    "excluded",
  ];
  return order.map((key) => ({ key, items: buckets[key], ...LANE_META[key] }));
}

/**
 * §8.2's "one-line description" has no dedicated column on `api_applications` — the
 * closest real fields are the radar candidate's own show-post title (194 of 200
 * `radar_activated` rows carry `artifact_links.title` live), the intake `category`
 * (thin on inbound rows), or the domain. Never fabricate a summary; fall through to
 * an honest absence.
 */
export function feedRowDescription(app: FeedApplicationRow): string | null {
  const links = app.artifact_links as { title?: unknown } | null;
  const title = links && typeof links === "object" ? links.title : undefined;
  if (typeof title === "string" && title.trim()) return title.trim();
  if (app.category) return app.category;
  if (app.company_domain) return app.company_domain;
  return null;
}

interface GapCodeInfo {
  label: string;
  closes: string;
}

// The vocabulary observed live on the one currently-assessed `score_market` row
// (2026-07-19) plus its siblings named in data-contracts.md §12. Unrecognised codes
// fall through to a generic, still-honest sentence rather than a raw code string.
const GAP_CODES: Record<string, GapCodeInfo> = {
  gap_growth: {
    label: "Market growth",
    closes: "No dated news events were found to compute a market trend.",
  },
  gap_why_now: {
    label: "Why now",
    closes: "No timing rationale (why this market, why now) was found in the evidence.",
  },
  gap_size_bottom_up: {
    label: "Bottom-up market size",
    closes: "No bottom-up TAM inputs (ARPU, buyer count) were found.",
  },
  gap_size_top_down: {
    label: "Top-down market size",
    closes: "No top-down market-size figure was found.",
  },
  no_thesis_geography: {
    label: "Geography scope",
    closes: "This application's geography isn't in the thesis's configured search scope.",
  },
  search_failed: {
    label: "Market search",
    closes: "The market search did not return usable results.",
  },
  thin_category_signal: {
    label: "Category signal",
    closes: "Too few sources on this category to size it with confidence.",
  },
};

export function gapCodeInfo(code: string): GapCodeInfo {
  return (
    GAP_CODES[code] ?? {
      label: code.replace(/_/g, " "),
      closes: "Additional evidence for this has not been collected yet.",
    }
  );
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
