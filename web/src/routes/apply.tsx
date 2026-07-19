import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { ArtifactLinkList } from "../components/ArtifactLinkList";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { ErrorNotice } from "../components/ErrorNotice";
import { ExtraFilesList } from "../components/ExtraFilesList";
import { FileDropzone } from "../components/FileDropzone";
import { NextPhasePanel } from "../components/NextPhasePanel";
import { PageShell } from "../components/PageShell";
import { SubmitProgress } from "../components/SubmitProgress";
import { submitIntake } from "../lib/api";
import { fileToBase64 } from "../lib/file";
import { getIntakeSubmissionId } from "../lib/idempotency";
import { saveIntakeResponse } from "../lib/session-handoff";
import { ApiError, type ArtifactLink, type ExtraFile } from "../lib/types";
import {
  inferArtifactKind,
  normaliseEmail,
  parseUrlSafe,
  validateCompanyName,
  validateDeckFile,
  validateEmail,
} from "../lib/validation";

export const Route = createFileRoute("/apply")({
  head: () => ({
    meta: [
      { title: "Apply — The VC Brain" },
      {
        name: "description",
        content:
          "Apply for a $100K pre-seed check. Three fields, a verdict within 24 hours.",
      },
      { property: "og:title", content: "Apply — The VC Brain" },
      {
        property: "og:description",
        content:
          "Apply for a $100K pre-seed check. Three fields, a verdict within 24 hours.",
      },
    ],
  }),
  component: Apply,
});

