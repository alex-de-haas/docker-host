"use client";
import { useId } from "react";
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
export function UsageDetails({ usage }: { usage: ProviderUsage | null }) {
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{row.label}</span><span>{usageAmount(row)}</span></div>
      {row.unit === "percent" && row.used !== undefined && <Progress aria-label={row.label + " used"} value={Math.min(100, Math.max(0, row.used))} />}
      {row.used !== undefined && row.limit !== undefined && <p className="text-xs text-muted-foreground">{format(row.used)} / {format(row.limit)} {row.unit === "percent" ? "% used" : "used"}</p>}
      {row.status && <p className="text-xs text-muted-foreground">Status: {row.status.replaceAll("_", " ")}</p>}
      {row.enabled === false && <p className="text-xs text-muted-foreground">Additional usage is not enabled.</p>}
      {row.resetsAt && <p className="text-xs text-muted-foreground">Resets <time dateTime={row.resetsAt}>{date(row.resetsAt)}</time></p>}
      <p className="text-xs text-muted-foreground">Observed <time dateTime={row.observedAt}>{date(row.observedAt)}</time></p>
    </div>)}
    {!usage.rows.length && usage.observedAt && <p className="text-xs text-muted-foreground">Last observed {date(usage.observedAt)}</p>}
  </div>;
}
export function ProviderUsageIndicator({ connectionId, revision, compact = true }: { connectionId: string; revision?: number; compact?: boolean }) {
  const { usage: latest, refreshing, refresh } = useProviderUsage(connectionId), titleId = useId();
  const usage = revision !== undefined && latest && latest.connectionRevision !== revision ? { state: "unavailable" as const, rows: [], observedAt: null } : latest;
  if (compact && usage?.state === "not_applicable") return null;
  const active = usage?.state === "available" && !usage.stale ? usage.rows.find(row => row.active) : undefined;
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" aria-label="Provider limits"><Gauge data-icon="inline-start" />{active ? usageAmount(active) : "Limits"}</Button></PopoverTrigger>
    <PopoverContent align="end" aria-labelledby={titleId} className="max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <div className="flex flex-col gap-3">
        <PopoverHeader><PopoverTitle id={titleId}>Provider limits</PopoverTitle><PopoverDescription>Quota, credits and request limits reported by this connection.</PopoverDescription></PopoverHeader>
        <UsageDetails usage={usage} />
        <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />{refreshing ? "Refreshing…" : "Refresh limits"}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
