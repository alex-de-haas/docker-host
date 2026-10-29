/** Optional account observations. Unknown never means unlimited or zero. */
export type UsageState = "available" | "unavailable" | "unsupported" | "not_applicable";
export type UsageKind = "quota" | "credits" | "rate_limit";
export interface UsageRow {
  id: string;
  group: string;
  label: string;
  kind: UsageKind;
  scope?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: "percent" | "credits" | "minor_currency" | "USD" | "requests" | "tokens";
  currency?: string;
  resetsAt?: string;
  status?: string;
  active?: boolean;
  unlimited?: boolean;
  enabled?: boolean;
  observedAt: string;
}
export interface ProviderUsage {
  state: UsageState;
  rows: UsageRow[];
  observedAt: string | null;
  partial?: boolean;
  /** Partial native events replace only the named account buckets. */
  replaceGroups?: string[];
  stale?: boolean;
  invalidated?: boolean;
  connectionRevision?: number;
  sequence?: number;
  preservePrefixes?: string[];
  reason?: "not_reported" | "unsupported_auth" | "unsupported_sdk" | "temporarily_unavailable" | "busy" | "local";
}
export const absentUsage = (state: UsageState = "unavailable", reason: ProviderUsage["reason"] = "not_reported"): ProviderUsage =>
  ({ state, rows: [], observedAt: null, reason });
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const label = (value: unknown, fallback: string): string => typeof value === "string" && value.trim() ? value.slice(0, 160) : fallback;
const time = (value: unknown, seconds = false): string | undefined => {
  const ms = seconds && typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
};
const percentage = (used: unknown) => { const value = number(used); return value === undefined ? {} : { used: value, remaining: Math.max(0, 100 - value), limit: 100, unit: "percent" as const }; };
const observed = (rows: UsageRow[], observedAt: string, partial = false): ProviderUsage =>
  rows.length ? { state: "available", rows, observedAt, partial } : absentUsage();

export function codexUsage(input: unknown, partial = false, now = new Date().toISOString()): ProviderUsage {
  const data = obj(input), buckets = obj(data.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length ? Object.entries(buckets) : data.rateLimits ? [[label(obj(data.rateLimits).limitId, "codex"), data.rateLimits] as const] : [];
  const rows: UsageRow[] = [], groups: string[] = [];
  for (const [key, raw] of entries.slice(0, 100)) {
    const bucket = obj(raw), group = "codex:" + key; groups.push(group);
    for (const part of ["primary", "secondary"]) {
      const window = obj(bucket[part]); if (!Object.keys(window).length) continue;
      const minutes = number(window.windowDurationMins);
      rows.push({ id: group + ":" + part, group, kind: "quota", label: label(bucket.limitName, key) + (minutes === undefined ? " · " + part : " · " + minutes + " min"),
        scope: typeof bucket.normalModelSlug === "string" ? bucket.normalModelSlug : undefined,
        status: bucket.spendControlReached === true ? "spend_control_reached" : undefined,
        ...percentage(window.usedPercent), resetsAt: time(window.resetsAt, true), observedAt: now });
    }
    const credits = obj(bucket.credits);
    if (Object.keys(credits).length) {
      const balance = typeof credits.balance === "string" && credits.balance.trim() ? number(Number(credits.balance)) : number(credits.balance);
      rows.push({ id: group + ":credits", group, kind: "credits", label: label(bucket.limitName, key) + " credits",
        remaining: balance, unit: "credits", unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
        status: credits.hasCredits === false ? "no_credits" : undefined, observedAt: now });
    }
  }
  const result = observed(rows, now, partial);
  return partial && rows.length ? { ...result, replaceGroups: groups } : result;
}

export function claudeUsage(input: unknown, now = new Date().toISOString()): ProviderUsage {
  const data = obj(input), limits = obj(data.rate_limits), rows: UsageRow[] = [];
  if (data.rate_limits_available === false) return absentUsage("unavailable", "not_reported");
  for (const key of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]) {
    const window = obj(limits[key]); if (!Object.keys(window).length) continue;
    rows.push({ id: "claude:" + key, group: "claude:" + key, label: key.replaceAll("_", " "), kind: "quota",
      ...percentage(window.utilization), resetsAt: time(window.resets_at), observedAt: now });
  }
  if (Array.isArray(limits.model_scoped)) for (const raw of limits.model_scoped.slice(0, 100)) {
    const item = obj(raw), scope = label(item.display_name, "Model");
    rows.push({ id: "claude:model:" + scope, group: "claude:model:" + scope, label: "Weekly · " + scope, kind: "quota", scope,
      ...percentage(item.utilization), resetsAt: time(item.resets_at), observedAt: now });
  }
  if (Array.isArray(limits.limits)) for (const raw of limits.limits.slice(0, 100)) {
    const item = obj(raw), scope = obj(item.scope), model = label(obj(scope.model).display_name, ""), surface = label(obj(scope.surface).display_name, "");
    const id = "claude:" + label(item.kind, "meter") + ":" + model + ":" + surface;
    rows.push({ id, group: id, label: label(item.kind, "Usage").replaceAll("_", " ") + (model || surface ? " · " + [model, surface].filter(Boolean).join(" · ") : ""),
      kind: "quota", scope: model || surface || undefined, ...percentage(item.percent), resetsAt: time(item.resets_at),
      status: label(item.severity, "unknown"), active: typeof item.is_active === "boolean" ? item.is_active : undefined, observedAt: now });
  }
  const extra = obj(limits.extra_usage);
  if (Object.keys(extra).length) {
    const used = number(extra.used_credits), limit = number(extra.monthly_limit);
    rows.push({ id: "claude:extra", group: "claude:extra", kind: "credits", label: "Extra usage", used, limit,
      remaining: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined,
      unit: "minor_currency", currency: typeof extra.currency === "string" ? extra.currency : undefined,
      enabled: typeof extra.is_enabled === "boolean" ? extra.is_enabled : undefined, observedAt: now });
  }
  const result = observed(rows, now);
  return limits.model_scoped === undefined && !Array.isArray(limits.limits) ? { ...result, preservePrefixes: ["claude:model:"] } : result;
}

