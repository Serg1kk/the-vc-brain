// /app/settings — "Agent Access". Full spec: internal/submission/dashboard-settings-prompt.md
// (read it in full before touching this screen — this comment summarizes, it isn't the source
// of truth). The product's differentiator is agent-first access: the same data a human reads
// in this dashboard, a machine reads through one endpoint. This screen makes that self-serve.
//
// Pure client-side compose — no network calls, no route loader. It only reads
// import.meta.env + window.location and formats text for copying. Three copyable things and
// nothing else: endpoint, token, agent prompt.
//
// No real per-user token issuance exists (no auth backend, no RLS — the Supabase anon key has
// read+write). This screen shows the platform's shared demo read-token, honestly labelled,
// rather than faking a "generate" flow.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [{ title: "Agent Access — The VC Brain" }, { name: "robots", content: "noindex" }],
  }),
  component: Settings,
});

// Public, no-auth-needed raw links into the skill this product ships in its own repo —
// verified against origin/main (dashboard-settings-prompt.md's own provenance note).
const SKILL_URL =
  "https://raw.githubusercontent.com/Serg1kk/the-vc-brain/main/skills/vcbrain-cli/SKILL.md";
const CLI_URL = "https://raw.githubusercontent.com/Serg1kk/the-vc-brain/main/bin/vcbrain";

function resolveEndpoints(): { rest: string; api: string } {
  // On localhost these resolve to VITE_SUPABASE_REST_URL / VITE_N8N_BASE_URL (already declared
  // for the app, brief §3.2); the window.location.origin fallback only matters if those env
  // vars are ever unset in a real deployment, so a proxy in front of both services still works.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return {
    rest: (import.meta.env.VITE_SUPABASE_REST_URL as string | undefined) ?? `${origin}/rest/v1`,
    api: (import.meta.env.VITE_N8N_BASE_URL as string | undefined) ?? origin,
  };
}

// Verbatim template from dashboard-settings-prompt.md — do not paraphrase. The outer 3-space
// margin in that doc is the surrounding markdown box's decoration, not part of the literal
// prompt; the relative indentation of the numbered steps below IS preserved.
function buildAgentPrompt(rest: string, api: string, token: string): string {
  return `Connect yourself to The VC Brain — an AI-first VC platform with read-only agent access:
founder profiles with a persistent Founder Score, application screening on three independent
axes, a per-claim evidence ledger, and multi-attribute natural-language search.

There is a ready-made skill for this — do NOT build one from scratch. Install it:

1. Fetch the skill and its bundled CLI (public, no auth needed):
     ${SKILL_URL}
     ${CLI_URL}
2. Install the skill where your agent loads skills from (for Claude Code:
     ~/.claude/skills/vcbrain-cli/SKILL.md , and put \`vcbrain\` on your PATH or in ./bin).
   If your runtime has a skill-installer or a writing-skills / skill-creator tool, use it to
   install and validate the skill rather than hand-copying.
3. Configure this connection (the skill reads these env vars):
     export VCBRAIN_TOKEN="${token}"        # send as header  apikey: <token>  on REST calls
     export VCBRAIN_REST_URL="${rest}"
     export VCBRAIN_N8N_URL="${api}"
4. Verify it loaded — this is self-documenting, offline, and needs no token:
     ./bin/vcbrain schema
   It returns the full contract: every command, every view column, every error kind.

Once installed, the skill gives you four read operations (no write path exists anywhere):
   vcbrain schema                 — the full contract
   vcbrain search "<nl query>"    — ranked founders for a compound query, with match reasons
   vcbrain founder <id>           — Founder Score + evidence ledger for one person
   vcbrain application <id>       — the three screening axes + claims for one application

Then answer questions like "what's the Founder Score for X and what's the evidence behind it"
or "find founders matching technical founder, dev tools, real usage, no prior VC backing".
Everything is read-only.`;
}

