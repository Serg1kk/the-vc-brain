// Typed fetch client for the n8n backend.
// All calls are browser-only. Base URL comes from VITE_N8N_BASE_URL.
// See brief §4 for the frozen contracts.

import {
  ApiError,
  type FollowUpAnswersRequest,
  type FollowUpGetResponse,
  type GapAnswersRequest,
  type GapAnswersResponse,
  type IntakeResponse,
  type IntakeSubmission,
  type StatusResponse,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const INTAKE_TIMEOUT_MS = 90_000;

function baseUrl(): string {
  const url = import.meta.env.VITE_N8N_BASE_URL as string | undefined;
  if (!url) {
    throw new ApiError(
      "internal",
      "The backend base URL is not configured. Set VITE_N8N_BASE_URL and reload.",
    );
  }
  return url.replace(/\/$/, "");
}

async function request<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof ApiError) throw err;
    const aborted =
      err instanceof DOMException && err.name === "AbortError";
    throw new ApiError(
      aborted ? "internal" : "internal",
      aborted
        ? "The request took too long. Try again in a moment."
        : "We couldn't reach the server. Check your connection and try again.",
    );
  }
  clearTimeout(timer);

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object"
        ? (body.error as { code?: string; message?: string })
        : null;
    throw new ApiError(err?.code ?? "internal", err?.message ?? "");
  }

  return body as T;
}

export function submitIntake(payload: IntakeSubmission): Promise<IntakeResponse> {
  return request<IntakeResponse>(
    "/webhook/f08-intake-submit",
    { method: "POST", body: JSON.stringify(payload) },
    INTAKE_TIMEOUT_MS,
  );
}

export function submitGapAnswers(
  payload: GapAnswersRequest,
): Promise<GapAnswersResponse> {
  return request<GapAnswersResponse>(
    "/webhook/f08-gap-answers",
    { method: "POST", body: JSON.stringify(payload) },
    DEFAULT_TIMEOUT_MS,
  );
}

export function getApplicationStatus(
  applicationId: string,
): Promise<StatusResponse> {
  const q = encodeURIComponent(applicationId);
  return request<StatusResponse>(
    `/webhook/f08-application-status?application_id=${q}`,
    { method: "GET" },
    DEFAULT_TIMEOUT_MS,
  );
}

export function getFollowUp(token: string): Promise<FollowUpGetResponse> {
  const q = encodeURIComponent(token);
  return request<FollowUpGetResponse>(
    `/webhook/f08-followup?token=${q}`,
    { method: "GET" },
    DEFAULT_TIMEOUT_MS,
  );
}

export function submitFollowUpAnswers(
  payload: FollowUpAnswersRequest,
): Promise<GapAnswersResponse> {
  return request<GapAnswersResponse>(
    "/webhook/f08-followup-answers",
    { method: "POST", body: JSON.stringify(payload) },
    DEFAULT_TIMEOUT_MS,
  );
}
