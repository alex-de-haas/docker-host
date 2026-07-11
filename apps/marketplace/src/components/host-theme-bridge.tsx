"use client";

import { useEffect } from "react";

type ResolvedTheme = "light" | "dark";

export function HostThemeBridge() {
  useEffect(() => {
    const apply = (theme: ResolvedTheme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    };

    const stored = window.sessionStorage.getItem("hosty.theme.resolved");
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    let explicit = stored === "light" || stored === "dark";
    apply(explicit ? stored as ResolvedTheme : system.matches ? "dark" : "light");

    const parentOrigin = readParentOrigin(document.referrer);
    const handleMessage = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent || !parentOrigin || event.origin !== parentOrigin) {
        return;
      }
      const data = event.data as { type?: unknown; theme?: unknown } | null;
      if (!data || data.type !== "hosty:shell-theme" || (data.theme !== "light" && data.theme !== "dark")) {
        return;
      }

      explicit = true;
      window.sessionStorage.setItem("hosty.theme.resolved", data.theme);
      apply(data.theme);
    };
    const handleSystemChange = () => {
      if (!explicit) {
        apply(system.matches ? "dark" : "light");
      }
    };

    window.addEventListener("message", handleMessage);
    system.addEventListener("change", handleSystemChange);
    return () => {
      window.removeEventListener("message", handleMessage);
      system.removeEventListener("change", handleSystemChange);
    };
  }, []);

  return null;
}

function readParentOrigin(referrer: string): string | null {
  try {
    const url = new URL(referrer);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
