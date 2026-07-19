import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageShell } from "../components/PageShell";
import { StatusTimeline } from "../components/StatusTimeline";
import { getApplicationStatus } from "../lib/api";
import { relativeTime } from "../lib/format";
import {
  getSavedApplicationId,
  getSavedCompanyName,
  getSavedIntakeResponse,
} from "../lib/session-handoff";
import { ApiError, type StatusResponse } from "../lib/types";

export const Route = createFileRoute("/apply/status")({
  head: () => ({
    meta: [
      { title: "Application received — The VC Brain" },
      { name: "description", content: "Your application has been received. A verdict will follow within 24 hours." },
      { property: "og:title", content: "Application received — The VC Brain" },
      { property: "og:description", content: "Your application has been received." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Status,
});

interface Local {
  applicationId: string;
  companyName: string;
  status: "screening" | "diligence" | "decision";
  submittedAt: string;
  verdictEtaHours: number;
  openQuestions: number;
  deckWarning: "image_only_deck" | "extraction_failed" | null;
}

function Status() {
  const [state, setState] = useState<Local | "loading" | "empty" | { error: string }>("loading");

  useEffect(() => {
    const savedId = getSavedApplicationId();
    if (!savedId) {
      setState("empty");
      return;
    }
    const savedIntake = getSavedIntakeResponse();
    const savedCompany = getSavedCompanyName();

    // Try the fresh status endpoint first (recovers after refresh).
    let cancelled = false;
    (async () => {
      try {
        const s: StatusResponse = await getApplicationStatus(savedId);
        if (cancelled) return;
        setState({
          applicationId: s.application_id,
          companyName: s.company_name,
          status: s.status,
          submittedAt: s.submitted_at,
          verdictEtaHours: s.verdict_eta_hours,
          openQuestions: s.open_questions,
          deckWarning: savedIntake?.deck.warning ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        // If we have a fresh intake response from this session, fall back to it.
        if (savedIntake && savedCompany) {
          setState({
            applicationId: savedIntake.application_id,
            companyName: savedCompany,
            status: savedIntake.status,
            submittedAt: new Date().toISOString(),
            verdictEtaHours: savedIntake.verdict_eta_hours,
            openQuestions: savedIntake.gap_questions.length,
            deckWarning: savedIntake.deck.warning,
          });
          return;
        }
        setState({
          error:
            err instanceof ApiError && err.message
              ? err.message
              : "We couldn't fetch the latest status. Please try again shortly.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <PageShell>
        <p className="text-[14px] text-[color:var(--color-text-muted)]">Loading…</p>
      </PageShell>
    );
  }

  if (state === "empty") {
    return (
      <PageShell>
        <h1>No application in this session</h1>
        <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
          <Link to="/apply" className="text-[color:var(--color-accent)] hover:underline">
            Start an application
          </Link>
          .
        </p>
      </PageShell>
    );
  }

  if ("error" in state) {
    return (
      <PageShell>
        <ErrorNotice message={state.error} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <header>
          <h1>Application received</h1>
          <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
            {state.companyName} — submitted {relativeTime(state.submittedAt)}.
          </p>
        </header>

        <div>
          <StatusTimeline status={state.status} />
          <p className="mt-3 text-[13px] text-[color:var(--color-text-muted)]">
            Verdict expected within {state.verdictEtaHours} hours.
          </p>
        </div>

        {state.deckWarning === "image_only_deck" ? (
          <div
            role="note"
            className="ms-rule"
          >
            <p className="text-[14px]">
              We could not read text from your deck — it looks like the slides are images.
            </p>
            <p className="mt-2 text-[14px]">
              We've stored it for the investor to read directly, and we've noted in your file
              that our automatic reading of it was limited. This lowers how much we can verify
              on our own; it does not count against you.
            </p>
          </div>
        ) : null}

        {state.deckWarning === "extraction_failed" ? (
          <div
            role="note"
            className="ms-rule"
          >
            <p className="text-[14px]">We couldn't read this file at all.</p>
            <p className="mt-2 text-[14px]">
              We've stored it for the investor to read directly. This does not count against you.
            </p>
          </div>
        ) : null}

        {state.openQuestions > 0 ? (
          <p className="text-[14px]">
            You left {state.openQuestions} question{state.openQuestions === 1 ? "" : "s"}{" "}
            unanswered.{" "}
            <Link to="/apply/questions" className="text-[color:var(--color-accent)] hover:underline">
              You can still add them.
            </Link>
          </p>
        ) : null}

        <p className="text-[13px] text-[color:var(--color-text-muted)]">
          Your answers are visible only to the investor reviewing your application.
        </p>
      </div>
    </PageShell>
  );
}
