"use client";

import { Cpu } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function SessionExecutionIndicator({ harnessKind }: Pick<AssistantSession, "harnessKind">) {
  if (harnessKind !== "agent") return null;
  const label = "Provider-owned execution";
  const description = "Commands and file changes run in the selected agent provider application's environment. Check that provider's configuration for its host access and native tool policy. Core and app MCP tools retain their own granted access and approval rules.";

  return <TooltipProvider delayDuration={250}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`Session execution: ${label}`}
          data-slot="session-execution" className={cn(
            "inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-md outline-none focus-visible:outline-2 focus-visible:outline-brand",
            "text-muted-foreground",
          )}>
          <Cpu className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-xs"><p className="font-medium">{label}</p><p className="mt-1">{description}</p></TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
