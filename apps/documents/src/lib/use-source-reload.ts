"use client";
import { useEffect, useRef } from "react";

type SourceLoad = (signal: AbortSignal, refresh: boolean) => Promise<void>;

// Notifications invalidate a snapshot, not its in-flight reads. Finish the current pass,
// then read once more for any changes received while it was running.
export function useSourceReload(load: SourceLoad, epoch: number, refreshEpoch: number) {
  const request = useRef<((refresh: boolean) => void) | null>(null);
  const previousRefresh = useRef(refreshEpoch);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let pending = false;
    let forceRefresh = false;
    async function drain() {
      running = true;
      try {
        while (pending && !controller.signal.aborted) {
          const refresh = forceRefresh;
          pending = false;
          forceRefresh = false;
          await load(controller.signal, refresh);
        }
      } finally {
        running = false;
      }
    }
    function reload(refresh: boolean) {
      if (controller.signal.aborted) return;
      pending = true;
      forceRefresh ||= refresh;
      if (!running) void drain();
    }
    request.current = reload;
    const refreshVisible = () => { if (document.visibilityState === "visible") reload(false); };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      controller.abort();
      request.current = null;
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load]);
  useEffect(() => {
    request.current?.(refreshEpoch !== previousRefresh.current);
    previousRefresh.current = refreshEpoch;
  }, [load, epoch, refreshEpoch]);
}