function Apply() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [deck, setDeck] = useState<File | null>(null);
  const [links, setLinks] = useState<string[]>([""]);
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [extraErrors, setExtraErrors] = useState<Record<string, string>>({});

  const [companyErr, setCompanyErr] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [deckErr, setDeckErr] = useState<string | null>(null);

  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const companyRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const deckFocusRef = useRef<HTMLDivElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const cErr = validateCompanyName(companyName);
    const eErr = validateEmail(email);
    const dErr = validateDeckFile(deck);
    setCompanyErr(cErr);
    setEmailErr(eErr);
    setDeckErr(dErr);

    if (cErr) {
      companyRef.current?.focus();
      return;
    }
    if (eErr) {
      emailRef.current?.focus();
      return;
    }
    if (dErr) {
      deckFocusRef.current?.focus();
      return;
    }

    setApiError(null);
    setSubmitting(true);

    try {
      const deckBase64 = await fileToBase64(deck!);
      const artifactLinks: ArtifactLink[] = links
        .map((raw) => raw.trim())
        .filter((raw) => raw.length > 0 && parseUrlSafe(raw) !== null)
        .slice(0, 5)
        .map((url) => ({ url, kind: inferArtifactKind(url) }));

      const extras: ExtraFile[] = [];
      for (const f of extraFiles.slice(0, 3)) {
        extras.push({
          filename: f.name,
          mime: f.type || "application/octet-stream",
          base64: await fileToBase64(f),
        });
      }

      const trimmedCompany = companyName.trim();
      const response = await submitIntake({
        intake_submission_id: getIntakeSubmissionId(),
        company_name: trimmedCompany,
        contact_email: normaliseEmail(email),
        deck: {
          filename: deck!.name,
          mime: deck!.type || "application/pdf",
          base64: deckBase64,
        },
        artifact_links: artifactLinks.length ? artifactLinks : undefined,
        extra_files: extras.length ? extras : undefined,
      });

      saveIntakeResponse(trimmedCompany, response);

      if (response.gap_questions.length > 0) {
        navigate({ to: "/apply/questions" });
      } else {
        navigate({ to: "/apply/status" });
      }
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        if (err.code === "rate_limited") {
          setApiError("Too many attempts. Wait a minute and try again.");
        } else if (err.message) {
          setApiError(err.message);
        } else {
          setApiError(
            "Something went wrong on our side. Your answers are still here — try again.",
          );
        }
      } else {
        setApiError(
          "Something went wrong on our side. Your answers are still here — try again.",
        );
      }
    }
  }

  return (
    <PageShell>
      <div className="space-y-8">
        <header>
          <h1>Apply for a $100K pre-seed check</h1>
          <p className="mt-3 text-[15px] text-[color:var(--color-text-muted)]">
            Three fields. A verdict within 24 hours. We do the research ourselves — you don't
            need to write a summary of your own company.
          </p>
        </header>

        <DisclosureBanner />

        {apiError ? (
          <ErrorNotice message={apiError} />
        ) : null}

        <form
          onSubmit={onSubmit}
          noValidate
          className="space-y-6"
          aria-busy={submitting}
        >
          <fieldset
            className="ms-rule space-y-4 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 sm:p-8 shadow-[0_1px_2px_rgba(10,15,60,0.04),0_20px_40px_-24px_rgba(10,15,60,0.15)]"
            disabled={submitting}
          >
            <legend className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">
              Your company
            </legend>

            <div>
              <label htmlFor="company-name" className="block">
                Company name
              </label>
              <input
                ref={companyRef}
                id="company-name"
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                onBlur={() => setCompanyErr(validateCompanyName(companyName))}
                maxLength={120}
                required
                aria-invalid={companyErr ? "true" : undefined}
                aria-describedby={companyErr ? "company-err" : undefined}
                className="mt-2 w-full rounded-md border border-[color:var(--color-border)] bg-white px-3 py-2 text-[14px] focus:border-[color:var(--color-accent)] focus:outline-none"
              />
              {companyErr ? (
                <p id="company-err" className="mt-1 text-[13px]" style={{ color: "var(--color-warn)" }}>
                  {companyErr}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="email" className="block">
                Contact email
              </label>
              <input
                ref={emailRef}
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailErr(validateEmail(email))}
                required
                aria-invalid={emailErr ? "true" : undefined}
                aria-describedby={emailErr ? "email-err" : undefined}
                className="mt-2 w-full rounded-md border border-[color:var(--color-border)] bg-white px-3 py-2 text-[14px] focus:border-[color:var(--color-accent)] focus:outline-none"
              />
              {emailErr ? (
                <p id="email-err" className="mt-1 text-[13px]" style={{ color: "var(--color-warn)" }}>
                  {emailErr}
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset
            className="ms-rule rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 sm:p-8 shadow-[0_1px_2px_rgba(10,15,60,0.04),0_20px_40px_-24px_rgba(10,15,60,0.15)]"
            disabled={submitting}
          >
            <legend className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">
              Your deck
            </legend>
            <div ref={deckFocusRef} tabIndex={-1} className="mt-2 outline-none">
              <FileDropzone
                id="deck"
                label="Deck (PDF, up to 10 MB)"
                accept="application/pdf,.pdf"
                file={deck}
                onFile={(f) => {
                  setDeck(f);
                  setDeckErr(validateDeckFile(f));
                }}
                error={deckErr}
              />
            </div>
          </fieldset>

          <fieldset
            className="ms-rule rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 sm:p-8 shadow-[0_1px_2px_rgba(10,15,60,0.04),0_20px_40px_-24px_rgba(10,15,60,0.15)]"
            disabled={submitting}
          >
            <legend className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">
              Links <span className="ml-1 font-medium normal-case tracking-normal text-[color:var(--color-text-muted)]">— Optional</span>
            </legend>
            <p className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
              A repo, a live URL, or a notebook. These are worth more to us than slides.
            </p>
            <div className="mt-3">
              <ArtifactLinkList values={links} onChange={setLinks} />
            </div>
          </fieldset>

          <fieldset
            className="ms-rule rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 sm:p-8 shadow-[0_1px_2px_rgba(10,15,60,0.04),0_20px_40px_-24px_rgba(10,15,60,0.15)]"
            disabled={submitting}
          >
            <legend className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">
              Anything else <span className="ml-1 font-medium normal-case tracking-normal text-[color:var(--color-text-muted)]">— Optional</span>
            </legend>
            <p className="mt-1 text-[13px] text-[color:var(--color-text-muted)]">
              Stored with your application. Only PDFs are read automatically in this version —
              anything else is kept for the investor to open.
            </p>
            <div className="mt-3">
              <ExtraFilesList
                files={extraFiles}
                errors={extraErrors}
                onFiles={setExtraFiles}
                onErrors={setExtraErrors}
              />
            </div>
          </fieldset>

          {submitting ? <SubmitProgress /> : null}

          <div>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full px-7 py-3 text-[14px] font-medium disabled:opacity-70 transition-opacity"
              style={{
                background: "var(--color-accent-soft)",
                color: "var(--color-accent-soft-foreground)",
              }}
            >
              {submitting ? "Reading your deck…" : "Submit application"}
            </button>
            <p className="mt-2 text-[13px] text-[color:var(--color-text-muted)]">
              We'll ask at most three short follow-up questions — optional, about two minutes.
            </p>
          </div>
        </form>

        <NextPhasePanel />
      </div>
    </PageShell>
  );
}
