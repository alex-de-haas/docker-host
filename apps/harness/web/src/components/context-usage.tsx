"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import type { ContextUsage } from "../../../src/harness/context-usage";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function ContextUsageIndicator({ usage, connected = true }: { usage: ContextUsage | null; connected?: boolean }) {
  const percentage = usage?.maxTokens ? usage.usedTokens / usage.maxTokens * 100 : null;
  const visualPercentage = percentage === null ? null : Math.min(100, Math.max(0, percentage));
  const count = usage ? `${usage.estimated ? "≈ " : ""}${tokens.format(usage.usedTokens)}` : "";
  const summary = usage
    ? percentage === null ? `${count} tokens · limit unavailable`
      : `${count} / ${tokens.format(usage.maxTokens!)} · ${percent.format(percentage)}%`
    : "Not available";
  const description = usage
    ? `${usage.estimated ? "Estimated context usage" : "Context usage"}: ${usage.usedTokens.toLocaleString("en")} tokens${usage.maxTokens ? ` of ${usage.maxTokens.toLocaleString("en")}` : "; context limit unavailable"}. Last measured ${new Date(usage.observedAt).toLocaleString()}. ${connected ? "Updates as the agent reports usage." : "Disconnected; showing the last measurement."} The window may reflect the provider's compaction limit.`
    : `${connected ? "" : "Disconnected. "}Context usage has not been reported for this session.`;
  const ring = (
    <>
      <svg viewBox="0 0 28 28" className="size-6 -rotate-90" aria-hidden="true">
        <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-muted-foreground/25" strokeDasharray={percentage === null ? "2 3" : undefined} />
        {visualPercentage !== null && <ProgressPrimitive.Indicator asChild>
          <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100"
            strokeDasharray="100" strokeDashoffset={100 - visualPercentage} />
        </ProgressPrimitive.Indicator>}
      </svg>
    </>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div tabIndex={0} role="group" aria-label={`Context usage: ${summary}`}
            data-slot="context-usage" className="flex h-9 min-w-9 shrink-0 cursor-help items-center justify-center gap-1 rounded-md px-1 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-brand"
            onClick={event => event.preventDefault()}>
            {visualPercentage === null ? <div className="relative size-6 shrink-0">{ring}</div> :
              <ProgressPrimitive.Root value={visualPercentage} role="meter" aria-label="Context window used"
                aria-valuetext={`${percent.format(percentage!)}% · ${summary}`}
                className={cn("relative size-6 shrink-0", percentage! >= 100 ? "text-destructive-foreground" : percentage! >= 80 ? "text-warning-foreground" : "text-muted-foreground")}>
                {ring}
              </ProgressPrimitive.Root>}
            <span aria-hidden="true" className="font-mono text-xs tabular-nums">
              {percentage === null ? "?" : `${percent.format(percentage)}%`}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">Context · {summary}</p>
          <p>{description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
