// The ranked deal feed — brief §8. The product's default screen: "which five of
// these forty do I open?" Radar candidates and inbound applications are one feed with
// source as a filter, never two screens (scoring-ux.md §7) — the schema already
// unified them and re-splitting at the UI layer would hide the product's best story.

import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  getApplications,
  getFounders,
  getTheses,
  type ApiError,
  type ApplicationKind,
  type FounderRow,
} from "@/lib/investor-api";
import { useExplainPanel, type ExplainPanelData } from "@/components/app/explain-panel";
import { ProvenanceChip, type ProvenanceKind } from "@/components/app/provenance-chip";
import { FeedRow, ROW_GRID } from "@/components/app/feed-row";
import { NlSearchPanel } from "@/components/app/nl-search";
import {
  bucketIntoLanes,
  chunk,
  type FeedApplicationRow,
  type FeedItem,
} from "@/components/app/feed-lanes";

export const Route = createFileRoute("/app/feed")({
  head: () => ({ meta: [{ title: "Feed — The VC Brain" }] }),
  component: Feed,
});

const DEFAULT_EXCEPTIONAL_MIN = 75;

const AXIS_HEADER: Array<{
  key: string;
  letter: string;
  label: string;
  chip: ProvenanceKind;
  what: string;
}> = [
  {
    key: "founder",
    letter: "F",
    label: "Founder",
    chip: "rule_on_model",
    what: "Combines this founder's persistent Founder Score with founder-market-fit and competitor knowledge for this application. Not the same object as the Founder Score itself, which lives in Memory and never resets.",
  },
  {
    key: "market",
    letter: "M",
    label: "Market",
    chip: "model",
    what: "A model judgement of category, size and trend, evaluated against retrieved evidence — never recalled from the model's training data.",
  },
  {
    key: "idea",
    letter: "I",
    label: "Idea-vs-Market",
    chip: "model",
    what: "A model judgement of how defensible this product is, based on switching cost, competitor threat level and displaced status quo found in evidence.",
  },
  {
    key: "trust",
    letter: "T",
    label: "Trust",
    chip: "rule",
    what: "A per-claim rollup computed from evidence structure, never from a model's own confidence. This screen doesn't read a per-application trust number yet — open a company's Evidence tab for the per-claim ledger.",
  },
];

const KIND_FILTERS: Array<{ value: ApplicationKind | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "inbound", label: "Inbound" },
  { value: "radar_activated", label: "Radar" },
];

interface FeedState {
  items: FeedItem[] | null;
  exceptionalMinValue: number;
  thesisName: string | null;
}

function useFeedData() {
  const [state, setState] = useState<FeedState>({
    items: null,
    exceptionalMinValue: DEFAULT_EXCEPTIONAL_MIN,
    thesisName: null,
  });
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProgress(10);
    setError(null);

    const [appsRes, thesisRes] = await Promise.all([
      getApplications({ order: "submitted_at.desc", limit: 1000 }),
      getTheses({ filters: { active: "eq.true" }, limit: 1 }),
    ]);
    setProgress(50);

    if (!appsRes.ok) {
      // Previously loaded rows stay on screen (brief §12.3) — only the error updates.
      setError(appsRes.error);
      setLoading(false);
      return;
    }

    const applications = appsRes.data as FeedApplicationRow[];
    const activeThesis = thesisRes.ok ? thesisRes.data[0] : undefined;
    const exceptionalMinValue =
      activeThesis?.config?.exceptional_lane?.min_value ?? DEFAULT_EXCEPTIONAL_MIN;
    const thesisName = activeThesis?.name ?? null;

    // Founder identity is a client-side join keyed on `company_id`, not
    // `application_id` — `api_founders.application_id` is only "the company's most
    // recent application", so filtering by application id silently drops the
    // founder for every older or duplicate application of the same company (an HN
    // re-scan can create several application rows per company_id in this corpus).
    // Batched in chunks to stay well under any URL-length ceiling.
    const companyIds = Array.from(new Set(applications.map((a) => a.company_id)));
    const founderChunks = chunk(companyIds, 100);
    const founderResults = await Promise.all(
      founderChunks.map((ids) => getFounders({ filters: { company_id: `in.(${ids.join(",")})` } })),
    );
    setProgress(90);

    const founderByCompany = new Map<string, FounderRow>();
    for (const r of founderResults) {
      if (!r.ok) continue; // Founder identity is enrichment, not a hard dependency —
      // degrade to "Founder not yet identified" for the affected rows rather than
      // failing the whole feed on a non-critical join.
      for (const f of r.data) {
        if (f.company_id && !founderByCompany.has(f.company_id))
          founderByCompany.set(f.company_id, f);
      }
    }

    const items: FeedItem[] = applications.map((a) => ({
      application: a,
      founder: founderByCompany.get(a.company_id) ?? null,
    }));

    setState({ items, exceptionalMinValue, thesisName });
    setProgress(100);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, loading, progress, error, retry: load };
}

