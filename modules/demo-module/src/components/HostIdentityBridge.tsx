"use client";

import { useEffect } from "react";

const readyMessage = { type: "docker-host:ready" };
const bootstrapMarker = "docker-host:module-identity-bootstrapped-at";
const bootstrapRefreshMs = 4 * 60 * 1000;

export function HostIdentityBridge() {
  useEffect(() => {
    if (window.parent === window) {
      return undefined;
    }

    const referrerOrigin = getReferrerOrigin();
    let bootstrapped = false;

    async function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        (data as { type?: unknown }).type !== "docker-host:identity"
      ) {
        return;
      }

      const token = (data as { token?: unknown }).token;
      const hostOrigin = (data as { hostOrigin?: unknown }).hostOrigin;
      if (
        typeof token !== "string" ||
        (typeof hostOrigin === "string" && hostOrigin !== event.origin) ||
        (referrerOrigin && event.origin !== referrerOrigin)
      ) {
        return;
      }

      const bootstrappedAt = Number(window.sessionStorage.getItem(bootstrapMarker) || "0");
      if (Date.now() - bootstrappedAt < bootstrapRefreshMs) {
        return;
      }

      const response = await fetch("/api/auth/bootstrap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok || bootstrapped) {
        return;
      }

      bootstrapped = true;
      window.sessionStorage.setItem(bootstrapMarker, String(Date.now()));
      window.location.reload();
    }

    window.addEventListener("message", handleMessage);
    window.parent.postMessage(readyMessage, referrerOrigin || "*");

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return null;
}

function getReferrerOrigin() {
  if (!document.referrer) {
    return null;
  }

  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}
