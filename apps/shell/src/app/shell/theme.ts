import type { HostyResolvedTheme, HostyThemePreference } from "./types";

export function normalizeThemePreference(theme: string | undefined): HostyThemePreference {
  return theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
}

export function resolveShellTheme(resolvedTheme: string | undefined): HostyResolvedTheme {
  if (resolvedTheme === "dark") {
    return "dark";
  }

  if (
    resolvedTheme !== "light" &&
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  ) {
    return "dark";
  }

  return "light";
}
