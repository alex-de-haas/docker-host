"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, LineChart, LoaderCircle, ScrollText, Waypoints } from "lucide-react";
import { SHELL_DUPLICATED_CHROME_CLASS } from "@hosty-sdk/app";
import { cn } from "@/lib/utils";
import type { TelemetryApp } from "@/lib/types";

type AppsState = { apps: TelemetryApp[]; loaded: boolean; error: string | null };

// The fleet roster (id → displayName), fetched once from the app's own /api/apps route and shared with
// every page for the resource picker and label enrichment.
const AppsContext = createContext<TelemetryApp[]>([]);

export function useApps(): TelemetryApp[] {
  return useContext(AppsContext);
}

const TABS = [
  { href: "/metrics", label: "Metrics", icon: LineChart },
  { href: "/logs", label: "Structured logs", icon: ScrollText },
  { href: "/traces", label: "Traces", icon: Waypoints },
] as const;

// Persistent app frame: the header + tab bar (client-side routing, so switching pages never reloads the
// iframe) and the roster provider. Renders a loader until the first roster fetch settles so pages never
// flash "No resources" before the roster arrives.
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<AppsState>({ apps: [], loaded: false, error: null });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/apps", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Roster request failed (${response.status}).`);
        }
        const payload = (await response.json()) as { apps?: TelemetryApp[] };
        setState({ apps: Array.isArray(payload.apps) ? payload.apps : [], loaded: true, error: null });
      } catch (error) {
        // Aborted on unmount — the fetch was cancelled, so don't touch state on a gone component.
        // fetch aborts throw a DOMException (not an Error subclass), so guard on that.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState({ apps: [], loaded: true, error: error instanceof Error ? error.message : "Roster unavailable." });
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      {/* Wordmark plus the manifest `ui.navigation` pages — both drawn by a surrounding shell, so
          the whole header is marked as duplicated chrome and hidden there by globals.css. */}
      <header className={cn("flex flex-col gap-3", SHELL_DUPLICATED_CHROME_CLASS)}>
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-semibold">Telemetry</span>
        </div>
        <nav className="flex gap-1 border-b">
          {TABS.map((tab) => {
            const active = pathname === tab.href || (pathname === "/" && tab.href === "/metrics");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="min-w-0 flex-1">
        {!state.loaded ? (
          <div className="flex min-h-64 items-center justify-center">
            <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <AppsContext.Provider value={state.apps}>{children}</AppsContext.Provider>
        )}
      </main>
    </div>
  );
}
