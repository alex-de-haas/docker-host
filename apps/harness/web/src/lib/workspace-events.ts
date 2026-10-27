"use client";
import { openEventStream } from "./event-stream";

type Listener = { sync: () => Promise<void | boolean>; unavailable: () => void; running: boolean; queued: boolean; disposed: boolean; retry?: ReturnType<typeof setTimeout>; retryDelay: number; nextSync: number; epoch: number };
const connections = new Map<string, ReturnType<typeof connection>>();

// One authenticated stream per app/tab. Hints coalesce; reconnect and visibility restoration resync.
export function subscribeWorkspaceEvents(url: string, sync: () => Promise<void | boolean>, unavailable: () => void) {
  let shared = connections.get(url);
  if (!shared) { shared = connection(url); connections.set(url, shared); }
  const listener: Listener = { sync, unavailable, running: false, queued: false, disposed: false, retryDelay: 1000, nextSync: 0, epoch: 0 };
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
  // A sustained stream of source writes must not turn into continuous snapshot/Git reads.
  // Keep one trailing refresh and leave five seconds after each completed background read.
  function schedule(listener: Listener, immediate = false) {
    if (listener.disposed) return;
    listener.queued = true;
    if (immediate) { listener.nextSync = 0; clearTimeout(listener.retry); listener.retry = undefined; }
    if (!ready || !visible() || listener.running || listener.retry) return;
    const wait = Math.max(0, listener.nextSync - Date.now());
    if (wait) {
      listener.retry = setTimeout(() => { listener.retry = undefined; schedule(listener); }, wait);
      return;
    }
    void sync(listener);
  }
  async function sync(listener: Listener) {
    if (listener.disposed || !ready || !visible() || listener.running) return;
    listener.queued = false; listener.running = true;
    const epoch = listener.epoch;
    try {
      if (await listener.sync() === false) throw new Error("Workspace snapshot unavailable");
      if (epoch === listener.epoch) {
        listener.retryDelay = 1000;
        listener.nextSync = Date.now() + 5000;
      }
    } catch {
      if (!listener.disposed && epoch === listener.epoch) {
        listener.unavailable();
        listener.queued = true;
        listener.nextSync = Date.now() + listener.retryDelay;
        listener.retryDelay = Math.min(listener.retryDelay * 2, 30_000);
      }
    } finally {
      listener.running = false;
      if (listener.queued) schedule(listener);
    }
  }
  function changed(immediate = false) {
    if (immediate) {
      clearTimeout(debounce); debounce = undefined;
      for (const listener of listeners) schedule(listener, true);
    } else if (!debounce) {
      debounce = setTimeout(() => { debounce = undefined; for (const listener of listeners) schedule(listener); }, 150);
    }
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
      const response = await openEventStream(url, { signal: active.signal });
      if (response.status === 404 || response.status === 405) {
        // Independently upgraded clients still read older Core versions. Periodic capability
        // probes do not reload snapshots; entry, manual refresh and visibility restore do.
        fallback = true; ready = true; delay = 1000;
        if (!legacy) changed(true);
        legacy = true;
        await response.body?.cancel().catch(() => {});
        return;
      }
      ready = false;
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Workspace stream unavailable");
      }
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
            if (event === "stream.unsupported") {
              // The socket bridge preserves an older Core's explicit 404/405 capability result.
              fallback = true; ready = true; delay = 1000;
              if (!legacy) changed(true);
              legacy = true;
              return;
            }
            if (event === "stream.ready") { legacy = false; ready = true; delay = 1000; changed(true); }
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
            for (const listener of listeners) { clearTimeout(listener.retry); listener.retry = undefined; listener.queued = false; listener.epoch++; listener.nextSync = 0; listener.unavailable(); }
          }
          retry = setTimeout(() => { retry = undefined; void open(); }, fallback ? 30_000 : delay);
          if (!fallback) delay = Math.min(delay * 2, 30_000);
        }
      }
    }
  }
  function stop() {
    for (const listener of listeners) { clearTimeout(listener.retry); listener.retry = undefined; listener.queued = false; listener.epoch++; listener.nextSync = 0; }
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
      } else if (ready) schedule(listener, true);
    },
    remove(listener: Listener) {
      clearTimeout(listener.retry); listener.retry = undefined;
      listeners.delete(listener);
      if (!listeners.size) {
        stop(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pageshow", pageShow);
        connections.delete(url);
      }
    },
  };
}
