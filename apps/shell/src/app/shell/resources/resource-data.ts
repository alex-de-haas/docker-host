export type ApiActivityWarning = { reason: string; since: string; requests: number; threshold: number; windowSeconds: number };
export type AppApiActivity = {
  totalRequests: number; totalEligibleRequests: number; requests10s: number; requests60s: number;
  eligibleRequests10s: number; eligibleRequests60s: number; warning: ApiActivityWarning | null; recoveredAt: string | null;
};
export type ApiActivitySnapshot = {
  runId: string; observedAt: string; enabled: boolean; coverage: string;
  sustainedThreshold: number; burstThreshold: number; recoverySeconds: number;
  apps: Record<string, AppApiActivity>; unattributed: Record<string, AppApiActivity>;
};
export type ResourceSample = {
  appId: string; service: string; runtime: string; timestamp: string;
  cpuPercent: number | null; memoryBytes: number | null;
};
export type ResourceFrame = { timestamp: string; services: ResourceSample[]; sequence?: number; apiActivity?: ApiActivitySnapshot | null };
export type ResourceSnapshot = { runId: string; now: string; logicalProcessors: number; history: ResourceFrame[]; sequence?: number; apiActivity?: ApiActivitySnapshot | null };
export type ResourceEvent = { runId: string; sequence: number; timestamp: string; logicalProcessors: number; frame: ResourceFrame };
export type ResourcePoint = { timestamp: number; cpu: number | null; memory: number | null };
export const RETENTION_MS = 5 * 60_000;
export const STALE_MS = 20_000;

export function mergeResources(previous: ResourceSnapshot | null, next: ResourceSnapshot): ResourceSnapshot {
  const frames = previous?.runId === next.runId ? [...previous.history, ...next.history] : next.history;
  const metadata = previous?.runId === next.runId && (previous.sequence ?? 0) > (next.sequence ?? 0) ? previous : next;
  const bySequence = new Map(frames.map(frame => [frame.sequence ?? frame.timestamp, frame]));
  return { ...metadata, history: [...bySequence.values()].filter(f => Date.parse(f.timestamp) >= Date.parse(metadata.now) - RETENTION_MS)
    .sort((a, b) => (a.sequence !== undefined && b.sequence !== undefined) ? a.sequence - b.sequence : Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-110) };
}

export function resourceSeries(snapshot: ResourceSnapshot | null, appId?: string, service?: string): ResourcePoint[] {
  return (snapshot?.history ?? []).map(frame => {
    const samples = frame.services.filter(s => (appId ? s.appId === appId : s.appId !== "hosty.core") && (!service || s.service === service));
    const timestamp = Date.parse(frame.timestamp);
    const sum = (key: "cpuPercent" | "memoryBytes") => samples.length && samples.every(s => s[key] !== null && Number.isFinite(s[key]) && timestamp - Date.parse(s.timestamp) <= STALE_MS)
      ? samples.reduce((total, s) => total + s[key]!, 0) : null;
    return { timestamp, cpu: sum("cpuPercent"), memory: sum("memoryBytes") };
  });
}

export function cpuScale(snapshot: ResourceSnapshot | null): number {
  // One common scale for every app, including multi-core loads above 100%.
  const totals = resourceSeries(snapshot).map(p => p.cpu ?? 0);
  const apps = new Set(snapshot?.history.flatMap(f => f.services.map(s => s.appId)) ?? []);
  // A missing service can make the fleet total unknown while another app still exceeds 100%.
  // Include individual app peaks so Recharts never expands only that row's axis independently.
  const appPeaks = [...apps].map(id => Math.max(0, ...resourceSeries(snapshot, id).map(p => p.cpu ?? 0)));
  return Math.max(100, Math.ceil(Math.max(0, ...totals, ...appPeaks) / 100) * 100);
}

export function elevatedCpu(points: ResourcePoint[]): boolean {
  const baseline = points.slice(0, -3).filter(p => p.cpu !== null);
  if (baseline.length < 10 || points.length < 13) return false;
  const mean = baseline.reduce((sum, p) => sum + p.cpu!, 0) / baseline.length;
  return points.slice(-3).every(p => p.cpu !== null && p.cpu >= 10 && p.cpu >= mean * 2 && p.cpu - mean >= 5);
}

export function formatMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}
export function formatCpu(cpu: number | null): string { return cpu === null ? "—" : `${cpu.toFixed(1)}%`; }

export function currentApiActivity(snapshot: ResourceSnapshot | null, appId?: string): AppApiActivity | null {
  const activity = snapshot?.apiActivity ?? snapshot?.history.at(-1)?.apiActivity;
  if (!activity?.enabled || !snapshot || Date.parse(snapshot.now) - Date.parse(activity.observedAt) > STALE_MS) return null;
  if (appId) return activity.apps[appId] ?? null;
  const apps = Object.values(activity.apps);
  return apps.reduce<AppApiActivity>((total, app) => ({
    totalRequests: total.totalRequests + app.totalRequests,
    totalEligibleRequests: total.totalEligibleRequests + app.totalEligibleRequests,
    requests10s: total.requests10s + app.requests10s, requests60s: total.requests60s + app.requests60s,
    eligibleRequests10s: total.eligibleRequests10s + app.eligibleRequests10s,
    eligibleRequests60s: total.eligibleRequests60s + app.eligibleRequests60s,
    warning: total.warning ?? app.warning, recoveredAt: null,
  }), { totalRequests: 0, totalEligibleRequests: 0, requests10s: 0, requests60s: 0,
    eligibleRequests10s: 0, eligibleRequests60s: 0, warning: null, recoveredAt: null });
}
export function apiActivitySeries(snapshot: ResourceSnapshot | null, appId?: string) {
  return (snapshot?.history ?? []).map(frame => ({
    timestamp: Date.parse(frame.timestamp),
    calls: currentApiActivity(snapshot ? { ...snapshot, now: frame.timestamp, apiActivity: frame.apiActivity, history: [frame] } : null, appId)?.requests60s ?? null,
  }));
}
