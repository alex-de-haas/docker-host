import { fetchCore } from "../core-transport.js";
import { CoreEventNames, subscribeToCoreEvents, type CoreStreamState } from "../events/core-event-stream";
import { mergeResources, STALE_MS, type ResourceEvent, type ResourceSnapshot } from "./resource-data";

const MAX_BUFFER = 128;
const RETRY_DELAYS = [1000, 3000, 10_000, 30_000];
export type ResourceView = { snapshot: ResourceSnapshot | null; fresh: boolean };

function isSample(data: unknown): data is ResourceEvent {
  const event = data as ResourceEvent | null;
  return !!event && typeof event.runId === "string" && Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
    Number.isFinite(Date.parse(event.timestamp)) && Number.isFinite(event.logicalProcessors) &&
    event.frame?.sequence === event.sequence && event.frame.timestamp === event.timestamp && Array.isArray(event.frame.services);
}
function fromEvent(event: ResourceEvent): ResourceSnapshot {
  return { runId: event.runId, sequence: event.sequence, now: event.timestamp, logicalProcessors: event.logicalProcessors, history: [event.frame] };
}

/** Owns one Dashboard's history. No timers fetch on a healthy supported stream. */
export function watchResources(coreOrigin: string, render: (view: ResourceView) => void): () => void {
  let snapshot: ResourceSnapshot | null = null;
  let state: CoreStreamState = "inactive";
  let pending: AbortController | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let buffer: ResourceEvent[] = [];
  let overflow = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let legacyTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const active = () => !disposed && (state === "stream" || state === "legacy");
  const cancelRead = () => {
    pending?.abort(); pending = null;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };
  const stale = () => {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
    if (!disposed) render({ snapshot, fresh: false });
  };
  const publish = () => {
    if (staleTimer !== null) clearTimeout(staleTimer);
    const last = snapshot?.history.at(-1);
    // Compare server timestamps, then use a local deadline: browser/server clock skew is irrelevant.
    const age = last && snapshot ? Math.max(0, Date.parse(snapshot.now) - Date.parse(last.timestamp)) : STALE_MS;
    const fresh = age < STALE_MS;
    render({ snapshot, fresh });
    staleTimer = fresh ? setTimeout(stale, STALE_MS - age) : null;
  };
  const enqueue = (event: ResourceEvent) => {
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) { buffer.shift(); overflow = true; }
  };
  const scheduleRecovery = () => {
    if (!active() || retryTimer !== null) return;
    stale();
    const delay = RETRY_DELAYS[Math.min(retries++, RETRY_DELAYS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; void sync(); }, delay);
  };
  const sync = async () => {
    if (!active() || pending || retryTimer !== null) return;
    const controller = new AbortController();
    pending = controller;
    // A stalled snapshot must not keep the live stream trapped in its bounded buffer forever.
    deadlineTimer = setTimeout(() => {
      cancelRead();
      scheduleRecovery();
    }, 15_000);
    overflow = false;
    try {
      // Stream recovery reads the bounded full window: a cursor cannot recover a hole in history.
      // Legacy Core still uses incremental reads and their 20-second sampling lease.
      const last = snapshot?.history.at(-1)?.timestamp;
      const query = state === "stream" ? "?stream=true" : last ? `?after=${encodeURIComponent(last)}&runId=${encodeURIComponent(snapshot!.runId)}` : "";
      const response = await fetchCore(`${coreOrigin}/api/core/resources${query}`, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`Resource history: ${response.status}`);
      const next = await response.json() as ResourceSnapshot;
      if (controller.signal.aborted || disposed) return;
      if (!next || typeof next.runId !== "string" || !Array.isArray(next.history) || !Number.isFinite(Date.parse(next.now)) ||
        (state === "stream" && !Number.isSafeInteger(next.sequence))) throw new Error("Invalid resource history");
      // A response from an older Core run must never replace newer streamed state. Leave it stale
      // and obtain history for the stream's run with the same bounded recovery path.
      if (buffer.length && buffer.at(-1)!.runId !== next.runId) throw new Error("Core run changed during synchronization");
      snapshot = mergeResources(snapshot, next);
      let gap = overflow;
      const waiting = buffer;
      buffer = [];
      for (const event of waiting) {
        if (event.runId !== snapshot.runId || event.sequence <= (snapshot.sequence ?? 0)) continue;
        if (event.sequence !== (snapshot.sequence ?? 0) + 1) gap = true;
        snapshot = mergeResources(snapshot, fromEvent(event));
      }
      if (gap) { scheduleRecovery(); return; }
      retries = 0;
      publish();
    } catch {
      if (!controller.signal.aborted) scheduleRecovery();
    } finally {
      if (pending === controller) {
        pending = null;
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    }
  };
  const unsubscribe = subscribeToCoreEvents(coreOrigin, {
    topic: "resources",
    names: [CoreEventNames.resourcesSample, CoreEventNames.resourcesChanged],
    receiveWhileSyncing: true,
    onSync: sync,
    onStreamState: next => {
      if (state === next) return;
      state = next;
      cancelRead();
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (legacyTimer !== null) clearInterval(legacyTimer);
      retryTimer = null; legacyTimer = null;
      buffer = []; overflow = false; retries = 0;
      stale();
      if (next === "legacy") legacyTimer = setInterval(() => { void sync(); }, 10_000);
    },
    onEvent: (name, data) => {
      if (!active()) return;
      if (name === CoreEventNames.resourcesChanged) {
        if (state === "legacy") void sync();
        return;
      }
      if (state !== "stream") return;
      if (!isSample(data)) { scheduleRecovery(); return; }
      if (pending || retryTimer !== null) { enqueue(data); return; }
      if (!snapshot || snapshot.runId !== data.runId || data.sequence > (snapshot.sequence ?? 0) + 1) {
        enqueue(data);
        scheduleRecovery();
        return;
      }
      if (data.sequence <= (snapshot.sequence ?? 0)) return;
      snapshot = mergeResources(snapshot, fromEvent(data));
      publish();
    },
  });
  return () => {
    disposed = true;
    unsubscribe();
    cancelRead();
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (staleTimer !== null) clearTimeout(staleTimer);
    if (legacyTimer !== null) clearInterval(legacyTimer);
  };
}
