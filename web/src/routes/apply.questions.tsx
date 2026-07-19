import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageShell } from "../components/PageShell";
import { QuestionCard } from "../components/QuestionCard";
import { submitGapAnswers } from "../lib/api";
import { questionsTitle } from "../lib/format";
import {
  clearGapQuestions,
  getSavedApplicationId,
  getSavedGapQuestions,
} from "../lib/session-handoff";
import { ApiError, type GapAnswer } from "../lib/types";

export const Route = createFileRoute("/apply/questions")({
  head: () => ({
    meta: [
      { title: "A few follow-up questions — The VC Brain" },
      {
        name: "description",
        content: "Optional follow-up questions to fill in what your deck didn't cover.",
      },
      { property: "og:title", content: "A few follow-up questions — The VC Brain" },
      { property: "og:description", content: "Optional follow-up questions." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Questions,
});

function Questions() {
  const navigate = useNavigate();
  const applicationId = useMemo(getSavedApplicationId, []);
  const gapQuestions = useMemo(getSavedGapQuestions, []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!applicationId || !gapQuestions || gapQuestions.length === 0) {
    return <Navigate to="/apply" replace />;
  }

  async function send(kind: "submit" | "skip") {
    if (busy) return;
    setBusy(true);
    setError(null);

    const filledAnswers: GapAnswer[] = [];
    const skipped: string[] = [];

    for (const q of gapQuestions!) {
      const raw = (answers[q.criterion_id] ?? "").trim();
      if (kind === "skip" || raw.length === 0) {
        skipped.push(q.criterion_id);
      } else {
        filledAnswers.push({
          criterion_id: q.criterion_id,
          question: q.question,
          answer_text: raw,
        });
      }
    }

    try {
      await submitGapAnswers({
        application_id: applicationId!,
        answers: filledAnswers,
        skipped_criterion_ids: skipped,
      });
      clearGapQuestions();
      navigate({ to: "/apply/status" });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.message) setError(err.message);
      else setError("Something went wrong on our side. Your answers are still here — try again.");
    }
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <header>
          <h1>{questionsTitle(gapQuestions.length)}</h1>
          <p className="mt-3 text-[15px] text-[color:var(--color-text-muted)]">
            Optional. About two minutes. Skipping any of these does not count against you — it only
            means we'll have less to go on.
          </p>
        </header>

        {error ? <ErrorNotice message={error} /> : null}

        <div className="space-y-4">
          {gapQuestions.map((q, i) => (
            <QuestionCard
              key={q.criterion_id}
              question={q}
              value={answers[q.criterion_id] ?? ""}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q.criterion_id]: v }))}
              index={i}
              total={gapQuestions.length}
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