// ---------------------------------------------------------------------------
// Small primitives, matching the thesis screen's hand-rolled elements — this feature bans
// shadcn's shadow/rounded button|input (see routes/app/thesis.tsx header comment), so every
// component/app/* file hand-rolls its own instead of reaching for components/ui/*.
// ---------------------------------------------------------------------------

function ReadOnlyField({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      className="w-full min-w-0 flex-1 border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2.5 py-[7px] font-mono text-[12.5px] text-[color:var(--color-text)]"
    />
  );
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard API can refuse (non-HTTPS, permissions) — the field stays selectable by
      // hand, so this is a silent no-op, not a dead end.
    }
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 cursor-pointer border border-[color:var(--color-text)] bg-[color:var(--color-bg)] px-3 py-[7px] text-[13px] font-medium whitespace-nowrap"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function EndpointField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[13px] text-[color:var(--color-text-muted)]">{label}</div>
      <div className="mt-1.5 flex items-stretch gap-2">
        <ReadOnlyField value={value} />
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[11.5px] font-semibold tracking-[0.08em] text-[color:var(--color-text-muted)] uppercase">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function Settings() {
  // The window.location.origin fallback is only real once mounted client-side — start from
  // the env-only resolution (correct whenever the env vars are set, true in every real
  // deployment) and refine on mount, same pattern as hooks/use-mobile.tsx.
  const [{ rest, api }, setEndpoints] = useState(() => resolveEndpoints());
  useEffect(() => {
    setEndpoints(resolveEndpoints());
  }, []);

  const token = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";
  const prompt = buildAgentPrompt(rest, api, token);

  return (
    <div className="px-9 py-7 pb-24">
      <div className="max-w-[820px]">
        <h1 className="m-0 text-[36px] leading-[1.15] font-medium tracking-[-0.02em]">
          Agent Access
        </h1>
        <p className="mt-1 max-w-[560px] text-[13px] text-[color:var(--color-text-muted)]">
          The same data a human reads in this dashboard, a machine reads through one endpoint.
          Connect a coding agent — Claude Code, Cursor, or any other — below.
        </p>
        <div className="ms-rule mt-4 mb-6" />

        {/* 1 — Your endpoint */}
        <SectionLabel>Your endpoint</SectionLabel>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <EndpointField label="REST" value={rest} />
          <EndpointField label="API" value={api} />
        </div>
        <p className="mt-2.5 text-[12px] text-[color:var(--color-text-muted)]">
          These update automatically wherever the platform is deployed.
        </p>

        {/* 2 — Your access token */}
        <div className="mt-8">
          <SectionLabel>Your access token</SectionLabel>
        </div>
        <div
          className="mt-3 border border-[color:var(--color-border)] px-3.5 py-2.5 text-[13px]"
          style={{ color: "var(--color-warn)" }}
        >
          Demo credential. This is the platform's shared read token, not per-user auth — treat it
          as a demo key, not a production secret.
        </div>
        <div className="mt-3 flex items-stretch gap-2">
          <ReadOnlyField value={token} />
          <CopyButton value={token} label="Copy token" />
          <button
            type="button"
            disabled
            title="Available in the hosted version"
            className="shrink-0 cursor-not-allowed border border-[color:var(--color-border)] px-3 py-[7px] text-[13px] font-medium text-[color:var(--color-text-muted)] opacity-50"
          >
            Regenerate
          </button>
        </div>

        {/* 3 — Connect your agent, the hero */}
        <div className="mt-8">
          <SectionLabel>Connect your agent</SectionLabel>
        </div>
        <p className="mt-1.5 max-w-[560px] text-[13px] text-[color:var(--color-text-muted)]">
          Copy this, paste it into your agent, and it connects itself — endpoint and token
          composed in live.
        </p>
        <div className="mt-3 border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
          <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3.5 py-2">
            <span className="text-[11px] text-[color:var(--color-text-muted)]">Agent prompt</span>
            <CopyButton value={prompt} label="Copy prompt" />
          </div>
          <div className="overflow-x-auto">
            <pre className="min-w-max px-3.5 py-3 font-mono text-[12px] leading-[1.55] whitespace-pre">
              {prompt}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
