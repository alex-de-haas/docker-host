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

const quotaWindowLabel = (minutes: number): string => {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} min`;
};

export function codexUsage(input: unknown, partial = false, now = new Date().toISOString()): ProviderUsage {
  const data = obj(input), buckets = obj(data.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length ? Object.entries(buckets) : data.rateLimits ? [[label(obj(data.rateLimits).limitId, "codex"), data.rateLimits] as const] : [];
  const rows: UsageRow[] = [], groups: string[] = [];
  for (const [key, raw] of entries.slice(0, 100)) {
    const bucket = obj(raw), group = "codex:" + key; groups.push(group);
    for (const part of ["primary", "secondary"]) {
      const window = obj(bucket[part]); if (!Object.keys(window).length) continue;
      const minutes = number(window.windowDurationMins);
      rows.push({ id: group + ":" + part, group, kind: "quota", label: label(bucket.limitName, key) + (minutes === undefined ? " · " + part : " · " + quotaWindowLabel(minutes)),
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

