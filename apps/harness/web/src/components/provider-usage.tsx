"use client";
import { useEffect, useId, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useProviderUsage, type ProviderUsage, type UsageRow } from "@/lib/provider-usage";

const format = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
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
export function UsageDetails({ usage }: { usage: ProviderUsage | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Only mounted while the popover is open; this updates display time, not provider data.
    const update = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
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
export function ProviderUsageIndicator({ connectionId, revision }: { connectionId: string; revision?: number }) {
  const { usage: latest, refreshing, refresh } = useProviderUsage(connectionId), titleId = useId();
  const usage = revision !== undefined && latest && latest.connectionRevision !== revision ? { state: "unavailable" as const, rows: [], observedAt: null } : latest;
  if (usage?.state === "not_applicable" || usage?.state === "unsupported") return null;
  const active = usage?.state === "available" && !usage.stale ? usage.rows.find(row => row.active) : undefined;
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Provider limits" title={active ? `Provider limits: ${usageAmount(active)}` : "Provider limits"}><Gauge aria-hidden="true" /></Button></PopoverTrigger>
    <PopoverContent align="end" aria-labelledby={titleId} className="max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <div className="flex flex-col gap-3">
        <PopoverHeader><PopoverTitle id={titleId}>Provider limits</PopoverTitle><PopoverDescription>Quota, credits and request limits reported by this connection.</PopoverDescription></PopoverHeader>
        <UsageDetails usage={usage} />
        <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />{refreshing ? "Refreshing…" : "Refresh limits"}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