export function claudeLimitEvent(input: unknown, now = new Date().toISOString()): ProviderUsage {
  const info = obj(input), key = label(info.rateLimitType, "current"), group = "claude:" + key;
  if (!["allowed", "allowed_warning", "rejected"].includes(String(info.status))) return absentUsage();
  // The event's utilization scale is not specified in the pinned SDK contract.
  // Display the authoritative status/reset; the structured getter supplies percentages.
  return { state: "available", partial: true, observedAt: now, rows: [{ id: group, group, label: key.replaceAll("_", " "), kind: "quota",
    status: String(info.status), resetsAt: time(info.resetsAt, true), observedAt: now }] };
}

export function mergeUsage(previous: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  if (next.state !== "available") return !next.invalidated && previous?.rows.length && next.state === "unavailable"
    ? { ...next, rows: previous.rows, observedAt: previous.observedAt, stale: true } : next;
  if (!previous?.rows.length) return next;
  if (!next.partial) return { ...next, rows: [...next.rows, ...previous.rows.filter(row =>
    next.preservePrefixes?.some(prefix => row.id.startsWith(prefix)) && !next.rows.some(current => current.id === row.id))] };
  const rows = new Map(previous.rows.filter(row => !next.replaceGroups?.includes(row.group)).map(row => [row.id, row]));
  for (const row of next.rows) {
    const previousRow = rows.get(row.id);
    const statusOnly = row.used === undefined && row.remaining === undefined && row.limit === undefined;
    rows.set(row.id, { ...previousRow, ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
      observedAt: statusOnly && previousRow ? previousRow.observedAt : row.observedAt } as UsageRow);
  }
  return { ...next, rows: [...rows.values()], partial: previous.partial, replaceGroups: undefined };
}

/** A failed or timed-out control call is diagnostic, never a run failure. */
export class UsageReader {
  private pending: Promise<ProviderUsage> | undefined;
  private closed = false;
  private disabled = false;
  private cancel: (() => void) | undefined;
  constructor(private readonly read: () => Promise<ProviderUsage>, private readonly timeoutMs = 3000) {}
  refresh(): Promise<ProviderUsage> {
    if (this.closed || this.disabled) return Promise.resolve(absentUsage("unavailable", "temporarily_unavailable"));
    if (this.pending) return this.pending;
    this.pending = this.perform().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  close() { this.closed = true; this.cancel?.(); }
  private async perform(): Promise<ProviderUsage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(this.read), new Promise<never>((_, reject) => {
        this.cancel = () => reject(new Error("Closed"));
        timer = setTimeout(() => { this.disabled = true; reject(new Error("Timed out")); }, this.timeoutMs);
      })]);
    } catch { return absentUsage("unavailable", "temporarily_unavailable"); }
    finally { clearTimeout(timer); this.cancel = undefined; }
  }
}
