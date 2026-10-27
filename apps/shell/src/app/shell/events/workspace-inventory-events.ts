"use client";

import { CoreEventNames, subscribeToCoreEvents } from "./core-event-stream";

type InventoryAccess = "authorized" | "forbidden" | "unavailable";

/** Optional source metadata never owns the ordinary notification/resource connection. */
export function watchWorkspaceInventory(coreOrigin: string, read: () => Promise<InventoryAccess>): () => void {
  let disposed = false;
  let running = false;
  let queued = false;
  let urgent = false;
  let pageActive = true;
  let nextRead = 0;
  let retryAt = 0;
  let retryDelay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workspaceEnabled = false;
  let accessGeneration = 0;
  let stopWorkspace: (() => void) | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const disableWorkspace = () => {
    accessGeneration++;
    workspaceEnabled = false;
    const stop = stopWorkspace;
    stopWorkspace = undefined;
    stop?.();
  };
  const enableWorkspace = () => {
    if (disposed || workspaceEnabled) return;
    workspaceEnabled = true;
    const stop = subscribeToCoreEvents(coreOrigin, {
      names: [CoreEventNames.workspaceChanged], topic: "workspaces", onSync: resync,
      onEvent: changed, receiveWhileSyncing: true,
      // EventSource hides HTTP status. The ordinary connection revalidates metadata
      // access before an optional topic can be requested again after a stream error.
      onStreamState: state => { if (state === "error") disableWorkspace(); },
    });
    if (workspaceEnabled) stopWorkspace = stop;
    else stop();
  };
  function schedule(immediate = false): void {
    if (disposed) return;
    queued = true;
    if (immediate) { urgent = true; retryAt = 0; clearTimer(); }
    pump();
  }
  function pump(): void {
    if (disposed || !pageActive || document.visibilityState === "hidden" || running || timer || !queued) return;
    const wait = Math.max(0, (retryAt || (urgent ? 0 : nextRead)) - Date.now());
    if (wait) { timer = setTimeout(() => { timer = undefined; pump(); }, wait); return; }
    void load();
  }
  async function load(): Promise<void> {
    running = true; queued = false; urgent = false;
    const generation = accessGeneration;
    try {
      const access = await read();
      if (disposed) return;
      // An old response cannot re-enable access after disconnection or page suspension.
      if (generation !== accessGeneration) { queued = true; return; }
      if (access === "unavailable") throw new Error("Workspace inventory unavailable");
      retryDelay = 1000; retryAt = 0;
      // Events keep one trailing read, five seconds after the previous read finishes.
      // Readiness and visibility recovery bypass this cooldown; quiet pages never poll.
      nextRead = Date.now() + 5000;
      if (access === "authorized") enableWorkspace();
      else disableWorkspace();
    } catch {
      if (!disposed && generation === accessGeneration) {
        queued = true; urgent = false;
        retryAt = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    } finally { running = false; pump(); }
  }
  function changed() { schedule(); }
  function resync() { schedule(true); }
  function suspend() { accessGeneration++; clearTimer(); queued = true; }
  function visibility() { if (document.visibilityState === "hidden") suspend(); else resync(); }
  function pageHide() { pageActive = false; suspend(); }
  function pageShow() { pageActive = true; resync(); }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  const stopOrdinary = subscribeToCoreEvents(coreOrigin, {
    names: [CoreEventNames.appChanged, CoreEventNames.appRemoved], onSync: resync,
    onEvent: changed, receiveWhileSyncing: true,
  });
  return () => {
    disposed = true; clearTimer(); disableWorkspace(); stopOrdinary();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
  };
}
