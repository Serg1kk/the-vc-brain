import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageShell } from "../components/PageShell";
import { QuestionCard } from "../components/QuestionCard";
import { getFollowUp, submitFollowUpAnswers } from "../lib/api";
import { ApiError, type FollowUpGetResponse, type GapAnswer } from "../lib/types";

export const Route = createFileRoute("/a/$token")({
  head: () => ({
    meta: [
      { title: "Follow-up questions — The VC Brain" },
      { name: "description", content: "Answer follow-up questions from your investor." },
      { property: "og:title", content: "Follow-up questions — The VC Brain" },
      { property: "og:description", content: "Answer follow-up questions from your investor." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FollowUp,
});

function FollowUp() {
  const { token } = Route.useParams();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "data"; data: FollowUpGetResponse }
    | { kind: "done" }
  >({ kind: "loading" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getFollowUp(token);
        if (!cancelled) setState({ kind: "data", data });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof ApiError && err.message
              ? err.message
              : "We couldn't load this link. Please try again shortly.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return (
      <PageShell>
        <p className="text-[14px] text-[color:var(--color-text-muted)]">Loading…</p>
      </PageShell>
    );
  }

  if (state.kind === "error") {
    return (
      <PageShell>
        <ErrorNotice message={state.message} />
      </PageShell>
    );
  }

  if (state.kind === "done") {
    return (
      <PageShell>
        <h1>Thanks — sent.</h1>
        <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
          Your answers are visible only to the investor reviewing your application.
        </p>
      </PageShell>
    );
  }

  const data = state.data;

  if (!data.valid) {
    return (
      <PageShell>
        <h1>This link is no longer valid.</h1>
        <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
          Links expire 24 hours after they're sent. Ask the investor who sent it for a new one.
        </p>
      </PageShell>
    );
  }

  if (data.already_answered) {
    return (
      <PageShell>
        <h1>These questions have already been answered.</h1>
        <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
          Nothing to do here.
        </p>
      </PageShell>
    );
  }

  async function send(kind: "submit" | "skip") {
    if (busy || !data.valid) return;
    setBusy(true);
    setSubmitError(null);
    const filled: GapAnswer[] = [];
    const skipped: string[] = [];
    for (const q of data.questions) {
      const raw = (answers[q.criterion_id] ?? "").trim();
      if (kind === "skip" || raw.length === 0) {
        skipped.push(q.criterion_id);
      } else {
        filled.push({ criterion_id: q.criterion_id, question: q.question, answer_text: raw });
      }
    }
    try {
      await submitFollowUpAnswers({
        token,
        answers: filled,
        skipped_criterion_ids: skipped,
      });
      setState({ kind: "done" });
    } catch (err) {
      setBusy(false);
      setSubmitError(
        err instanceof ApiError && err.message
          ? err.message
          : "Something went wrong on our side. Your answers are still here — try again.",
      );
    }
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <header>
          <h1>A few follow-up questions about {data.company_name}</h1>
          <p className="mt-3 text-[14px] text-[color:var(--color-text-muted)]">
            From {data.asked_by}. About {data.estimated_minutes} minute
            {data.estimated_minutes === 1 ? "" : "s"}.
          </p>
          {data.note ? (
            <p className="mt-3 text-[14px] text-[color:var(--color-text)]">{data.note}</p>
          ) : null}
        </header>

        {submitError ? <ErrorNotice message={submitError} /> : null}

        <div className="space-y-4">
          {data.questions.map((q, i) => (
            <QuestionCard
              key={q.criterion_id}
              question={q}
              value={answers[q.criterion_id] ?? ""}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q.criterion_id]: v }))}
              index={i}
              total={data.questions.length}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => send("submit")}
            className="rounded-[6px] px-4 py-2.5 text-[14px] font-medium text-white disabled:opacity-70"
            style={{ background: "var(--color-accent)" }}
          >
            {busy ? "Sending…" : "Submit answers"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => send("skip")}
            className="text-[13px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"
          >
            Skip and finish
          </button>
        </div>
      </div>
    </PageShell>
  );
}
