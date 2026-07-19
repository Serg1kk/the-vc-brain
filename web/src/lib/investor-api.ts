// Typed read/write client for the investor dashboard (feature 09).
//
// Reads go straight to PostgREST (VITE_SUPABASE_REST_URL); writes go through n8n
// webhooks (VITE_N8N_BASE_URL), plus one PostgREST RPC for thesis publish.
// See docs/backlog/09-investor-dashboard/{lovable-brief,data-contracts,scoring-ux}.md
// for the frozen contracts this file implements — the warnings in the JSDoc below are
// pulled from those documents, not invented here.
//
// Contract: every exported function returns a Result<T> and never throws. A failed
// read or write resolves to `{ ok: false, error }` so a screen can always render a
// "read failure" state (brief §12.3) instead of hitting an unhandled rejection.
//
// The feed, the card and the memo are three separate reads (brief §15) — nothing here
// builds a single god-query; screens compose these primitives themselves.

// ---------------------------------------------------------------------------
// Result / error shape
// ---------------------------------------------------------------------------

export type ApiErrorKind = "network" | "timeout" | "http" | "parse" | "config";

export interface ApiError {
  kind: ApiErrorKind;
  /** Safe to render directly — never a raw stack trace or JSON blob. */
  message: string;
  status?: number;
  /** n8n's `error.code`, when the envelope carries one. */
  code?: string;
  /** Present on f10-nl-search's richer envelope (`{error:{kind,message,hint,retryable}}`). */
  hint?: string;
  retryable?: boolean;
  /** The upstream's own `error.kind` string (e.g. f10's `unresolvable_query`), kept
   * separate from our transport-level `kind` above so screens can branch on it without
   * widening the transport union. */
  upstreamKind?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
function fail(error: ApiError): Result<never> {
  return { ok: false, error };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 30_000; // f10-nl-search runs a resolver then a scorer
const WRITE_TIMEOUT_MS = 45_000; // follow-up suggestion / memo-style calls hit a model

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function restBase(): Result<string> {
  const url = import.meta.env.VITE_SUPABASE_REST_URL as string | undefined;
  if (!url) {
    return fail({
      kind: "config",
      message: "The database connection is not configured. Set VITE_SUPABASE_REST_URL and reload.",
    });
  }
  return ok(url.replace(/\/$/, ""));
}

function anonKey(): Result<string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!key) {
    return fail({
      kind: "config",
      message: "The database key is not configured. Set VITE_SUPABASE_ANON_KEY and reload.",
    });
  }
  return ok(key);
}

function n8nBase(): Result<string> {
  const url = import.meta.env.VITE_N8N_BASE_URL as string | undefined;
  if (!url) {
    return fail({
      kind: "config",
      message: "The automation backend is not configured. Set VITE_N8N_BASE_URL and reload.",
    });
  }
  return ok(url.replace(/\/$/, ""));
}

// ---------------------------------------------------------------------------
// Low-level fetch plumbing — shared by REST reads, REST writes and n8n writes
// ---------------------------------------------------------------------------

async function safeFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Result<Response>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return ok(res);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return fail({
      kind: aborted ? "timeout" : "network",
      message: aborted
        ? "The request took too long. Try again in a moment."
        : "We couldn't reach the server. Check your connection and try again.",
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  hint?: string;
  retryable?: boolean;
  upstreamKind?: string;
}

/** Recognises both n8n's `{error:{code,message}}` and PostgREST's flat
 * `{message,hint,details,code}` error bodies, plus f10's richer
 * `{error:{kind,message,hint,retryable}}` envelope. */
function extractErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      hint: typeof e.hint === "string" ? e.hint : undefined,
      retryable: typeof e.retryable === "boolean" ? e.retryable : undefined,
      upstreamKind: typeof e.kind === "string" ? e.kind : undefined,
    };
  }
  if (typeof b.message === "string") {
    return { code: typeof b.code === "string" ? b.code : undefined, message: b.message };
  }
  return null;
}

async function parseJsonResponse<T>(res: Response): Promise<Result<T>> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const envelope = extractErrorEnvelope(body);
    return fail({
      kind: "http",
      status: res.status,
      code: envelope?.code,
      hint: envelope?.hint,
      retryable: envelope?.retryable,
      upstreamKind: envelope?.upstreamKind,
      message: envelope?.message ?? `Request failed (${res.status}).`,
    });
  }
  if (text && body === null) {
    return fail({ kind: "parse", message: "The server sent a response we couldn't read." });
  }
  return ok((body ?? null) as T);
}

// ---------------------------------------------------------------------------
// PostgREST reads
// ---------------------------------------------------------------------------

export interface RestQuery {
  select?: string;
  order?: string;
  limit?: number;
  offset?: number;
  /** PostgREST filter syntax, e.g. `{ status: "eq.screening", thesis_verdict: "eq.passed" }`. */
  filters?: Record<string, string>;
}

