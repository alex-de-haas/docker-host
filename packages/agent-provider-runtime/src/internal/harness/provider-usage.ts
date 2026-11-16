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
