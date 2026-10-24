"use client";

import { Container, ShieldAlert } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function SessionExecutionIndicator({ executionMode }: Pick<AssistantSession, "executionMode">) {
  if (executionMode !== "native" && executionMode !== "docker") return null;

  const local = executionMode === "native";
  const Icon = local ? ShieldAlert : Container;
  const label = local ? "Local · Host access" : "Docker · Limited access";
  const description = local
    ? "Commands and file changes run on this host with the native Harness process permissions. This is not a container boundary. Enabled MCP tools retain their own granted access and approval rules."
    : "Commands and file changes run as an unprivileged user in the shared Docker worker, with its mounted worktrees, caches and network access. This is not isolation between sessions. Core and app MCP tools retain their own granted access and approval rules.";

  return <TooltipProvider delayDuration={250}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} aria-label={`Session execution: ${label}`}
          data-slot="session-execution" className={cn(
            "cursor-help outline-none focus-visible:outline-2 focus-visible:outline-brand",
            local ? "border-destructive/30 text-destructive-foreground" : "text-muted-foreground",
          )}>
          <Icon className="size-3.5" aria-hidden="true" />{label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-xs">{description}</TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
