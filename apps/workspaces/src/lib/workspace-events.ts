"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";

type Listener = { sync: () => Promise<void>; unavailable: () => void; running: boolean; queued: boolean; disposed: boolean };
const connections = new Map<string, ReturnType<typeof connection>>();

// One authenticated stream per app/tab. Hints coalesce; reconnect and visibility restoration resync.
export function subscribeWorkspaceEvents(url: string, sync: () => Promise<void>, unavailable: () => void) {
  let shared = connections.get(url);
  if (!shared) { shared = connection(url); connections.set(url, shared); }
  const listener: Listener = { sync, unavailable, running: false, queued: false, disposed: false };
  shared.add(listener);
  return () => { listener.disposed = true; shared.remove(listener); };
}

function connection(url: string) {
  const listeners = new Set<Listener>();
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let ready = false;
  let legacy = false;
  const visible = () => document.visibilityState !== "hidden";
  async function sync(listener: Listener) {
    if (listener.disposed) return;
    if (listener.running) { listener.queued = true; return; }
    listener.running = true;
    try { await listener.sync(); }
    catch { if (!listener.disposed) listener.unavailable(); }
    finally {
      listener.running = false;
      if (listener.queued && !listener.disposed) { listener.queued = false; void sync(listener); }
    }
  }
  function changed() {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = undefined; for (const listener of listeners) void sync(listener); }, 150);
  }
  function touch() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller?.abort(), 45_000);
  }
  async function open() {
    if (!listeners.size || !visible() || controller) return;
    const active = new AbortController(); controller = active;
    let fallback = false;
    touch();
    try {
      const response = await appFetch(url, { signal: active.signal, cache: "no-store", headers: { Accept: "text/event-stream" } });
      if (response.status === 404 || response.status === 405) {
        // Independently upgraded clients still read older Core versions. Periodic capability
        // probes do not reload snapshots; entry, manual refresh and visibility restore do.
        fallback = true; ready = true; delay = 1000;
        if (!legacy) changed();
        legacy = true;
        await response.body?.cancel();
        return;
      }
      legacy = false; ready = false;
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Workspace stream unavailable");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
        while (!active.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          touch(); buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r", "");
          if (buffer.length > 65536) throw new Error("Workspace stream frame exceeded its limit");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const event = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
            if (event === "stream.revoked") throw new Error("Workspace access ended");
            if (event === "stream.ready") { ready = true; delay = 1000; changed(); }
            else if (event === "workspace.changed" && ready) changed();
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { /* Reconnect with the app's current credential; never retain source after lost authority. */ }
    finally {
      if (controller === active) {
        controller = undefined; clearTimeout(watchdog);
        if (listeners.size && visible()) {
          if (!fallback) {
            ready = false; legacy = false;
            clearTimeout(debounce); debounce = undefined;
            for (const listener of listeners) { listener.queued = false; listener.unavailable(); }
          }
          retry = setTimeout(() => { retry = undefined; void open(); }, fallback ? 30_000 : delay);
          if (!fallback) delay = Math.min(delay * 2, 30_000);
        }
      }
    }
  }
  function stop() {
    clearTimeout(retry); retry = undefined; clearTimeout(watchdog); clearTimeout(debounce); debounce = undefined;
    const active = controller; controller = undefined; ready = false; legacy = false; active?.abort();
  }
  function visibility() { stop(); if (visible()) void open(); }
  function pageShow() { visibility(); }
  return {
    add(listener: Listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("pageshow", pageShow);
        void open();
      } else if (ready) void sync(listener);
    },
    remove(listener: Listener) {
      listeners.delete(listener);
      if (!listeners.size) {
        stop(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pageshow", pageShow);
        connections.delete(url);
      }
    },
  };
}
