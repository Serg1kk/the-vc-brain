// The fund thesis configuration form — brief §11. Its existence is a sponsor
// requirement: the system must not be hardcoded to one fund's mandate.
//
// Publishing is versioned, never a "Save" — every change writes a new immutable
// `theses` row and activates it via the INSERT-inactive-then-RPC protocol (brief §6,
// data-contracts.md §7). Getting that protocol wrong is a guaranteed error; see the
// long comment on `publishThesisVersion` in investor-api.ts for what was verified live
// against the database on 2026-07-19 and why the RPC parameter had to be `p_thesis_id`.
//
// Two fields are the ones a generated form gets wrong (design.md §1.2, §1.3):
// `mandate.geographies` (region codes: EU/US/UK/…) compiles into the M_geography rule
// and IS applied to scoring; the separate top-level `geos` (ISO country codes) does
// nothing for the rules but IS read at runtime by market research to build search
// queries. They are not the same field wearing two labels — rendering only one of
// them (as the visual export mock does) silently drops the other from the form.

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  getTheses,
  publishThesisVersion,
  type ThesisConfig,
  type ThesisRow,
  type ThesisRule,
  type ThesisRuleExpr,
} from "@/lib/investor-api";

export const Route = createFileRoute("/app/thesis")({
  head: () => ({
    meta: [{ title: "Thesis configuration — The VC Brain" }, { name: "robots", content: "noindex" }],
  }),
  component: ThesisConfigScreen,
});

// ---------------------------------------------------------------------------
// Closed vocabularies — design.md §1.1, §1.2. Not guessed: these are the exact
// value sets the thesis-gate compiler and the extractor use; offering anything
// else in the form would silently produce a rule that never matches.
// ---------------------------------------------------------------------------

const SECTOR_OPTIONS = [
  "b2b-software",
  "ai-infra",
  "devtools",
  "fintech",
  "healthtech",
  "consumer",
  "marketplace",
  "gambling",
  "adtech",
  "other",
] as const;

// `mandate.geographies` — REGION codes, not country codes. Distinct from `geos`
// below (ISO-3166 country codes) — see file header.
const REGION_OPTIONS = ["EU", "US", "UK", "APAC", "LATAM", "MEA", "other"] as const;

const STAGE_OPTIONS = ["pre_seed", "seed"] as const;

const FIELD_OPTIONS = [
  "sector",
  "business_model",
  "geography_country",
  "geography_region",
  "stage",
  "stage_evidence",
  "_text",
] as const;

const OP_OPTIONS = ["eq", "in", "gte", "lte", "contains", "exists"] as const;

const AXIS_OPTIONS = ["founder_score", "founder", "market", "idea_vs_market", "trust", "thesis_fit"] as const;
const AGGREGATE_OPTIONS = ["max", "mean", "min"] as const;

// ---------------------------------------------------------------------------
// Small form primitives — plain elements matching this feature's established
// borders-not-shadows, squared-buttons aesthetic (brief §7). Not the shadcn
// `components/ui/button|input` primitives: those ship `shadow-sm` and
// `rounded-md`, which this feature's brief explicitly bans ("no card shadows",
// "buttons squared, never pill") — every other component/app/* file already
// hand-rolls its own elements for the same reason.
// ---------------------------------------------------------------------------

function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div>
      <span className="text-[13.5px] text-[color:var(--color-text-muted)]">{children}</span>
      {hint ? <span className="mt-0.5 block text-[11px] text-[color:var(--color-text-muted)]">{hint}</span> : null}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-[7px] font-mono text-[12.5px]",
        props.className,
      )}
    />
  );
}

function Select({
  children,
  className,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cn(
        "border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-[7px] font-sans text-[13px]",
        className,
      )}
    >
      {children}
    </select>
  );
}

