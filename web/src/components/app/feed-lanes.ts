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

/** Lane titles keyed for the feed's lane filter — same order and copy as
 * `bucketIntoLanes` renders, exported so the control doesn't hardcode a second copy
 * of the lane vocabulary. */
export const LANE_ORDER: LaneKey[] = [
  "exceptional",
  "in_thesis",
  "outside_thesis",
  "not_assessable",
  "not_yet_screened",
  "excluded",
];
export const LANE_TITLE: Record<LaneKey, string> = Object.fromEntries(
  LANE_ORDER.map((key) => [key, LANE_META[key].title]),
) as Record<LaneKey, string>;

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

  return LANE_ORDER.map((key) => ({ key, items: buckets[key], ...LANE_META[key] }));
}

// --- explicit sort control (operator request, 2026-07-19) ----------------------
//
// Reorders WITHIN a lane only — the thesis lens (which lane a row is in) is a
// deliberate, separate decision (scoring-ux.md §4.1: thesis fit is a claim about
// fit-to-mandate, not a claim about the company, and must never blend with a quality
// ranking). Sorting is always by exactly one named field, never a composite — the
// sponsor's do-not-average invariant applies to sort keys as much as to display.

export type SortKey = "default" | "founder_score" | "thesis_fit" | "freshness" | "company_az";

export const SORT_LABEL: Record<SortKey, string> = {
  default: "Lane order",
  founder_score: "Founder Score",
  thesis_fit: "Thesis fit",
  freshness: "Freshness",
  company_az: "Company A–Z",
};

/** NULLs sort last under every sort key, regardless of direction — the same rule
 * `api_founders`' own default order and the radar's obscurity ordering already
 * enforce. An absent score is not a low score, and a sort that put it first or
 * folded it in with real low scores would misrepresent the finding. */
function compareNullsLast(a: number | null, b: number | null, desc: boolean): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return desc ? b - a : a - b;
}

/** Returns a new array — never mutates the lane's own bucketed order, since
 * `sortKey === "default"` must fall back to exactly that order untouched. */
export function sortLaneItems(items: FeedItem[], sortKey: SortKey): FeedItem[] {
  if (sortKey === "default") return items;
  const sorted = items.slice();

  if (sortKey === "founder_score") {
    sorted.sort((a, b) =>
      compareNullsLast(
        a.founder?.score_assessed ? a.founder.founder_score : null,
        b.founder?.score_assessed ? b.founder.founder_score : null,
        true,
      ),
    );
  } else if (sortKey === "thesis_fit") {
    sorted.sort((a, b) =>
      compareNullsLast(a.application.thesis_fit, b.application.thesis_fit, true),
    );
  } else if (sortKey === "freshness") {
    sorted.sort((a, b) => {
      const av = new Date(a.founder?.first_seen_at ?? a.application.submitted_at).getTime();
      const bv = new Date(b.founder?.first_seen_at ?? b.application.submitted_at).getTime();
      return bv - av; // most recent first
    });
  } else if (sortKey === "company_az") {
    sorted.sort((a, b) => {
      const an = a.application.company_name;
      const bn = b.application.company_name;
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return an.localeCompare(bn);
    });
  }
  return sorted;
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

// --- instant client-side name/company search (operator request, 2026-07-19) -----
//
// A plain term like "Mila" isn't an attribute the NL resolver can map to anything
// queryable, so it came back with nothing resolved and fell through to "show
// everyone" — which reads as broken. This runs entirely in the browser against
// data already on screen, so it's free and instant; it never touches the model.

function nameMatchScore(item: FeedItem, q: string): number {
  const company = (item.application.company_name ?? "").toLowerCase();
  const founder = (item.founder?.full_name ?? "").toLowerCase();
  if (company.startsWith(q) || founder.startsWith(q)) return 2;
  if (company.includes(q) || founder.includes(q)) return 1;
  return 0;
}

/** Ranked by match quality first (starts-with beats contains), then by Founder
 * Score — nulls last, same rule as everywhere else a score can be absent. */
export function matchByName(items: FeedItem[], query: string): FeedItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items
    .map((item) => ({ item, score: nameMatchScore(item, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const af = a.item.founder?.score_assessed ? a.item.founder.founder_score : null;
      const bf = b.item.founder?.score_assessed ? b.item.founder.founder_score : null;
      return compareNullsLast(af, bf, true);
    })
    .map((x) => x.item);
}
