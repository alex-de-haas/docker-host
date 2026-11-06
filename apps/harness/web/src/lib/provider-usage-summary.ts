import type { ProviderUsage, UsageRow } from "./provider-usage";

export type ProviderUsageSummary = { remaining: number | null; row?: UsageRow; reason?: string };

const freshnessMs = 120_000;
const claudeGlobalGroups = new Set(["claude:five_hour", "claude:seven_day"]);
const claudeSpecializedGroups = new Set(["claude:seven_day_oauth_apps", "claude:seven_day_opus", "claude:seven_day_sonnet"]);
const unknown = (reason: string, row?: UsageRow): ProviderUsageSummary => ({ remaining: null, reason, ...(row ? { row } : {}) });
const isWindow = (row: UsageRow) => (row.kind === "quota" || row.kind === "rate_limit") && row.active !== false &&
  row.enabled !== false && !row.unlimited && !row.currency &&
  row.unit !== "credits" && row.unit !== "minor_currency" && row.unit !== "USD";
const isFresh = (observedAt: string | null, now: number) => {
  const observed = observedAt === null ? NaN : Date.parse(observedAt);
  return Number.isFinite(observed) && now - observed <= freshnessMs;
};

function remainingPercent(row: UsageRow): number | null {
  for (const value of [row.used, row.remaining, row.limit]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return null;
  }
  if (row.limit !== undefined && row.limit <= 0) return null;
  const limit = row.unit === "percent" ? 100 : row.limit;
  if (limit === undefined) return null;
  const values = [
    row.remaining === undefined ? undefined : Math.min(1, row.remaining / limit) * 100,
    row.used === undefined ? undefined : row.used >= limit ? 0 : (limit - row.used) / limit * 100,
  ].filter((value): value is number => value !== undefined);
  if (!values.length) return null;
  return Math.max(0, Math.min(100, ...values));
}

/** Summarize observed applicable windows; missing data never implies a restored quota. */
export function summarizeProviderUsage(usage: ProviderUsage | null, now = Date.now(), model?: string | null): ProviderUsageSummary {
  if (!usage || usage.state !== "available") return unknown("Account limits are unavailable.");
  if (usage.invalidated) return unknown("Account limits need a new observation.");
  if (usage.stale || !Number.isFinite(now) || !isFresh(usage.observedAt, now)) return unknown("Account limits are outdated.");
  if (usage.partial) return unknown("Account limits are incomplete.");

  // Structured providers can choose their single-value headline themselves.
  const active = usage.rows.filter(row => row.active === true);
  if (active.length > 1) return unknown("The provider reported more than one headline limit.");
  let windows: UsageRow[];
  if (active.length === 1) {
    if (!isWindow(active[0])) return unknown("The provider headline has no comparable quota.", active[0]);
    windows = active;
  } else {
    const candidates = usage.rows.filter(isWindow);
    if (!candidates.length) return unknown("No comparable account limit was reported.");
    if (candidates.every(row => row.group.startsWith("codex:"))) {
      const groups = new Map<string, UsageRow[]>();
      for (const row of candidates) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
      const applicable: UsageRow[][] = [];
      for (const rows of groups.values()) {
        const scopes = new Set(rows.map(row => row.scope || undefined));
        if (scopes.size !== 1) return unknown("The account limit scope is ambiguous.");
        const scope = rows[0].scope;
        if (scope && !model) return unknown("Choose a model to identify its account limit.");
        if (!scope || scope === model) applicable.push(rows);
      }
      // The normalized contract has no flag identifying an additional global bucket.
      if (applicable.length !== 1) return unknown("The account limit scope is ambiguous.");
      windows = applicable[0];
    } else if (candidates.every(row => row.group.startsWith("claude:"))) {
      // Legacy model names are display labels, not canonical model identifiers.
      // OAuth-app windows need a known surface; neither is safe to infer here.
      if (candidates.some(row => !row.scope && !claudeGlobalGroups.has(row.group) && !claudeSpecializedGroups.has(row.group) && !row.group.startsWith("claude:model:"))) {
        return unknown("The account limit scope is ambiguous.");
      }
      windows = candidates.filter(row => !row.scope && claudeGlobalGroups.has(row.group));
      if (!windows.length) return unknown("No applicable account-wide limit was reported.");
    } else {
      if (candidates.some(row => row.scope) || new Set(candidates.map(row => row.group)).size !== 1) {
        return unknown("The account limit scope is ambiguous.");
      }
      windows = candidates;
    }
  }

  let summary: { remaining: number; row: UsageRow } | undefined;
  for (const row of windows) {
    if (!isFresh(row.observedAt, now)) return unknown("An account limit observation is outdated.", row);
    if (row.resetsAt !== undefined) {
      const reset = Date.parse(row.resetsAt);
      if (!Number.isFinite(reset) || reset <= now) return unknown("An account limit needs an observation after its reset.", row);
    }
    const remaining = remainingPercent(row);
    if (remaining === null) return unknown("An applicable account limit has no reported percentage.", row);
    if (!summary || remaining < summary.remaining) summary = { remaining, row };
  }
  return summary ?? unknown("No comparable account limit was reported.");
}
