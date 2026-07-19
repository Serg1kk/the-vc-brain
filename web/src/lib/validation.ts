import type { ArtifactKind } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCompanyName(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return "Enter your company name.";
  if (v.length > 120) return "Keep it under 120 characters.";
  return null;
}

export function validateEmail(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return "Enter an email we can reach you at.";
  if (v.length > 254) return "That email is too long.";
  if (!EMAIL_RE.test(v)) return "That doesn't look like a valid email.";
  return null;
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const MAX_DECK_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRA_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRA_COUNT = 3;
export const MAX_LINK_COUNT = 5;

export function validateDeckFile(file: File | null): string | null {
  if (!file) return "Attach your deck as a PDF.";
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "Only PDF files are accepted here.";
  if (file.size > MAX_DECK_BYTES) return "The deck is over 10 MB. Trim it and try again.";
  return null;
}

export function validateExtraFile(file: File): string | null {
  if (file.size > MAX_EXTRA_BYTES) return "This file is over 25 MB.";
  return null;
}

export function parseUrlSafe(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Reject any credentials embedded in the URL.
  if (u.username || u.password) return null;
  return u;
}

export function validateLinkUrl(raw: string): string | null {
  if (!raw.trim()) return null; // empty rows are dropped silently
  const u = parseUrlSafe(raw);
  if (!u) return "Enter a valid http(s) URL.";
  return null;
}

export function inferArtifactKind(url: string): ArtifactKind {
  const u = parseUrlSafe(url);
  if (!u) return "other";
  const host = u.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return "github_repo";
    if (parts.length === 1) return "github_user";
    return "other";
  }
  return "product";
}
