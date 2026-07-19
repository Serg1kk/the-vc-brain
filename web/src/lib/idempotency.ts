// The intake_submission_id is the idempotency key for /webhook/f08-intake-submit.
// Generated once per form session and reused on retry so a network hiccup
// cannot create two applications for the same submission.

const KEY = "vcbrain.intake_submission_id";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback — never expected in a modern browser, but keeps types honest.
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getIntakeSubmissionId(): string {
  if (typeof window === "undefined") return newId();
  const existing = window.sessionStorage.getItem(KEY);
  if (existing) return existing;
  const id = newId();
  window.sessionStorage.setItem(KEY, id);
  return id;
}

export function resetIntakeSubmissionId(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(KEY);
}
