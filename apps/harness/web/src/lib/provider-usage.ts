"use client";
import { useCallback, useSyncExternalStore } from "react";
import { call } from "./api";
import { openEventStream } from "./event-stream";
export type { ProviderUsage, UsageRow } from "../../../src/harness/provider-usage";
import type { ProviderUsage } from "../../../src/harness/provider-usage";

type View = { usage: ProviderUsage | null; refreshing: boolean };
type Entry = { serial: number; view: View; listeners: Set<() => void>; abort?: AbortController; retry?: ReturnType<typeof setTimeout>; pending?: Promise<void>; stop?: () => void };
const empty: View = { usage: null, refreshing: false };
const entries = new Map<string, Entry>();
export function newestUsage(current: ProviderUsage | null, next: ProviderUsage): ProviderUsage {
  return current?.connectionRevision === next.connectionRevision && current?.sequence !== undefined && next.sequence !== undefined && current.sequence > next.sequence ? current : next;
}
const emit = (entry: Entry, view: View) => {
  entry.view = view.usage ? { ...view, usage: newestUsage(entry.view.usage, view.usage) } : view;
  for (const listener of entry.listeners) listener();
};
function entryFor(id: string) {
  let entry = entries.get(id);
  if (!entry) { entry = { serial: 0, view: empty, listeners: new Set() }; entries.set(id, entry); }
  return entry;
}
async function refresh(id: string, entry: Entry) {
  if (entry.pending) return entry.pending;
  emit(entry, { ...entry.view, refreshing: true });
  const serial = entry.serial;
  entry.pending = (async () => {
    try {
      const response = await call("/connections/" + encodeURIComponent(id) + "/usage?refresh=true");
      const usage = await response.json() as ProviderUsage;
      emit(entry, { usage: entry.serial === serial ? usage : entry.view.usage, refreshing: false });
    } catch {
      emit(entry, { usage: entry.serial === serial ? { ...(entry.view.usage ?? { state: "unavailable", rows: [], observedAt: null }), stale: true } : entry.view.usage, refreshing: false });
    }
  })().finally(() => { entry.pending = undefined; });
  return entry.pending;
}
function start(id: string, entry: Entry) {
  let stopped = false;
  const connect = async () => {
    if (stopped || document.visibilityState === "hidden") return;
    entry.abort?.abort(); const abort = new AbortController(); entry.abort = abort;
    void refresh(id, entry);
    try {
      const response = await openEventStream("/api/connections/" + encodeURIComponent(id) + "/usage/events", { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("Unavailable");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      try {
        while (!abort.signal.aborted) {
          const part = await reader.read(); if (part.done || abort.signal.aborted) break;
          buffer += decoder.decode(part.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
            if (data) { const usage = JSON.parse(data) as ProviderUsage; if (Array.isArray(usage.rows)) { entry.serial++; emit(entry, { usage, refreshing: entry.view.refreshing }); } }
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { /* Reconnect also reloads the retained snapshot. */ }
    if (abort.signal.aborted || stopped) return;
    if (entry.view.usage) emit(entry, { ...entry.view, usage: { ...entry.view.usage, stale: true } });
    entry.retry = setTimeout(() => { void connect(); }, 5000);
  };
  const visibility = () => {
    clearTimeout(entry.retry); entry.abort?.abort();
    if (document.visibilityState !== "hidden") void connect();
  };
  document.addEventListener("visibilitychange", visibility); void connect();
  entry.stop = () => { stopped = true; clearTimeout(entry.retry); entry.abort?.abort(); document.removeEventListener("visibilitychange", visibility); };
}
export function useProviderUsage(id: string) {
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(id); entry.listeners.add(listener);
    if (entry.listeners.size === 1) start(id, entry);
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.stop?.(); entries.delete(id); } };
  }, [id]);
  const get = useCallback(() => entries.get(id)?.view ?? empty, [id]);
  const view = useSyncExternalStore(subscribe, get, () => empty);
  return { ...view, refresh: () => refresh(id, entryFor(id)) };
}
