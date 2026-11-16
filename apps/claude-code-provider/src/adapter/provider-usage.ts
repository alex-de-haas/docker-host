import { absentUsage, type ProviderUsage, type UsageRow } from "@hosty/agent-provider-runtime/harness/provider-usage";
export { absentUsage, UsageReader } from "@hosty/agent-provider-runtime/harness/provider-usage";

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

