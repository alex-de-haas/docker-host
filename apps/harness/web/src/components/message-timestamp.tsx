"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Stored transcript time, displayed in the reader's local timezone. */
export function MessageTimestamp({ ts }: { ts?: string }) {
  const date = ts ? new Date(ts) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const time = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
  return <div className="ml-auto"><TooltipProvider><Popover><Tooltip>
    <TooltipTrigger asChild><PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1 text-xs font-normal tabular-nums" aria-label={`Message time: ${full}`}>
        <time dateTime={date.toISOString()}>{time}</time>
      </Button>
    </PopoverTrigger></TooltipTrigger>
    <TooltipContent>{full}</TooltipContent>
    <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-3 text-sm" align="end">
      <time dateTime={date.toISOString()}>{full}</time>
    </PopoverContent>
  </Tooltip></Popover></TooltipProvider></div>;
}
