"use client";

/**
 * Follows the theme Shell posts to an embedded page.
 *
 * The message is the same `hosty:shell-theme` every embedded Hosty page receives; the page also
 * reads the `hosty_theme` query parameter Shell appends to the launch URL, so the very first paint
 * is already correct rather than flashing the default and correcting itself.
 */
export function startThemeSync(): () => void {
  const apply = (theme: string | null) => {
    if (theme === "dark" || theme === "light") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  };

  apply(new URLSearchParams(window.location.search).get("hosty_theme"));

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (data && typeof data === "object" && data.type === "hosty:shell-theme") {
      apply(typeof data.theme === "string" ? data.theme : null);
    }
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