function ChipToggleGroup({
  options,
  selected,
  onChange,
}: {
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(on ? selected.filter((s) => s !== opt) : [...selected, opt])}
            className={cn(
              "border px-2 py-1 font-mono text-[12px]",
              on
                ? "border-[color:var(--color-text)] bg-[color:var(--color-surface)] text-[color:var(--color-text)]"
                : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)]",
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function ChipInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="flex items-center gap-1 border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-0.5 font-mono text-[12px]"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            aria-label={`Remove ${v}`}
            className="cursor-pointer text-[color:var(--color-text-muted)]"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        className="min-w-[120px] flex-1 border border-[color:var(--color-border)] px-2 py-1 font-mono text-[12px]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compiled-rule preview — design.md §1.2, the "killer affordance" (brief §11 /
// scoring-ux §4.6 point 2). Pure function of the CURRENT form state, recomputed
// on every render — no fetch, no debounce; clearing a keyword list makes a rule
// disappear from this preview instantly.
// ---------------------------------------------------------------------------

interface CompiledRule {
  id: string;
  weight: number;
  isDealBreaker: boolean;
}

function compileMandate(config: ThesisConfig): CompiledRule[] {
  const w = config.fit.mandate_weight;
  const out: CompiledRule[] = [];
  if (config.mandate.sectors.length > 0) out.push({ id: "M_sector", weight: w, isDealBreaker: false });
  if (config.mandate.geographies.length > 0)
    out.push({ id: "M_geography", weight: w, isDealBreaker: false });
  if (config.mandate.stages.length > 0) out.push({ id: "M_stage", weight: w, isDealBreaker: false });
  if (config.positive_keywords.length > 0) out.push({ id: "M_poskw", weight: w, isDealBreaker: false });
  if (config.negative_keywords.length > 0) out.push({ id: "M_negkw", weight: 0, isDealBreaker: true });
  return out;
}

function CompiledPreview({ config }: { config: ThesisConfig }) {
  const compiled = compileMandate(config);
  const handAuthored = config.rules.filter((r) => r.enabled);
  const totalWeight =
    compiled.filter((r) => !r.isDealBreaker).reduce((s, r) => s + r.weight, 0) +
    handAuthored.filter((r) => r.kind !== "deal_breaker").reduce((s, r) => s + (r.weight || 0), 0);
  const softCount = compiled.length + handAuthored.length;

  const parts = [
    ...compiled.map((r) => (r.isDealBreaker ? `${r.id} (deal-breaker, w0)` : `${r.id} (w${r.weight})`)),
  ];

  return (
    <div className="border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-[18px] py-3.5">
      <div className="text-[10.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
        Compiled — read-only, updates live
      </div>
      {compiled.length === 0 ? (
        <div className="mt-1 text-[13.5px] text-[color:var(--color-text-muted)]">
          Your mandate compiles to no rules yet — every mandate field is empty. Add sectors,
          geographies, stages or keywords to see them here.
        </div>
      ) : (
        <>
          <div className="mt-1 text-[13.5px]">Your mandate compiles to {softCount} rule{softCount === 1 ? "" : "s"}:</div>
          <div className="mt-0.5 font-mono text-[12.5px]">
            {parts.join(" · ")}
            {" ·· "}Total weight: {totalWeight}
          </div>
        </>
      )}
      <div className="mt-1.5 text-[12px] text-[color:var(--color-text-muted)]">
        Clear a keyword list and watch a rule disappear — this preview is what makes the tuning
        fields legible. Total weight includes enabled hand-authored rules below.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules table — hand-authored `rules[]`. §4.6 point 3: hard is expensive to
// select (requires a justification radio, disabled entirely on focus rules —
// point 3's "the combination is illegal and the database will reject it").
// Point 5: guard weights client-side, since the DB validator does not type- or
// range-check weights on focus/must_have rules.
// ---------------------------------------------------------------------------

function nextRuleId(rules: ThesisRule[]): string {
  const nums = rules
    .map((r) => /^R(\d+)$/.exec(r.id)?.[1])
    .filter((n): n is string => n != null)
    .map(Number);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `R${next}`;
}

function exprToCondition(expr: ThesisRuleExpr): string {
  const value = Array.isArray(expr.value) ? expr.value.join(",") : String(expr.value);
  return expr.op === "exists" ? expr.field : `${expr.field} ${expr.op} ${value}`;
}

function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: ThesisRule;
  onChange: (next: ThesisRule) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1.4fr_1fr_110px_90px_70px_60px] items-baseline gap-2.5 border-t border-[color:var(--color-border)] px-1 py-2 text-[13px]">
      <input
        value={rule.label}
        onChange={(e) => onChange({ ...rule, label: e.target.value })}
        className="border-none bg-transparent p-0 text-[13px] focus:outline-none"
      />
      <span className="font-mono text-[11.5px] text-[color:var(--color-text-muted)]">
        {exprToCondition(rule.expr)}
      </span>
      <span className="text-[12px]">{rule.kind}</span>
      <span className="font-mono text-[11.5px]">{rule.enforcement}</span>
      <span className="font-mono text-[11.5px]">
        {rule.kind === "deal_breaker" ? (
          "0"
        ) : (
          <input
            type="number"
            min={0}
            value={rule.weight}
            onChange={(e) => onChange({ ...rule, weight: Math.max(0, Number(e.target.value) || 0) })}
            className="w-[52px] border border-[color:var(--color-border)] px-1 py-0.5 font-mono text-[11.5px]"
          />
        )}
      </span>
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          title="enabled"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${rule.label}`}
          className="cursor-pointer text-[color:var(--color-text-muted)]"
        >
          ×
        </button>
      </span>
    </div>
  );
}

interface NewRuleDraft {
  label: string;
  field: string;
  op: ThesisRuleExpr["op"];
  value: string;
  kind: ThesisRule["kind"];
  enforcement: ThesisRule["enforcement"];
  hardJustification: "" | "mandate_fatal" | "fraud";
  weight: string;
}

const BLANK_DRAFT: NewRuleDraft = {
  label: "",
  field: "sector",
  op: "eq",
  value: "",
  kind: "focus",
  enforcement: "soft",
  hardJustification: "",
  weight: "20",
};

function parseExprValue(op: ThesisRuleExpr["op"], raw: string): unknown {
  if (op === "exists") return true;
  if (op === "gte" || op === "lte") return Number(raw);
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (op === "in") return parts;
  return parts.length > 1 ? parts : raw.trim();
}

function RulesEditor({
  rules,
  onChange,
}: {
  rules: ThesisRule[];
  onChange: (next: ThesisRule[]) => void;
}) {
  const [draft, setDraft] = useState<NewRuleDraft>(BLANK_DRAFT);
  const [error, setError] = useState<string | null>(null);

  // §4.6 point 3: focus + hard is an illegal combination the database rejects —
  // disable it in the UI rather than let the user discover that at publish time.
  useEffect(() => {
    if (draft.kind === "focus" && draft.enforcement === "hard") {
      setDraft((d) => ({ ...d, enforcement: "soft" }));
    }
    if (draft.kind === "deal_breaker") {
      setDraft((d) => ({ ...d, weight: "0" }));
    }
  }, [draft.kind, draft.enforcement]);

  function addRule() {
    setError(null);
    if (!draft.label.trim()) {
      setError("A rule needs a label.");
      return;
    }
    if (draft.enforcement === "hard" && !draft.hardJustification) {
      setError("A hard rule requires a justification (legally excluded, or fraud/misrepresentation).");
      return;
    }
    const weight = draft.kind === "deal_breaker" ? 0 : Math.max(0, Number(draft.weight) || 0);
    const rule: ThesisRule = {
      id: nextRuleId(rules),
      label: draft.label.trim(),
      kind: draft.kind,
      enforcement: draft.enforcement,
      ...(draft.enforcement === "hard" ? { hard_justification: draft.hardJustification as "mandate_fatal" | "fraud" } : {}),
      weight,
      enabled: true,
      expr: { field: draft.field, op: draft.op, value: parseExprValue(draft.op, draft.value) },
    };
    onChange([...rules, rule]);
    setDraft(BLANK_DRAFT);
  }

  return (
    <div>
      <div className="mt-7 text-[11.5px] font-semibold tracking-[0.08em] uppercase">Rules</div>
      <div className="mt-3 grid grid-cols-[1.4fr_1fr_110px_90px_70px_60px] gap-2.5 px-1 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[color:var(--color-text-muted)] uppercase">
        <span>Label</span>
        <span>Condition</span>
        <span>Kind</span>
        <span>Enforce</span>
        <span>Weight</span>
        <span>On</span>
      </div>
      {rules.length === 0 ? (
        <div className="border-t border-[color:var(--color-border)] py-3 text-[13px] text-[color:var(--color-text-muted)] italic">
          No hand-authored rules yet.
        </div>
      ) : (
        rules.map((r) => (
          <RuleRow
            key={r.id}
            rule={r}
            onChange={(next) => onChange(rules.map((x) => (x.id === r.id ? next : x)))}
            onRemove={() => onChange(rules.filter((x) => x.id !== r.id))}
          />
        ))
      )}

      <div className="mt-1 border-t border-b border-[color:var(--color-border)] py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <TextInput
            placeholder="New rule label"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="w-[220px] font-sans"
          />
          <Select value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })}>
            {FIELD_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
          <Select
            value={draft.op}
            onChange={(e) => setDraft({ ...draft, op: e.target.value as ThesisRuleExpr["op"] })}
          >
            {OP_OPTIONS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </Select>
          {draft.op !== "exists" ? (
            <TextInput
              placeholder={draft.op === "in" ? "value1,value2" : "value"}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              className="w-[170px]"
            />
          ) : null}
          <Select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as ThesisRule["kind"] })}
          >
            <option value="focus">focus</option>
            <option value="must_have">must_have</option>
            <option value="deal_breaker">deal_breaker</option>
          </Select>
          <Select
            value={draft.enforcement}
            disabled={draft.kind === "focus"}
            onChange={(e) => setDraft({ ...draft, enforcement: e.target.value as ThesisRule["enforcement"] })}
          >
            <option value="soft">soft</option>
            <option value="hard">hard</option>
          </Select>
          {draft.kind !== "deal_breaker" ? (
            <TextInput
              type="number"
              min={0}
              value={draft.weight}
              onChange={(e) => setDraft({ ...draft, weight: e.target.value })}
              className="w-[70px]"
            />
          ) : null}
          <button
            type="button"
            onClick={addRule}
            className="border border-[color:var(--color-text)] bg-[color:var(--color-bg)] px-3.5 py-[7px] text-[13px] font-medium"
          >
            Add rule
          </button>
        </div>

        {draft.enforcement === "hard" ? (
          <div className="mt-2.5 bg-[color:var(--color-surface)] p-3.5 text-[13px]">
            <div className="font-medium">A hard rule requires justification:</div>
            <label className="mt-1.5 block">
              <input
                type="radio"
                name="hard-justification"
                checked={draft.hardJustification === "mandate_fatal"}
                onChange={() => setDraft({ ...draft, hardJustification: "mandate_fatal" })}
              />{" "}
              Legally or contractually excluded
            </label>
            <label className="block">
              <input
                type="radio"
                name="hard-justification"
                checked={draft.hardJustification === "fraud"}
                onChange={() => setDraft({ ...draft, hardJustification: "fraud" })}
              />{" "}
              Fraud or misrepresentation
            </label>
            <div className="mt-2 text-[color:var(--color-text-muted)]">
              A hard rule auto-rejects. It fires only when the attribute was actually observed; an
              unread deck can never trigger it.
            </div>
          </div>
        ) : null}
        {error ? <div className="mt-2 text-[12.5px] text-[color:var(--color-text)]">{error}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function ThesisConfigScreen() {
  const thesisQ = useQuery({
    queryKey: ["investor", "active-thesis"],
    queryFn: () => getTheses({ filters: { active: "eq.true" }, limit: 1 }),
  });

  const [name, setName] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [config, setConfig] = useState<ThesisConfig | null>(null);
  const [publishState, setPublishState] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string } | { kind: "done"; version: number }
  >({ kind: "idle" });

  const loadedThesis: ThesisRow | undefined = thesisQ.data?.ok ? thesisQ.data.data[0] : undefined;

  useEffect(() => {
    if (loadedThesis && config === null) {
      setName(loadedThesis.name);
      setBaseVersion(loadedThesis.version);
      setConfig(structuredClone(loadedThesis.config));
    }
    // Intentionally only seeds local state ONCE per successful load — this is an
    // editable form, not a read-through view; a background refetch must not stomp
    // on in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThesis]);

  const nextVersion = (baseVersion ?? 0) + 1;

  function updateConfig(patch: Partial<ThesisConfig>) {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  }
  function updateMandate(patch: Partial<ThesisConfig["mandate"]>) {
    setConfig((c) => (c ? { ...c, mandate: { ...c.mandate, ...patch } } : c));
  }
  function updateFit(patch: Partial<ThesisConfig["fit"]>) {
    setConfig((c) => (c ? { ...c, fit: { ...c.fit, ...patch } } : c));
  }
  function updateExceptionalLane(patch: Partial<ThesisConfig["exceptional_lane"]>) {
    setConfig((c) => (c ? { ...c, exceptional_lane: { ...c.exceptional_lane, ...patch } } : c));
  }

  async function publish() {
    if (!config || !name) return;
    // §4.6 point 5: guard weights client-side before they ever reach the RPC —
    // the database validator only range-checks deal_breaker weight (must be 0),
    // not focus/must_have.
    for (const r of config.rules) {
      if (r.enabled && r.kind !== "deal_breaker" && (!Number.isFinite(r.weight) || r.weight < 0)) {
        setPublishState({
          kind: "error",
          message: `Rule "${r.label}" has an invalid weight. Fix it before publishing.`,
        });
        return;
      }
      if (r.enforcement === "hard" && !r.hard_justification) {
        setPublishState({
          kind: "error",
          message: `Rule "${r.label}" is hard but has no justification. Fix it before publishing.`,
        });
        return;
      }
    }

    setPublishState({ kind: "pending" });
    const res = await publishThesisVersion({ name, config, version: nextVersion });
    if (!res.ok) {
      setPublishState({ kind: "error", message: res.error.message });
      return;
    }
    setPublishState({ kind: "done", version: res.data.version });
    setBaseVersion(res.data.version);
    thesisQ.refetch();
  }

  if (thesisQ.isLoading) {
    return (
      <div className="px-9 py-7">
        <p className="text-[13px] text-[color:var(--color-text-muted)]">Loading thesis…</p>
      </div>
    );
  }

  if (thesisQ.data && !thesisQ.data.ok) {
    return (
      <div className="px-9 py-7">
        <div className="mx-auto max-w-[1100px] border border-[color:var(--color-border)] p-5">
          <p className="text-[14px]">{thesisQ.data.error.message}</p>
          <button
            type="button"
            onClick={() => thesisQ.refetch()}
            className="mt-3 border border-[color:var(--color-text)] px-3 py-1.5 text-[13px] font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!loadedThesis || !config || !name) {
    return (
      <div className="px-9 py-7">
        <p className="text-[15px] font-medium">No active thesis configured.</p>
        <p className="mt-2 max-w-[520px] text-[13px] text-[color:var(--color-text-muted)]">
          No fund thesis is active yet, so there is nothing to edit here. A thesis is normally
          seeded when the database is provisioned.
        </p>
      </div>
    );
  }

  return (
    <div className="px-9 py-7 pb-24">
      {/* Widened + centered (operator request, 19.07): a bare 900px block sat
          left-pinned with dead space on the right on a 1440px monitor. This
          form has a 6-column rules table and multi-chip toggle rows that
          genuinely use the extra room — a config form earns width a plain
          document doesn't, unlike the memo's intentionally narrow 760px
          reading column, which stays as-is. */}
      <div className="mx-auto max-w-[1100px]">
        <h1 className="m-0 text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">
          {name} v{loadedThesis.version}
        </h1>
        <p className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
          The fund's configurable mandate. Changing the active thesis re-sorts the feed live.
        </p>
        <div className="ms-rule mt-4 mb-5" />

        <div className="text-[11.5px] font-semibold tracking-[0.08em] uppercase">Applied to scoring</div>
        <div className="mt-3 grid grid-cols-[170px_1fr] items-baseline gap-x-5 gap-y-3.5">
          <FieldLabel>Sectors</FieldLabel>
          <ChipToggleGroup
            options={SECTOR_OPTIONS}
            selected={config.mandate.sectors}
            onChange={(sectors) => updateMandate({ sectors })}
          />

          <FieldLabel hint="Feeds the compiled M_geography rule.">Geographies (mandate)</FieldLabel>
          <ChipToggleGroup
            options={REGION_OPTIONS}
            selected={config.mandate.geographies}
            onChange={(geographies) => updateMandate({ geographies })}
          />

          <FieldLabel>Stages</FieldLabel>
          <ChipToggleGroup
            options={STAGE_OPTIONS}
            selected={config.mandate.stages}
            onChange={(stages) => updateMandate({ stages })}
          />

          <FieldLabel>Positive keywords</FieldLabel>
          <ChipInput
            values={config.positive_keywords}
            onChange={(positive_keywords) => updateConfig({ positive_keywords })}
            placeholder="add and press Enter"
          />

          <FieldLabel>Negative keywords</FieldLabel>
          <ChipInput
            values={config.negative_keywords}
            onChange={(negative_keywords) => updateConfig({ negative_keywords })}
            placeholder="add and press Enter"
          />

          <FieldLabel hint="Used by market research to build search queries. Does nothing for the thesis rules — not the same field as Geographies above.">
            geos
          </FieldLabel>
          <ChipInput
            values={config.geos}
            onChange={(geos) => updateConfig({ geos })}
            placeholder="ISO country code, e.g. DE"
          />

          <FieldLabel>Fit tuning</FieldLabel>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12.5px]">
            <label className="flex items-center gap-1.5">
              base
              <TextInput
                type="number"
                value={config.fit.base}
                onChange={(e) => updateFit({ base: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              mandate_weight
              <TextInput
                type="number"
                value={config.fit.mandate_weight}
                onChange={(e) => updateFit({ mandate_weight: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              strong_threshold
              <TextInput
                type="number"
                value={config.fit.strong_threshold}
                onChange={(e) => updateFit({ strong_threshold: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              soft_deal_breaker_penalty
              <TextInput
                type="number"
                value={config.fit.soft_deal_breaker_penalty}
                onChange={(e) => updateFit({ soft_deal_breaker_penalty: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              min_coverage
              <TextInput
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={config.fit.min_coverage}
                onChange={(e) => updateFit({ min_coverage: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
          </div>
        </div>

        <div className="mt-4.5">
          <CompiledPreview config={config} />
        </div>

        <RulesEditor rules={config.rules} onChange={(rules) => updateConfig({ rules })} />

        <div className="mt-5">
          <div className="text-[11.5px] font-semibold tracking-[0.08em] uppercase">Exceptional lane</div>
          <p className="mt-1 max-w-[640px] text-[13px] text-[color:var(--color-text-muted)]">
            A founder scoring at or above this is shown even when the company is outside the
            mandate.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[12.5px]">
            <label className="flex items-center gap-1.5">
              axis
              <Select
                value={config.exceptional_lane.axis}
                onChange={(e) => updateExceptionalLane({ axis: e.target.value })}
              >
                {AXIS_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5">
              aggregate
              <Select
                value={config.exceptional_lane.aggregate}
                onChange={(e) => updateExceptionalLane({ aggregate: e.target.value })}
              >
                {AGGREGATE_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5">
              min_value
              <TextInput
                type="number"
                value={config.exceptional_lane.min_value}
                onChange={(e) => updateExceptionalLane({ min_value: Number(e.target.value) || 0 })}
                className="w-[60px]"
              />
            </label>
          </div>
        </div>

        <div className="mt-7">
          <div className="text-[11.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
            Recorded only{" "}
            <span className="font-normal tracking-normal text-[color:var(--color-text-muted)] normal-case">
              — recorded, not yet applied to scoring
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-[170px_1fr] gap-x-5 gap-y-2.5 bg-[color:var(--color-surface)] px-[18px] py-3.5 text-[13.5px] text-[color:var(--color-text-muted)]">
            <span>Check size</span>
            <span className="flex items-center gap-1.5 font-mono text-[12.5px]">
              $
              <TextInput
                type="number"
                value={config.mandate.check_size_usd.min}
                onChange={(e) =>
                  updateMandate({
                    check_size_usd: {
                      ...config.mandate.check_size_usd,
                      min: Number(e.target.value) || 0,
                    },
                  })
                }
                className="w-[90px]"
              />
              –
              <TextInput
                type="number"
                value={config.mandate.check_size_usd.max}
                onChange={(e) =>
                  updateMandate({
                    check_size_usd: {
                      ...config.mandate.check_size_usd,
                      max: Number(e.target.value) || 0,
                    },
                  })
                }
                className="w-[90px]"
              />
            </span>
            <span>Ownership target</span>
            <span className="flex items-center gap-1.5 font-mono text-[12.5px]">
              <TextInput
                type="number"
                value={config.mandate.ownership_target_pct ?? ""}
                onChange={(e) =>
                  updateMandate({
                    ownership_target_pct: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="w-[70px]"
              />
              %
            </span>
            <span>Risk appetite</span>
            <TextInput
              value={config.mandate.risk_appetite}
              onChange={(e) => updateMandate({ risk_appetite: e.target.value })}
              className="w-[160px] font-sans"
            />
          </div>
        </div>

        <div className="mt-6.5 flex flex-wrap items-center gap-3.5">
          <button
            type="button"
            disabled={publishState.kind === "pending"}
            onClick={publish}
            className="border-none bg-[color:var(--color-accent)] px-[22px] py-[11px] text-[14px] font-medium text-white disabled:opacity-60"
          >
            {publishState.kind === "pending" ? "Publishing…" : `Publish new version — creates v${nextVersion}`}
          </button>
          <span className="text-[12.5px] text-[color:var(--color-text-muted)]">
            Never "Save" — every change is a new version; scores are stamped with the version that
            produced them.
          </span>
        </div>
        {publishState.kind === "error" ? (
          <div className="mt-3 border border-[color:var(--color-text)] px-3.5 py-2.5 text-[13px]">
            {publishState.message}
          </div>
        ) : null}
        {publishState.kind === "done" ? (
          <div className="mt-3 bg-[color:var(--color-surface)] px-3.5 py-2.5 text-[13px]">
            Published v{publishState.version} and made it active. The feed now sorts by this
            version.
          </div>
        ) : null}
      </div>
    </div>
  );
}