function Feed() {
  const { items, exceptionalMinValue, thesisName, loading, progress, error, retry } = useFeedData();
  const { open } = useExplainPanel();
  const [kindFilter, setKindFilter] = useState<ApplicationKind | "all">("all");
  const [searchActive, setSearchActive] = useState(false);

  function openAxisHeader(axis: (typeof AXIS_HEADER)[number]) {
    const data: ExplainPanelData = { title: axis.label, what: axis.what, chip: axis.chip };
    open(data);
  }

  // --- full-screen states -------------------------------------------------------

  if (items === null && loading) {
    return (
      <div className="px-9 py-7">
        <h1 className="text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">Feed</h1>
        <div className="ms-rule mt-3.5" />
        <div className="mt-6">
          <div className="h-[3px] w-full bg-[color:var(--color-track)]">
            <div
              className="h-full bg-[color:var(--color-text)] transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-[13px] text-[color:var(--color-text-muted)]">
            Loading applications…
          </p>
        </div>
      </div>
    );
  }

  if (items === null && error) {
    return (
      <div className="px-9 py-7">
        <h1 className="text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">Feed</h1>
        <div className="ms-rule mt-3.5" />
        <div className="mt-6 flex items-baseline justify-between gap-4 border border-[color:var(--color-border)] p-4">
          <span className="text-[14px]">{error.message}</span>
          <button
            type="button"
            onClick={() => void retry()}
            className="shrink-0 cursor-pointer border border-[color:var(--color-border)] px-3 py-1 text-[13px] font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const allItems = items ?? [];
  const filteredItems = allItems.filter(
    (i) => kindFilter === "all" || i.application.kind === kindFilter,
  );
  const lanes = bucketIntoLanes(filteredItems, exceptionalMinValue);
  const newCount = allItems.filter(
    (i) => Date.now() - new Date(i.application.submitted_at).getTime() < 24 * 3600 * 1000,
  ).length;

  return (
    <div className="px-9 pt-7 pb-16">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">Feed</h1>
        <span className="font-mono text-[12px] text-[color:var(--color-text-muted)]">
          {newCount} new in the last 24h · {allItems.length} total
        </span>
        <span className="flex-1" />
        <span className="text-[13px] text-[color:var(--color-text-muted)]">
          Lens:{" "}
          <span className="font-mono text-[12px] text-[color:var(--color-text)]">
            {thesisName ?? "default"}
          </span>
        </span>
      </div>
      <div className="ms-rule mt-3.5" />

      {error ? (
        <div className="mt-3 flex items-baseline justify-between gap-4 border border-[color:var(--color-border)] p-3 text-[13px]">
          <span>Couldn't refresh: {error.message}</span>
          <button
            type="button"
            onClick={() => void retry()}
            className="shrink-0 cursor-pointer border border-[color:var(--color-border)] px-2.5 py-0.5 font-medium"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Source is a filter over one feed, not three sidebar destinations — the
          sidebar deliberately leaves this to the screen that owns the query
          (see sidebar.tsx's own comment). */}
      <div className="mt-4 flex gap-1.5">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setKindFilter(f.value)}
            className="cursor-pointer border px-3 py-1 text-[12.5px] font-medium"
            style={{
              borderColor: "var(--color-border)",
              backgroundColor: kindFilter === f.value ? "var(--color-surface)" : "transparent",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <NlSearchPanel onActiveChange={setSearchActive} className="mt-3" />

      {!searchActive ? (
        <>
          <div
            className={`mt-4 grid ${ROW_GRID} items-center gap-x-3 px-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-[color:var(--color-text-muted)]`}
          >
            <span />
            <span>COMPANY</span>
            <span />
            <span>COVERAGE · FIT</span>
            <span className="grid grid-cols-4 gap-2">
              {AXIS_HEADER.map((axis) => (
                <button
                  key={axis.key}
                  type="button"
                  onClick={() => openAxisHeader(axis)}
                  title={`${axis.label} — how this axis is computed`}
                  className="flex cursor-pointer items-center gap-1 text-left"
                >
                  {axis.letter} <ProvenanceChip kind={axis.chip} />
                </button>
              ))}
            </span>
            <span>SOURCE</span>
            <span>SEEN</span>
          </div>

          {allItems.length === 0 ? (
            <div className="border border-[color:var(--color-border)] p-6 text-[14px]">
              No applications yet.
              <div className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
                New candidates arrive from inbound applications and the outbound radar scan — check
                back once a scan has run.
              </div>
            </div>
          ) : (
            lanes.map((lane) =>
              lane.items.length === 0 && lane.key !== "exceptional" ? null : (
                <div key={lane.key} className="mt-2">
                  <div className="flex items-baseline gap-3 px-2 pt-2 pb-1.5">
                    <span className="text-[11.5px] font-semibold tracking-[0.08em] uppercase">
                      {lane.title}
                    </span>
                    <span className="text-[12px] text-[color:var(--color-text-muted)]">
                      {lane.note}
                    </span>
                  </div>
                  {lane.items.length === 0 ? (
                    <div className="border-t border-[color:var(--color-border)] px-2 py-3 text-[12.5px] text-[color:var(--color-text-muted)] italic">
                      No off-thesis founders currently score in the exceptional band. This lane
                      fills as founder scores accrue.
                    </div>
                  ) : (
                    lane.items.map((item) => (
                      <FeedRow key={item.application.application_id} item={item} />
                    ))
                  )}
                </div>
              ),
            )
          )}
        </>
      ) : null}
    </div>
  );
}
