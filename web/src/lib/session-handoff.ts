// Small typed sessionStorage handoff between the intake screens.
// Router state would work too, but sessionStorage lets /apply/status
// recover after a hard refresh (per brief §8).

import type { GapQuestion, IntakeResponse } from "./types";

const APP_ID_KEY = "vcbrain.application_id";
const INTAKE_KEY = "vcbrain.intake_response";
const GAP_KEY = "vcbrain.gap_questions";
const COMPANY_KEY = "vcbrain.company_name";

function safeSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* quota or disabled — non-fatal */
  }
}

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveIntakeResponse(companyName: string, response: IntakeResponse) {
  safeSet(APP_ID_KEY, response.application_id);
  safeSet(INTAKE_KEY, JSON.stringify(response));
  safeSet(GAP_KEY, JSON.stringify(response.gap_questions));
  safeSet(COMPANY_KEY, companyName);
}

export function getSavedApplicationId(): string | null {
  return safeGet(APP_ID_KEY);
}

export function getSavedCompanyName(): string | null {
  return safeGet(COMPANY_KEY);
}

export function getSavedIntakeResponse(): IntakeResponse | null {
  const raw = safeGet(INTAKE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IntakeResponse;
  } catch {
    return null;
  }
}

export function getSavedGapQuestions(): GapQuestion[] | null {
  const raw = safeGet(GAP_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as GapQuestion[]) : null;
  } catch {
    return null;
  }
}

export function clearGapQuestions() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(GAP_KEY);
  } catch {
    /* noop */
  }
}
