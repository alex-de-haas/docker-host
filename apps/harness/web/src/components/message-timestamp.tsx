"use client";

import { cn } from "@/lib/utils";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Stored transcript time, displayed in the reader's local timezone. */
export function MessageTimestamp({ ts, compact = false, className }: { ts?: string; compact?: boolean; className?: string }) {
  const date = ts ? new Date(ts) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
  return <div className={cn("flex justify-end text-muted-foreground", className)}><TooltipProvider><Popover><Tooltip>
    <TooltipTrigger asChild><PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-6 gap-1 px-1" aria-label={`Message time: ${full}`}>
        {compact ? <Clock3 aria-hidden data-icon="inline-start" /> : <time dateTime={date.toISOString()}>{time}</time>}
      </Button>
    </PopoverTrigger></TooltipTrigger>
    <TooltipContent>{full}</TooltipContent>
    <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-3 text-sm" align="end">
      <time dateTime={date.toISOString()}>{full}</time>
    </PopoverContent>
  </Tooltip></Popover></TooltipProvider></div>;
}
