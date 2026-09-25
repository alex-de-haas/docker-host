export type ResourceSample = {
  appId: string; service: string; runtime: string; timestamp: string;
  cpuPercent: number | null; memoryBytes: number | null;
};
export type ResourceFrame = { timestamp: string; services: ResourceSample[] };
export type ResourceSnapshot = { runId: string; now: string; logicalProcessors: number; history: ResourceFrame[] };
export type ResourcePoint = { timestamp: number; cpu: number | null; memory: number | null };
export const RETENTION_MS = 5 * 60_000;
export const STALE_MS = 20_000;

export function mergeResources(previous: ResourceSnapshot | null, next: ResourceSnapshot): ResourceSnapshot {
  const frames = previous?.runId === next.runId ? [...previous.history, ...next.history] : next.history;
  const byTime = new Map(frames.map(frame => [frame.timestamp, frame]));
  return { ...next, history: [...byTime.values()].filter(f => Date.parse(f.timestamp) >= Date.parse(next.now) - RETENTION_MS)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-110) };
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
