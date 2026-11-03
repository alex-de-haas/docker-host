"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-hosty-theme"],
  });
  return () => observer.disconnect();
}

function currentIcon() {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "/favicon-dark.svg";
  if (root.classList.contains("light") || root.dataset.hostyTheme === "light") return "/favicon-light.svg";
  return "/favicon.svg";
}

// SSR and initial hydration use the adaptive icon; the existing theme owner then
// selects a fixed variant, including saved preferences and host theme changes.
export function ThemeFavicon() {
  const href = useSyncExternalStore(subscribe, currentIcon, () => "/favicon.svg");
  return <link rel="icon" href={href} type="image/svg+xml" sizes="any" />;
}
