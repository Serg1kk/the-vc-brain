// A thin wrapper over the shadcn tooltip primitive (components/ui/tooltip.tsx),
// used to attach a plain-language, one-sentence explanation to every score, metric
// and provenance glyph in the dashboard (operator request) — supplementary hover
// context, never a replacement for the chips' own without-hover visual distinction.
//
// Wraps its own <TooltipProvider> per instance rather than requiring one mounted at
// the app root: these components are a shared library imported into screens built by
// several agents in parallel, and none of them should have to remember to mount a
// provider for this to work.

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface InfoTooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** Forwards to Radix's trigger so the wrapped element keeps its own tag/handlers
   * instead of being wrapped in an extra <button> — default true. */
  asChild?: boolean;
}

export function InfoTooltip({ content, children, asChild = true }: InfoTooltipProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-[12px] leading-snug">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