function buildQueryString(q?: RestQuery): string {
  const params = new URLSearchParams();
  if (q?.select) params.set("select", q.select);
  if (q?.order) params.set("order", q.order);
  if (q?.limit != null) params.set("limit", String(q.limit));
  if (q?.offset != null) params.set("offset", String(q.offset));
  if (q?.filters) {
    for (const [key, value] of Object.entries(q.filters)) params.append(key, value);
  }
  return params.toString();
}

async function restGet<T>(
  path: string,
  query?: RestQuery,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Result<T>> {
  const base = restBase();
  if (!base.ok) return base;
  const key = anonKey();
  if (!key.ok) return key;

  const qs = buildQueryString(query);
  const url = `${base.data}${path}${qs ? `?${qs}` : ""}`;

  const res = await safeFetch(
    url,
    {
      method: "GET",
      headers: {
        apikey: key.data,
        Authorization: `Bearer ${key.data}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
  );
  if (!res.ok) return res;
  return parseJsonResponse<T>(res.data);
}

async function restPost<T>(
  path: string,
  body: unknown,
  opts?: { preferReturnRepresentation?: boolean },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Result<T>> {
  const base = restBase();
  if (!base.ok) return base;
  const key = anonKey();
  if (!key.ok) return key;

  const headers: Record<string, string> = {
    apikey: key.data,
    Authorization: `Bearer ${key.data}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts?.preferReturnRepresentation) headers.Prefer = "return=representation";

  const res = await safeFetch(
    `${base.data}${path}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (!res.ok) return res;
  return parseJsonResponse<T>(res.data);
}

async function n8nPost<T>(
  path: string,
  body: unknown,
  timeoutMs = WRITE_TIMEOUT_MS,
): Promise<Result<T>> {
  const base = n8nBase();
  if (!base.ok) return base;

  const res = await safeFetch(
    `${base.data}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) return res;
  return parseJsonResponse<T>(res.data);
}

// ---------------------------------------------------------------------------
// Shared axis vocabulary
// ---------------------------------------------------------------------------

export type AxisTrend = "improving" | "stable" | "declining";
export type ThesisVerdict = "passed" | "failed" | "borderline" | "insufficient_evidence";

/** A rule fired during thesis evaluation. `outcome: "unknown"` means the rule could
 * not be evaluated — render it as its own state, never as a pass or a miss. */
export interface FiredRule {
  id: string;
  label: string;
  kind: "deal_breaker" | "must_have" | "focus";
  enforcement: "hard" | "soft";
  outcome: "satisfied" | "missed" | "triggered" | "unknown";
  field: string;
  expected: unknown;
  observed: unknown;
  /** The weight actually applied, not the nominal weight — deal-breakers are always 0. */
  weight_applied: number;
}

// ---------------------------------------------------------------------------
// 5.1 `radar_candidates` — the radar feed source (data-contracts.md §5)
// ---------------------------------------------------------------------------

export interface RadarCandidateRow {
  founder_id: string;
  company_id: string | null;
  application_id: string | null;
  gh_followers: number | null;
  gh_notable_followers: number | null;
  /** Can be negative — HN karma legitimately goes negative. */
  hn_karma: number | null;
  hn_points: number | null;
  hn_comments: number | null;
  /** 0–1. NULL when no metric was ever observed — never a computed 0, which would read
   * as "maximally undiscovered" and float the least-known founders to the top. */
  obscurity: number | null;
  /** Interval string, e.g. `"41 days 03:12:55"`. Prefer `api_founders.first_seen_at`
   * for UI copy — this is first-seen, not last-active; never label it "active Nd ago". */
  freshness: string | null;
  channel: string | null;
  /** Exactly four values: both terms · followers only · karma only · NULL. Render it —
   * a one-term value is weaker evidence than a two-term one. */
  obscurity_basis: string[] | null;
}

/**
 * ⚠️ Never default-sort by `obscurity`: inbound founders have NULL radar fields, and an
 * obscurity sort floats them to the top as "maximally undiscovered" — the exact
 * inversion the metric exists to prevent. Make it an explicit opt-in control, always
 * with NULLS LAST.
 *
 * ⚠️ A live defect: the view floors negative `hn_karma` at 0 for the log, which makes a
 * downvoted HN account (karma < 0) read as "observed and maximally obscure" (→ 1.0)
 * instead of "unobserved". Treat `obscurity >= 0.99` with `obscurity_basis` = karma-only
 * as suspicious and surface the basis chip prominently (scoring-ux.md §5.2).
 */
export function getRadarCandidates(query?: RestQuery): Promise<Result<RadarCandidateRow[]>> {
  return restGet<RadarCandidateRow[]>("/radar_candidates", { select: "*", ...query });
}

// ---------------------------------------------------------------------------
// 5.2 `api_applications` — the inbound feed source (data-contracts.md §5)
// ---------------------------------------------------------------------------

export type ApplicationKind = "inbound" | "radar_activated";
export type ApplicationStatus =
  "sourced" | "screening" | "diligence" | "decision" | "invest" | "pass";

/** Never render `value` without `assessed` and `confidence` beside it (brief §4.5
 * rule 3). `assessed: false` ⇒ `value` is null — render the "Not assessed" state
 * (§4.3), never zero. */
export interface AxisScore {
  value: number | null;
  trend: AxisTrend | null;
  confidence: number | null;
  missing: string[];
  assessed: boolean;
}

export interface ApplicationRow {
  application_id: string;
  company_id: string;
  company_name: string | null;
  company_domain: string | null;
  stage: "pre_seed" | "seed";
  category: string | null;
  kind: ApplicationKind;
  status: ApplicationStatus;
  submitted_at: string;
  artifact_links: unknown;
  score_founder: AxisScore;
  score_market: AxisScore;
  score_idea_vs_market: AxisScore;
  thesis_id: string | null;
  thesis_name: string | null;
  thesis_verdict: ThesisVerdict | null;
  /** 0–100; NULL when not assessed. */
  thesis_fit: number | null;
  /** NULL in keyword mode. */
  thesis_coverage: number | null;
  thesis_missing_fields: string[];
  thesis_fired_rules: FiredRule[];
  memo_version: number | null;
  /** False on all rows today — feature 06 has not shipped a memo writer yet. */
  memo_available: boolean;
  /** Added to the live view after data-contracts.md was frozen (feature 11 QA
   * finding, 2026-07-19) — read straight off the joined company row rather than
   * requiring a founder-card join, which isn't guaranteed to resolve. Required for
   * the feed row's SYNTHETIC badge (brief §4.6) without a second read. */
  is_synthetic: boolean;
}

/**
 * `api_applications` already resolves the thesis-evaluation trap documented in
 * data-contracts.md §6: `thesis_fit` / `thesis_verdict` here are never a stale
 * `scores`-table read. Read these columns directly; do not re-derive from
 * `thesis_evaluations` or `scores`.
 *
 * There is deliberately no `overall_score` column and none is to be added — do not
 * compute one client-side either.
 *
 * ⚠️ This view carries no founder-identity column. To show a founder's name beneath a
 * company name, join client-side against
 * `getFounders({ filters: { application_id: "in.(...)" } })`.
 */
export function getApplications(query?: RestQuery): Promise<Result<ApplicationRow[]>> {
  return restGet<ApplicationRow[]>("/api_applications", { select: "*", ...query });
}

// ---------------------------------------------------------------------------
// 5.3 `api_founders` — the person-scoped view (data-contracts.md §1)
// ---------------------------------------------------------------------------

export interface FounderScoreGap {
  criterion_id: string;
  what_would_close_it: string;
}

export interface FounderRow {
  founder_id: string;
  /** Not unique. */
  full_name: string;
  /** 3 of 122 rows filled — design around it being absent, not rare. */
  headline: string | null;
  /** Must be badged wherever this founder appears; never rank unlabelled beside real
   * people (brief §4.6). */
  is_synthetic: boolean;
  /** 0–100. NULL ≠ 0 — pair with `score_assessed`. */
  founder_score: number | null;
  founder_score_trend: AxisTrend | null;
  founder_score_confidence: number | null;
  founder_score_missing: string[];
  /** false = no score row exists for this person at all. */
  score_assessed: boolean;
  scored_at: string | null;
  obscurity: number | null;
  obscurity_basis: string[] | null;
  /** Source slug of the earliest signal. */
  channel: string | null;
  /** Use this, not `radar_candidates.freshness`. */
  first_seen_at: string | null;
  /** Via current employment only. */
  company_id: string | null;
  company_name: string | null;
  /** Most recent application of the current company. */
  application_id: string | null;
  /** Raw objects, not strings — rendering as strings prints `[object Object]`. */
  founder_score_gaps: FounderScoreGap[];
}

/**
 * Default order is baked into the view: `founder_score DESC NULLS LAST, full_name,
 * founder_id`. Do not override with a raw-value sort — see scoring-ux.md §1.10 #2:
 * one `met` criterion with everything else `cannot_assess` yields 100.00 at confidence
 * ≈0.05, so a raw-value sort ranks the least-known founders highest. Sort within
 * confidence bands if you must re-sort at all.
 *
 * Opted-out founders and merge tombstones are already excluded by the view.
 */
export function getFounders(query?: RestQuery): Promise<Result<FounderRow[]>> {
  return restGet<FounderRow[]>("/api_founders", { select: "*", ...query });
}

// ---------------------------------------------------------------------------
// 5.4 `api_claims` / `claim_trust` — the traceability surface (data-contracts.md §3-4)
// ---------------------------------------------------------------------------

export interface ClaimEvidence {
  tier: "documented" | "discovered" | "inferred" | "missing";
  relation: "supports" | "contradicts" | "context";
  strength: number;
  /** Real source quote or null — never our own claim text. ~40% of rows have no
   * quote; that absence is honest, not a gap to fill. */
  quote_verbatim: string | null;
  source_url: string;
  raw_signal_id: string;
  captured_at: string;
}

export type ClaimSourceKind = "self_reported" | "public" | "interview" | "voice" | "derived";

export interface ClaimRow {
  claim_id: string;
  card_id: string;
  /** NULL for company-scoped claims — retained, not dropped. */
  founder_id: string | null;
  company_id: string | null;
  application_id: string | null;
  /** Dotted slug, e.g. `founder.execution.provenance`. */
  topic: string;
  axis: string | null;
  /** ⚠️ On `source_kind === "derived"` claims this is an ASSERTION, not a quotation —
   * never render inside quote marks. */
  text_verbatim: string;
  value: unknown;
  source_kind: ClaimSourceKind;
  base_confidence: number | null;
  created_at: string;
  /** Never NULL — `[]` when empty. */
  evidence: ClaimEvidence[];
}

const CLAIMS_SELECT =
  "claim_id,card_id,founder_id,company_id,application_id,topic,axis,text_verbatim,value,source_kind,base_confidence,created_at,evidence";

/**
 * ⚠️ Deliberately does not select `claims.verification_status` by default — it is
 * stored and stale (data-contracts.md §3: 19.5% of claims read differently in the
 * table than in the live view). Read verdicts from `getClaimTrust`'s `derived_status`
 * instead. Pass an explicit `query.select` to override.
 */
export function getClaims(query?: RestQuery): Promise<Result<ClaimRow[]>> {
  return restGet<ClaimRow[]>("/api_claims", { select: CLAIMS_SELECT, ...query });
}

export type RouterClass =
  | "factual_static"
  | "factual_dynamic"
  | "qualitative"
  | "forecast"
  | "unverifiable"
  | "precomputed";

/** The five frozen verdicts (brief §4.2) — do not invent, rename or merge values. */
export type DerivedStatus =
  "verified" | "contradicted" | "partially_supported" | "unverified" | "missing";

export interface ClaimTrustRow {
  claim_id: string;
  /** The only subject column on this view — join `api_claims` on `claim_id` for
   * founder/company/application id and `source_url`. */
  card_id: string;
  topic: string;
  axis: string | null;
  text_verbatim: string;
  source_kind: string;
  router_class: RouterClass;
  n_supports: number;
  n_contradicts: number;
  /** Documented + discovered only — the count that actually moves `trust`. */
  n_contradicts_counting: number;
  /** Distinct (source, host), supports-only, excluding deck and interview. */
  n_independent: number;
  /** NULL when no supports row exists — not a computed zero. */
  base: number | null;
  independence_factor: number;
  contradiction_penalty: number;
  /** 0–1, never NULL. Never render as a percentage (scoring-ux.md §3.0(a)): the
   * formula caps a single-source claim at 0.63, and 137 of 139 verified claims in the
   * live corpus have exactly one source — "63%" reads as "63% sure this is true",
   * which is wrong and damages honest founders. Use `TrustPipMeter` instead. */
  trust: number;
  /** Authoritative — always render this, never `claims.verification_status`. */
  derived_status: DerivedStatus;
}

const CLAIM_TRUST_SELECT =
  "claim_id,card_id,topic,axis,text_verbatim,source_kind,router_class,n_supports,n_contradicts,n_contradicts_counting,n_independent,base,independence_factor,contradiction_penalty,trust,derived_status";

export function getClaimTrust(query?: RestQuery): Promise<Result<ClaimTrustRow[]>> {
  return restGet<ClaimTrustRow[]>("/claim_trust", { select: CLAIM_TRUST_SELECT, ...query });
}

export interface ClaimWithTrust extends ClaimRow {
  /** Null only if the trust view somehow has no row for this claim id. */
  trust: ClaimTrustRow | null;
}

/**
 * The evidence ledger (brief §9.2) needs both `api_claims` (source_url, subject ids)
 * and `claim_trust` (derived_status, trust) — `claim_trust` alone cannot build it, it
 * exposes no `source_url` and no founder/company/application id. This performs the
 * two-read join described in data-contracts.md §4 so screens don't have to.
 */
export async function getEvidenceLedger(params: {
  founderId?: string;
  companyId?: string;
  applicationId?: string;
}): Promise<Result<ClaimWithTrust[]>> {
  const filters: Record<string, string> = {};
  if (params.founderId) filters.founder_id = `eq.${params.founderId}`;
  if (params.companyId) filters.company_id = `eq.${params.companyId}`;
  if (params.applicationId) filters.application_id = `eq.${params.applicationId}`;

  const claims = await getClaims({ filters, order: "created_at.desc" });
  if (!claims.ok) return claims;
  if (claims.data.length === 0) return ok([]);

  const ids = claims.data.map((c) => c.claim_id);
  const trust = await getClaimTrust({ filters: { claim_id: `in.(${ids.join(",")})` } });
  if (!trust.ok) return trust;

  const trustByClaim = new Map(trust.data.map((t) => [t.claim_id, t]));
  return ok(claims.data.map((c) => ({ ...c, trust: trustByClaim.get(c.claim_id) ?? null })));
}

// ---------------------------------------------------------------------------
// 5.5 `events` — contradictions and the audit trail (data-contracts.md §8)
// ---------------------------------------------------------------------------

export type EventEntityType = "founder" | "company" | "application";

export interface EventRow<TPayload = Record<string, unknown>> {
  id: string;
  event_type: string;
  entity_type: EventEntityType;
  entity_id: string;
  payload: TPayload;
  actor: string | null;
  created_at: string;
}

/** The richest UI object in the system — payload of a `claim_contradicted` event.
 * `severity` is deterministic, never model-judged. Frame `founder_claim` vs
 * `found_reality` as a question to ask, never an accusation. */
export interface ClaimContradictedPayload {
  claim_id: string;
  class: string;
  check: string;
  verdict_before: string;
  verdict_after: string;
  source_url: string;
  checked_at: string;
  run_id: string;
  nature: "factual" | "definitional" | "methodological" | "temporal" | "scope";
  severity: "minor" | "moderate" | "material";
  founder_claim: string;
  found_reality: string;
  question: string;
  entity_match: {
    resolved_by: "raw_signal_fk" | "domain" | "llm_quote";
    quote: string;
    disambiguator: string;
  };
}

export function getEvents(query?: RestQuery): Promise<Result<EventRow[]>> {
  return restGet<EventRow[]>("/events", { select: "*", order: "created_at.desc", ...query });
}

/**
 * Contradiction events on *company* claims are still written with `entity_type =
 * 'founder'`, with an `entity_type = 'application'` fallback when no founder resolves
 * — query both shapes or company-scoped contradictions vanish (brief §5.5). Runs two
 * reads in parallel and merges, newest first.
 */
export async function getContradictionEvents(params: {
  founderId?: string;
  applicationId?: string;
}): Promise<Result<EventRow<ClaimContradictedPayload>[]>> {
  const reads: Promise<Result<EventRow<ClaimContradictedPayload>[]>>[] = [];
  if (params.founderId) {
    reads.push(
      getEvents({
        filters: {
          event_type: "eq.claim_contradicted",
          entity_type: "eq.founder",
          entity_id: `eq.${params.founderId}`,
        },
      }) as Promise<Result<EventRow<ClaimContradictedPayload>[]>>,
    );
  }
  if (params.applicationId) {
    reads.push(
      getEvents({
        filters: {
          event_type: "eq.claim_contradicted",
          entity_type: "eq.application",
          entity_id: `eq.${params.applicationId}`,
        },
      }) as Promise<Result<EventRow<ClaimContradictedPayload>[]>>,
    );
  }
  if (reads.length === 0) return ok([]);

  const results = await Promise.all(reads);
  const failed = results.find((r): r is { ok: false; error: ApiError } => !r.ok);
  if (failed) return failed;

  const rows = results.flatMap((r) => (r.ok ? r.data : []));
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return ok(rows);
}

/**
 * Reads the `<axis>_insufficient_evidence` event that explains why an axis (or the
 * thesis gate) has no score row (brief §4.3). Filter the result by `event_type`
 * client-side; the three live types today are `founder_score_insufficient_evidence`,
 * `thesis_gate_insufficient_evidence` and `trust_rollup_insufficient_evidence`.
 */
export function getInsufficientEvidenceEvents(params: {
  entityType: EventEntityType;
  entityId: string;
}): Promise<Result<EventRow[]>> {
  return getEvents({
    filters: { entity_type: `eq.${params.entityType}`, entity_id: `eq.${params.entityId}` },
  });
}

// ---------------------------------------------------------------------------
// 5.6 `thesis_evaluations` / `theses` — thesis fit and the feed lanes
// ---------------------------------------------------------------------------

export interface ThesisEvaluationRow {
  id: string;
  application_id: string;
  thesis_id: string;
  thesis_version: number;
  input_fingerprint: string;
  evaluation_mode: "full" | "keyword";
  verdict: ThesisVerdict;
  /** NULL = not assessed this run. */
  score_id: string | null;
  fired_rules: FiredRule[];
  extracted_snapshot: unknown;
  thesis_config_snapshot: unknown;
  missing_fields: string[];
  /** NULL in keyword mode. */
  coverage: number | null;
  extraction_ai_run_id: string | null;
  formula_version: string | null;
  created_at: string;
}

/**
 * ⚠️ Append-only with no uniqueness on `(application_id, thesis_id)` — "latest row" is
 * not "current verdict" on its own (a QA run reproduced this: an application scored
 * 100, was re-run, degraded to `insufficient_evidence`, and a naive latest-row read
 * still returned the stale 100). Prefer `api_applications.thesis_fit` /
 * `thesis_verdict`, which already implement the resolution procedure in
 * data-contracts.md §6. Use this function only for the full evaluation history (e.g.
 * a thesis re-run audit view).
 */
export function getThesisEvaluations(query?: RestQuery): Promise<Result<ThesisEvaluationRow[]>> {
  return restGet<ThesisEvaluationRow[]>("/thesis_evaluations", {
    select: "*",
    order: "created_at.desc",
    ...query,
  });
}

export interface ThesisRuleExpr {
  field: string;
  op: "eq" | "in" | "gte" | "lte" | "contains" | "exists";
  value: unknown;
  negate?: boolean;
}

export interface ThesisRule {
  id: string;
  label: string;
  kind: "deal_breaker" | "must_have" | "focus";
  enforcement: "hard" | "soft";
  /** Required when `enforcement === "hard"`. */
  hard_justification?: "mandate_fatal" | "fraud";
  weight: number;
  enabled: boolean;
  expr: ThesisRuleExpr;
}

export interface ThesisConfig {
  schema_version?: number;
  mandate: {
    stages: string[];
    geographies: string[];
    sectors: string[];
    /** Recorded, not yet applied to scoring — the field most likely to be missed. */
    risk_appetite: string;
    /** Recorded, not yet applied to scoring. */
    check_size_usd: { min: number; max: number };
    /** Recorded, not yet applied to scoring. */
    ownership_target_pct: number;
  };
  /** NOT inert, and must not be labelled as such — read at runtime by market research
   * to build search queries, even though it does nothing for the thesis rules. */
  geos: string[];
  positive_keywords: string[];
  negative_keywords: string[];
  rules: ThesisRule[];
  fit: {
    base: number;
    mandate_weight: number;
    soft_deal_breaker_penalty: number;
    strong_threshold: number;
    min_coverage: number;
  };
  exceptional_lane: {
    axis: string;
    aggregate: string;
    /** UI-only lane spec — inert in the backend until enough founders are scored;
     * the lane renders empty until then. That is expected, not broken. */
    min_value: number;
  };
}

export interface ThesisRow {
  id: string;
  name: string;
  config: ThesisConfig;
  version: number;
  active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
}

export function getTheses(query?: RestQuery): Promise<Result<ThesisRow[]>> {
  return restGet<ThesisRow[]>("/theses", { select: "*", order: "version.desc", ...query });
}

/**
 * Publish protocol (brief §6, data-contracts.md §7 — mandatory; getting it wrong is a
 * guaranteed error): INSERT the new version row with `active: false` EXPLICITLY (the
 * column defaults to `true`, so omitting it is a deterministic unique-constraint
 * violation), then call the `activate_thesis_version` RPC, which moves `active` /
 * `is_default` together in one transaction. Never raw-INSERT an active row; never flip
 * those columns by hand.
 *
 * ✅ Verified 2026-07-19 against the live function (`\df+ activate_thesis_version` →
 * `p_thesis_id uuid`, `GRANT ... TO anon`), and end-to-end over REST with a throwaway
 * thesis row (insert inactive → RPC → row flips `active`, `default` thesis untouched
 * → row deleted). The parameter is `p_thesis_id` — the earlier `{ thesis_id }` guess
 * 404s with PGRST202 ("Could not find the function ... in the schema cache"), a
 * silent failure at demo time. Fixed below; do not revert to the unprefixed name.
 */
export async function publishThesisVersion(params: {
  name: string;
  config: ThesisConfig;
  version: number;
}): Promise<Result<ThesisRow>> {
  const inserted = await restPost<ThesisRow[]>(
    "/theses",
    { name: params.name, config: params.config, version: params.version, active: false },
    { preferReturnRepresentation: true },
  );
  if (!inserted.ok) return inserted;
  const row = inserted.data[0];
  if (!row) {
    return fail({
      kind: "parse",
      message: "The new thesis version was created but not returned by the database.",
    });
  }

  const activated = await restPost<unknown>("/rpc/activate_thesis_version", {
    p_thesis_id: row.id,
  });
  if (!activated.ok) {
    return fail({
      ...activated.error,
      message: `Version ${row.version} was created but could not be made active: ${activated.error.message}`,
    });
  }
  return ok(row);
}

// ---------------------------------------------------------------------------
// `score_components` — the founder-score drill-down (data-contracts.md §9)
// ---------------------------------------------------------------------------

export type CriterionVerdict = "met" | "self_asserted" | "not_met" | "cannot_assess";

export interface ScoreComponentRow {
  id: string;
  /** NULL on the insufficient-evidence branch — the breakdown is kept even when no
   * score row was written. */
  score_id: string | null;
  founder_id: string;
  run_id: string;
  subscorer: string;
  criterion_id: string;
  verdict: CriterionVerdict;
  weight: number;
  credit: number | null;
  /** Percentage points. */
  contribution: number | null;
  evidence_tier: string | null;
  claim_ids: string[];
  /** Substring-verified; NULL if verification failed — a NULL quote beside a non-NULL
   * `rationale` is the visible signature of the backend rejecting the model's quote.
   * Surface it, it is a feature, not a blank. */
  quote_verbatim: string | null;
  /** The LLM's interpretation — kept deliberately separate from the verified quote.
   * Never style these two the same way. */
  rationale: string | null;
  what_would_close_it: string | null;
  /** Red-flag id, if the verdict was demoted. Never render a demotion as a point
   * deduction — it demotes the verdict, it does not subtract from the score. */
  demoted_by: string | null;
  created_at: string;
}

export function getScoreComponents(query?: RestQuery): Promise<Result<ScoreComponentRow[]>> {
  return restGet<ScoreComponentRow[]>("/score_components", {
    select: "*",
    order: "run_id.desc,subscorer.asc",
    ...query,
  });
}

// ---------------------------------------------------------------------------
// `memos` — the memo screen's source table (db/schema.sql, no dedicated view yet)
// ---------------------------------------------------------------------------
//
// Feature 06 (`generate-memo`) has not shipped — this table has 0 rows in every
// environment today. That is the normal case, not an error: `getMemos`/`getCurrentMemo`
// resolving to an EMPTY, SUCCESSFUL result is "no memo generated yet" (brief §10 —
// render `No memo generated yet` with a `Generate memo` action); a `Result` with
// `ok: false` is "the read itself failed" (brief §12.3 — render the read-failure
// notice). These are opposite findings and must never be conflated — the `Result<T>`
// type already keeps them apart everywhere else in this file; nothing extra to build.

/** Investment-committee vocabulary — four values, not the earlier three. `'invest'`
 * and `'watch'` never shipped past an early draft of this schema; do not encode them
 * anywhere. Migrated and constraint-verified live 2026-07-19. */
export type MemoRecommendation = "proceed" | "proceed-with-conditions" | "pass" | "watchlist";

/**
 * A memo row is immutable and append-only (no `status`, no `updated_at` column) —
 * regenerating a memo writes a NEW `(application_id, version)` row; the current memo
 * for an application is its highest `version`. Never UPDATE or reuse a row client-side.
 */
export interface MemoRow {
  id: string;
  application_id: string;
  version: number;
  /**
   * jsonb. The database enforces only that these five keys are present (brief §10's
   * required sections) — `sections ?& array['snapshot','hypotheses','swot',
   * 'problem_product','traction']`. Optional sections (risk matrix, competition,
   * financials-lite) may also appear as extra keys, included only when there is real
   * content. ⚠️ The internal shape of each section's value is NOT part of the table
   * schema and is not frozen anywhere yet (feature 06 is unbuilt) — treated as opaque
   * here rather than guessed. Re-type this once feature 06 ships its actual payload.
   */
  sections: {
    snapshot: unknown;
    hypotheses: unknown;
    swot: unknown;
    problem_product: unknown;
    traction: unknown;
    [optionalSection: string]: unknown;
  };
  /** jsonb, defaults to `{}`. Shape not frozen — same caveat as `sections`. */
  gaps: Record<string, unknown>;
  /** The memo → claim → evidence → raw_signal chain (Agentic Traceability) — every
   * inline verdict badge in the memo prose should trace back to one of these. */
  cited_claim_ids: string[];
  /** Nullable — a memo row can in principle exist before a recommendation is set.
   * Render the recommendation banner only when non-null. */
  recommendation: MemoRecommendation | null;
  /** jsonb, present only when `recommendation === 'proceed-with-conditions'`. Shape
   * not frozen — same caveat as `sections`. */
  conditions: unknown;
  /** jsonb — the "Where to dig" block's source (brief §10). Shape not frozen — same
   * caveat as `sections`. */
  deep_dive_questions: unknown;
  created_at: string;
}

export function getMemos(query?: RestQuery): Promise<Result<MemoRow[]>> {
  return restGet<MemoRow[]>("/memos", {
    select: "*",
    order: "application_id.asc,version.desc",
    ...query,
  });
}

/**
 * Resolves "the current memo for this application" — highest `version`, per the
 * table's own invariant. `data: null` means no memo row exists yet (the normal case
 * today); this is a successful read, not a failure — check `.ok` first, as always.
 */
export async function getCurrentMemo(applicationId: string): Promise<Result<MemoRow | null>> {
  const res = await getMemos({
    filters: { application_id: `eq.${applicationId}` },
    order: "version.desc",
    limit: 1,
  });
  if (!res.ok) return res;
  return ok(res.data[0] ?? null);
}

// ---------------------------------------------------------------------------
// §6 Writes — n8n webhooks + the one PostgREST RPC (activate_thesis_version, above)
// ---------------------------------------------------------------------------

/**
 * ⏳ Request/response body not yet frozen upstream. The card's "Suggest follow-up
 * questions" action reads the card's gaps alone — there is no manager-notes input
 * (cut, brief §6, no notes table exists). Re-verify against the live workflow before
 * wiring; fix this one call site rather than guessing again elsewhere.
 */
export interface SuggestFollowUpRequest {
  application_id: string;
}

export interface SuggestFollowUpQuestion {
  question: string;
  closes_gap: string;
}

export interface SuggestFollowUpResponse {
  questions: SuggestFollowUpQuestion[];
  email_preview: { subject: string; body: string };
}

/** Slow write (brief §12.5): no optimistic UI — disable the control while in flight
 * and show a labelled pending state; this calls a model and takes real seconds. */
export function suggestFollowUp(
  payload: SuggestFollowUpRequest,
): Promise<Result<SuggestFollowUpResponse>> {
  return n8nPost<SuggestFollowUpResponse>(
    "/webhook/f09-suggest-followup",
    payload,
    WRITE_TIMEOUT_MS,
  );
}

/**
 * ⏳ Request/response body not yet frozen upstream (owned by feature 11). Modelled as
 * a confirm-and-erase call against a single founder; re-verify field names before
 * wiring.
 */
export interface PurgeFounderRequest {
  founder_id: string;
  reason?: string;
}

export interface PurgeFounderResponse {
  purged: boolean;
  /** e.g. `["claims", "score_components", "events"]`. */
  erased: string[];
}

/** GDPR delete-on-request (brief §9.7). Irreversible — the caller must confirm before
 * invoking this, naming exactly what will be erased. */
export function purgeFounderData(
  payload: PurgeFounderRequest,
): Promise<Result<PurgeFounderResponse>> {
  return n8nPost<PurgeFounderResponse>("/webhook/f11-purge", payload, WRITE_TIMEOUT_MS);
}

// --- NL-search — data-contracts.md §10, frozen -------------------------------

export type NlAttributeState =
  "matched" | "matched_broadened" | "mismatch" | "unknown" | "unknown_searched";

export interface NlSearchEvidence {
  claim_id?: string;
  quote_verbatim?: string | null;
  source_url?: string;
  tier?: "documented" | "discovered" | "inferred" | "missing";
}

export interface NlSearchAttribute {
  id: string;
  state: NlAttributeState;
  weight: number;
  tier_credit?: number;
  /** e.g. `"city→country"`. */
  broadening?: string;
  /** Verbatim, guaranteed present whenever `broadening` is set. Render as-is. */
  resolved_as?: string;
  /** e.g. `"no data — lowers confidence, not rank"`. */
  note?: string;
  evidence?: NlSearchEvidence;
}

export interface NlSearchUnresolvable {
  label: string;
  /** `"no_data_source"` → *we hold no data of this kind*; `"not_testable"` → *no way
   * to test this against what we hold*. Show the human-readable reason, never the raw
   * enum. */
  reason: "no_data_source" | "not_testable" | string;
}

export interface NlSearchItem {
  founder_id: string;
  full_name: string;
  is_synthetic: boolean;
  company_id: string;
  company_name: string;
  application_id: string;
  /** Null when nothing was assessed — never render as 0. */
  rank_score: number | null;
  confidence: number;
  confidence_bucket: "high" | "mid" | "low" | null;
  /** Count-based, not weight-based. */
  coverage: number;
  /** Sibling of `rank_score`, never folded into it. */
  evidence_quality: number;
  founder_score: number | null;
  founder_score_assessed: boolean;
  attributes: NlSearchAttribute[];
}

export interface NlSearchResponse {
  query: string;
  plan: {
    /** Echoed, with the weights the executor applied. */
    attributes: Array<Record<string, unknown>>;
    unresolvable: NlSearchUnresolvable[];
  };
  items: NlSearchItem[];
  /** confidence < 0.25 — a labelled section of its own, never interleaved with
   * `items`. Dropping these would hide exactly the sparse-footprint founder the
   * product exists to find. */
  low_confidence: NlSearchItem[];
  /** Candidates scored, not "founders in the world matching". */
  total: number;
  /** Refers to the 200-candidate cap only — `total > limit` is normal, not truncation. */
  truncated: boolean;
  low_confidence_only: boolean;
  note?: string;
}

/**
 * ⚠️ Sort by `bucket_ordinal DESC, rank_score DESC NULLS LAST, founder_id ASC` where
 * `{high:3, mid:2, low:1}` — never sort the bucket *string*; alphabetically
 * `'high' < 'low' < 'mid'`, so a naive descending string sort silently inverts intent.
 *
 * On non-2xx, the error resolves through the normal `Result` channel: `error.kind`
 * is `"http"` and `error.upstreamKind` carries f10's own kind — one of `empty_query`
 * (not retryable), `resolver_failed` (retryable), `invalid_target` (not retryable),
 * `unresolvable_query` (Fate C — whole-plan rejection, not retryable; keep the
 * original query on screen and editable, copy it as "the search couldn't be
 * interpreted safely, so nothing was run rather than running the wrong search"),
 * `upstream_timeout` (retryable), `limit_exceeded` (not retryable). `error.retryable`
 * mirrors the same signal as a boolean.
 */
export function nlSearch(query: string, limit = 10): Promise<Result<NlSearchResponse>> {
  return n8nPost<NlSearchResponse>("/webhook/f10-nl-search", { query, limit }, SEARCH_TIMEOUT_MS);
}
