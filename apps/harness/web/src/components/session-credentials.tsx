"use client";

import { useEffect, useState } from "react";
import { appFetch, APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";

/** Keep an existing run on the current app credential without another message or chat consent. */
export function SessionCredentials({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    let queued = false;
    const refresh = async () => {
      if (loading) { queued = true; return; }
      loading = true;
      do {
        queued = false;
        try {
          const response = await appFetch(`/api/sessions/${encodeURIComponent(sessionId)}/credentials`, {
            method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: "{}",
          });
          if (!response.ok) throw new Error("Could not refresh this conversation’s access. Retry after reconnecting.");
          if (!abort.signal.aborted) setError("");
        } catch (e) {
          if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not refresh conversation access.");
        }
      } while (queued && !abort.signal.aborted);
      loading = false;
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(APP_ACTIVITY_RENEWED, refresh);
    return () => {
      abort.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(APP_ACTIVITY_RENEWED, refresh);
    };
  }, [sessionId, retry]);

  return error ? <aside role="alert" className="mx-4 my-2 rounded border p-3 text-sm">
    {error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button>
  </aside> : null;
}
