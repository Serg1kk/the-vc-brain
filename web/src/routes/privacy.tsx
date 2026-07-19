import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "../components/PageShell";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — The VC Brain" },
      { name: "description", content: "What we collect, why, and your rights." },
      { property: "og:title", content: "Privacy — The VC Brain" },
      { property: "og:description", content: "What we collect, why, and your rights." },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <PageShell>
      <div className="space-y-6">
        <h1>Privacy</h1>

        <section className="space-y-3">
          <h2 className="text-[16px] font-semibold">What we collect and why</h2>
          <p className="text-[14px]">
            When you apply, we store what you send us: your company name, your email, your deck, and
            any links or files you add.
          </p>
          <p className="text-[14px]">
            We also look at public information about your work — public code repositories, public
            posts, and your own website — to check what your deck says against what already exists
            publicly. We only collect signals about your ability to build and ship. We do not
            collect age, photos, health, political, religious, or any other sensitive personal
            information.
          </p>
          <p className="text-[14px]">
            The legal basis is our legitimate interest in assessing an investment, and we hold
            ourselves to honouring any objection or deletion request without conditions.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[16px] font-semibold">Your rights</h2>
          <p className="text-[14px]">
            You can ask us for a copy of your data, ask us to correct it, or ask us to delete it. We
            respond within one month. Deletion removes your data from our system entirely.
          </p>
          {/*
            This page makes the only legal commitments in the product, so its contact
            channel has to be one that exists. It previously said "reply to the
            confirmation email you received" — but email delivery is mocked in this
            build and no confirmation email is ever sent, so the one route to exercising
            a data-subject right pointed at nothing. Flagged by design.md §11 and again
            by the QA gate. Stated honestly instead, until feature 11 attaches the
            deletion control to this page.
          */}
          <p className="text-[14px]">
            To make a request, contact the investor you applied to, and we will action it.
          </p>
          <p className="text-[13px] text-[color:var(--color-text-muted)]">
            This is a prototype: automated email is not enabled in this build, so requests are
            handled by a person rather than through a self-service button. The commitments above
            still apply.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
