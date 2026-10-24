"use client";

import { appFetch } from "@hosty-sdk/app/browser-auth";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleAlert, LineChart, ScrollText, Waypoints } from "lucide-react";
import { HostyNavigationBoundary } from "@hosty-sdk/app/react";
import { cn } from "@/lib/utils";
import type { TelemetryApp } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { TelemetryMark } from "@/components/telemetry-mark";
import { HostyLoader } from "../../../../shared/web/hosty-states";

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
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await appFetch("/api/apps", { signal: controller.signal });
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
  }, [retry]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      {/* Wordmark plus the manifest `ui.navigation` pages — both drawn by a surrounding shell, so
          the whole header is marked as duplicated chrome and hidden there by globals.css. */}
      <HostyNavigationBoundary><header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <TelemetryMark className="size-8" tile />
          <span className="text-base font-semibold">Telemetry</span>
        </div>
        <nav aria-label="Telemetry" className="flex gap-1 overflow-x-auto border-b">
          {TABS.map((tab) => {
            const active = pathname === tab.href || (pathname === "/" && tab.href === "/metrics");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex shrink-0 items-center gap-1.5 border-b-[3px] px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0",
                  active
                    ? "border-brand-strong text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header></HostyNavigationBoundary>
      <main className="min-w-0 flex-1">
        {!state.loaded ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3" role="status">
            <HostyLoader className="size-8" label={null} />
            <span className="text-sm text-muted-foreground">Loading Telemetry…</span>
          </div>
        ) : (
          <AppsContext.Provider value={state.apps}>
            {state.error && (
              <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive-soft p-4 text-destructive-foreground">
                <CircleAlert className="size-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Resources could not be loaded</p>
                  <p className="break-words text-sm">{state.error}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => {
                  setState({ apps: [], loaded: false, error: null });
                  setRetry((current) => current + 1);
                }}>Try again</Button>
              </div>
            )}
            {!state.error && children}
          </AppsContext.Provider>
        )}
      </main>
    </div>
  );
}
