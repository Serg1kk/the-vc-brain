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
            When you apply, we store what you send us: your company name, your email, your
            deck, and any links or files you add.
          </p>
          <p className="text-[14px]">
            We also look at public information about your work — public code repositories,
            public posts, and your own website — to check what your deck says against what
            already exists publicly. We only collect signals about your ability to build and
            ship. We do not collect age, photos, health, political, religious, or any other
            sensitive personal information.
          </p>
          <p className="text-[14px]">
            The legal basis is our legitimate interest in assessing an investment, and we hold
            ourselves to honouring any objection or deletion request without conditions.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[16px] font-semibold">Your rights</h2>
          <p className="text-[14px]">
            You can ask us for a copy of your data, ask us to correct it, or ask us to delete
            it. We respond within one month. Deletion removes your data from our system
            entirely.
          </p>
          <p className="text-[14px]">
            To make a request, reply to the confirmation email you received.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
