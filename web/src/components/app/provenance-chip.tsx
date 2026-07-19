// The three computation-provenance chips — brief §4.1.
// Every rendered number carries exactly one of these. They must read apart at a
// glance across a whole screen, without colour and without hover, so each kind gets
// its own glyph AND its own border treatment (dashed vs solid vs pill) rather than
// three colours on one ramp.

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";

export type ProvenanceKind = "rule" | "rule_on_model" | "model";

const GLYPH: Record<ProvenanceKind, string> = {
  rule: "▦",
  rule_on_model: "▦◇",
  model: "◇",
};

const LABEL: Record<ProvenanceKind, string> = {
  rule: "Rule",
  rule_on_model: "Rule on model input",
  model: "Model",
};

const DESCRIPTION: Record<ProvenanceKind, string> = {
  rule: "computed by a published deterministic formula from stored inputs",
  rule_on_model: "a deterministic formula, but at least one input was judged by a model",
  model: "a language model's judgement — not reproducible",
};

const CHIP_CLASS: Record<ProvenanceKind, string> = {
  rule: "chip-rule",
  rule_on_model: "chip-rule-on-model",
  model: "chip-model",
};

interface ProvenanceChipProps {
  kind: ProvenanceKind;
  /** Renders the label next to the glyph instead of only in the tooltip/sr-only text. */
  showLabel?: boolean;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

export function ProvenanceChip({ kind, showLabel, onClick, className }: ProvenanceChipProps) {
  return (
    <span
      onClick={onClick}
      title={`${LABEL[kind]} — ${DESCRIPTION[kind]}`}
      className={cn(
        "inline-flex items-center gap-1 leading-none",
        CHIP_CLASS[kind],
        onClick ? "cursor-pointer" : "",
        className,
      )}
    >
      <span aria-hidden="true">{GLYPH[kind]}</span>
      {showLabel ? <span>{LABEL[kind]}</span> : <span className="sr-only">{LABEL[kind]}</span>}
    </span>
  );
}

export function provenanceLabel(kind: ProvenanceKind): string {
  return LABEL[kind];
}
