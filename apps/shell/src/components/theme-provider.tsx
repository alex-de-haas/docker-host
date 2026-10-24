"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

const subscribeToHydration = () => () => {};

function ThemeFavicon() {
  const { resolvedTheme } = useTheme();
  // Keep server and initial client markup identical before reading the saved theme.
  const hydrated = React.useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const href = hydrated && (resolvedTheme === "dark" || resolvedTheme === "light")
    ? `/favicon-${resolvedTheme}.svg`
    : "/favicon.svg";

  // React hoists this single icon into head and updates it on theme changes.
  return <link rel="icon" href={href} type="image/svg+xml" sizes="any" />;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ThemeFavicon />
      {children}
    </NextThemesProvider>
  );
}
