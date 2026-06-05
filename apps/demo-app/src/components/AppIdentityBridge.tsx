"use client";

import { useEffect } from "react";

export function AppIdentityBridge() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) {
      return undefined;
    }

    url.searchParams.delete("code");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    let cancelled = false;
    async function exchangeCode() {
      const response = await fetch("/api/auth/app-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });
      if (response.ok && !cancelled) {
        window.location.reload();
      }
    }

    void exchangeCode();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
