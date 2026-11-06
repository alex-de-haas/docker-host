"use client";
import { useEffect, useId, useState } from "react";
import { Hourglass, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useProviderUsage, type ProviderUsage, type UsageRow } from "@/lib/provider-usage";
import { summarizeProviderUsage } from "@/lib/provider-usage-summary";
import { cn } from "@/lib/utils";
import { UsageRing } from "./usage-ring";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const format = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const date = (value: string) => new Date(value).toLocaleString();
export function usageAmount(row: UsageRow) {
  if (row.unlimited) return "Unlimited credits";
  if (row.unit === "minor_currency" && row.currency && row.remaining !== undefined) {
    try {
      const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: row.currency.toUpperCase() });
      return currency.format(row.remaining / 10 ** (currency.resolvedOptions().maximumFractionDigits ?? 2)) + " remaining";
    } catch { /* Unknown currency: keep the explicit provider unit. */ }
  }
  const unit = row.unit === "percent" ? "%" : row.unit === "USD" ? " USD" : row.unit === "minor_currency" ? " " + (row.currency ?? "currency") + " minor units" : row.unit ? " " + row.unit : "";
  if (row.remaining !== undefined) return format(row.remaining) + unit + " remaining";
  if (row.used !== undefined) return format(row.used) + unit + " used";
  return "Amount not reported";
}
/** Codex's normalized label ends with its window duration, not its reset countdown. */
export function usageLabel(row: UsageRow, now: number) {
  if (row.kind !== "quota" || !row.group.startsWith("codex:") || !row.resetsAt) return row.label;
  const reset = Date.parse(row.resetsAt);
  if (!Number.isFinite(reset)) return row.label;
  const name = row.label.replace(/ · (?:[\d.]+ (?:days?|hours?|min)|primary|secondary)$/, "");
  const remaining = reset - now;
  if (remaining <= 0) return name + " · Reset time reached";
  const minutes = Math.floor(remaining / 60_000);
  if (!minutes) return name + " · Resets in less than a minute";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const amount = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  const parts = days ? [amount(days, "day"), hours ? amount(hours, "hour") : ""]
    : [hours ? amount(hours, "hour") : "", minutes % 60 ? amount(minutes % 60, "minute") : ""];
  return name + " · Resets in " + parts.filter(Boolean).join(" ");
}
function useUsageNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Display time only: never request provider data to animate a countdown or expire a meter.
    const update = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  return now;
}
export function UsageDetails({ usage }: { usage: ProviderUsage | null }) {
  const now = useUsageNow();
  if (!usage) return <p className="text-sm text-muted-foreground">Loading limits…</p>;
  const descriptions = {
    unavailable: "Usage information is temporarily unavailable or not reported by this account.",
    unsupported: "This connection does not expose account limits through its SDK.",
    not_applicable: "Account quotas do not apply to this local provider.",
    available: "Account limits are shared across conversations and devices.",
  };
  return <div className="flex flex-col gap-3">
    <p className="text-sm text-muted-foreground">{descriptions[usage.state]}</p>
    {usage.partial && <p className="text-xs text-muted-foreground">Only the reported limits are shown.</p>}
    {usage.stale && <Badge variant="outline">Last known values · may be outdated</Badge>}
    {usage.rows.map(row => <div key={row.id} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{usageLabel(row, now)}</span><span>{usageAmount(row)}</span></div>
      {row.unit === "percent" && row.used !== undefined && <Progress aria-label={usageLabel(row, now) + " used"} value={Math.min(100, Math.max(0, row.used))} />}
      {row.used !== undefined && row.limit !== undefined && <p className="text-xs text-muted-foreground">{format(row.used)} / {format(row.limit)} {row.unit === "percent" ? "% used" : "used"}</p>}
      {row.status && <p className="text-xs text-muted-foreground">Status: {row.status.replaceAll("_", " ")}</p>}
      {row.enabled === false && <p className="text-xs text-muted-foreground">Additional usage is not enabled.</p>}
      {row.resetsAt && <p className="text-xs text-muted-foreground">Resets <time dateTime={row.resetsAt}>{date(row.resetsAt)}</time></p>}
      <p className="text-xs text-muted-foreground">Observed <time dateTime={row.observedAt}>{date(row.observedAt)}</time></p>
    </div>)}
    {!usage.rows.length && usage.observedAt && <p className="text-xs text-muted-foreground">Last observed {date(usage.observedAt)}</p>}
  </div>;
}
export function ProviderUsageIndicator({ connectionId, revision, model }: { connectionId: string; revision?: number; model?: string | null }) {
  const { usage: latest, refreshing, refresh } = useProviderUsage(connectionId), titleId = useId();
  const now = useUsageNow();
  const usage = revision !== undefined && latest && latest.connectionRevision !== revision ? { state: "unavailable" as const, rows: [], observedAt: null } : latest;
  if (usage?.state === "not_applicable" || usage?.state === "unsupported") return null;
  const { remaining, row, reason } = summarizeProviderUsage(usage, now, model);
  const amount = remaining === null ? "?" : `${percent.format(remaining)}%`;
  const description = remaining === null ? reason ?? "Remaining limits are not available." : `${amount} left · ${row!.label}`;
  return <TooltipProvider delayDuration={250}><Tooltip><Popover>
    <PopoverTrigger asChild><TooltipTrigger asChild><Button type="button" variant="ghost" aria-label={`Provider limits: ${description}`}
      data-slot="provider-usage" className="h-9 min-w-9 gap-1 px-1 font-normal">
      <UsageRing value={remaining} label="Provider limits remaining" valueText={description}
        className={cn(remaining === null ? "text-muted-foreground" : remaining <= 0 ? "text-destructive-foreground" : remaining <= 20 ? "text-warning-foreground" : "text-info-foreground")}>
        <Hourglass className="size-3" aria-hidden="true" />
      </UsageRing>
      <span aria-hidden="true" className="font-mono text-xs tabular-nums">{amount}<span className="hidden @min-[640px]/composer:inline"> left</span></span>
    </Button></TooltipTrigger></PopoverTrigger>
    <PopoverContent align="end" aria-labelledby={titleId} className="max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <div className="flex flex-col gap-3">
        <PopoverHeader><PopoverTitle id={titleId}>Provider limits</PopoverTitle><PopoverDescription>Quota, credits and request limits reported by this connection.</PopoverDescription></PopoverHeader>
        <UsageDetails usage={usage} />
        <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />{refreshing ? "Refreshing…" : "Refresh limits"}</Button>
      </div>
    </PopoverContent>
  </Popover><TooltipContent className="max-w-xs">
    <p className="font-medium">Limits · {description}</p>
    {row?.resetsAt && <p>Resets <time dateTime={row.resetsAt}>{date(row.resetsAt)}</time></p>}
    <p>Open for all reported limits and credits.</p>
  </TooltipContent></Tooltip></TooltipProvider>;
}
