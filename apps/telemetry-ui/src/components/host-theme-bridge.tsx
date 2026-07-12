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

    // event.source === window.parent is set by the browser and is the trustworthy gate — the
    // embedding origin (from the shared parent-origin listener) is learned from this same message,
    // so it can't be used to pre-filter it. Theme is non-sensitive; the source check is sufficient.
    const handleMessage = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent) {
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
