"use client";

import { CoreEventNames, subscribeToCoreEvents } from "./core-event-stream";

type InventoryAccess = "authorized" | "forbidden" | "unavailable";

/** Optional source metadata never owns the ordinary notification/resource connection. */
export function watchWorkspaceInventory(coreOrigin: string, read: () => Promise<InventoryAccess>): () => void {
  let disposed = false;
  let pending: Promise<void> | null = null;
  let reread = false;
  let workspaceEnabled = false;
  let accessGeneration = 0;
  let stopWorkspace: (() => void) | undefined;
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
      names: [CoreEventNames.workspaceChanged], topic: "workspaces", onSync: load,
      // EventSource hides HTTP status. Fall back to the ordinary connection first; its open
      // then revalidates metadata access before an optional topic can be requested again.
      onStreamState: state => { if (state === "error") disableWorkspace(); },
    });
    if (workspaceEnabled) stopWorkspace = stop;
    else stop();
  };
  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) { reread = true; return pending; }
    pending = (async () => {
      do {
        reread = false;
        const generation = accessGeneration;
        const access = await read();
        if (disposed) return;
        // A response begun before revocation/disconnection cannot re-enable optional access.
        if (generation !== accessGeneration) { reread = true; continue; }
        if (access === "authorized") enableWorkspace();
        else if (access === "forbidden") disableWorkspace();
      } while (reread && !disposed);
    })().finally(() => { pending = null; });
    return pending;
  };
  const stopOrdinary = subscribeToCoreEvents(coreOrigin, {
    names: [CoreEventNames.appChanged, CoreEventNames.appRemoved], onSync: load,
  });
  return () => { disposed = true; disableWorkspace(); stopOrdinary(); };
}
