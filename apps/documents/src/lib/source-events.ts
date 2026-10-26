import { appFetch } from "@hosty-sdk/app/browser-auth";

// One visible-page subscription, scoped to this application and browser identity. Failed streams
// retry with backoff; old Core versions retain entry/refresh/visibility reads without polling Git.
export function observeSources(
  repository: string | null,
  changed: () => void,
  health: (state: string) => void,
) {
  let stopped = false,
    connection: AbortController | null = null,
    retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  async function connect() {
    if (stopped || connection || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    connection = controller;
    try {
      const response = await appFetch(
        `/api/events${repository ? `?${new URLSearchParams({ repository })}` : ""}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if ([404, 501].includes(response.status)) {
        health("Live updates need a newer Core. Refresh manually.");
        return;
      }
      if (!response.ok || !response.body) throw new Error("Stream unavailable");
      health("Live updates connected");
      delay = 1000;
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const event = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (/^event: (?:source.changed|stream.ready)$/m.test(event))
              changed();
            if (/^event: stream.revoked$/m.test(event)) {
              health("Source access changed. Refresh to sign in again.");
              changed();
              return;
            }
          }
          if (pending.length > 65536) throw new Error("Invalid source stream");
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!controller.signal.aborted) throw new Error("Source stream ended");
    } catch {
      if (!controller.signal.aborted && !stopped) {
        health("Reconnecting live updates…");
        retry = setTimeout(() => {
          retry = null;
          void connect();
        }, delay);
        delay = Math.min(delay * 2, 30000);
      }
    } finally {
      if (connection === controller) connection = null;
    }
  }
  const visibility = () => {
    if (document.visibilityState === "visible") {
      changed();
      void connect();
    } else {
      connection?.abort();
      connection = null;
      if (retry) clearTimeout(retry);
      retry = null;
    }
  };
  document.addEventListener("visibilitychange", visibility);
  void connect();
  return () => {
    stopped = true;
    connection?.abort();
    if (retry) clearTimeout(retry);
    document.removeEventListener("visibilitychange", visibility);
  };
}
