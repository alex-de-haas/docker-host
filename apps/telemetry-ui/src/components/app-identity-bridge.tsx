"use client";

import { useEffect } from "react";

export function AppIdentityBridge() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) {
      return;
    }

    url.searchParams.delete("code");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    const controller = new AbortController();
    void fetch("/api/auth/app-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    })
      .then(response => {
        // On abort the fetch rejects (→ catch), so the reload never fires for a gone component.
        if (response.ok) {
          window.location.reload();
        }
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
    };
  }, []);

  return null;
}
