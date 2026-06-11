"use client";

import { ExternalLink, LayoutGrid, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAppPageLinks } from "../app-helpers";
import type { AppOpenTarget, AppPageLink, CoreApp } from "../types";
import { EmptyState, PageHeader, StatusBadge } from "../ui";

export function AvailableAppsPage({
  apps,
  loading,
  busyAction,
  onLaunchApp,
  getStandaloneHref,
}: {
  apps: CoreApp[];
  loading: boolean;
  busyAction: string | null;
  onLaunchApp: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="Apps" description="Runtime apps available to the current user." />
      {loading && apps.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : apps.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="No apps available" description="No runtime app UI is available for this account." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {apps.map((app) => {
            const pages = getAppPageLinks(app);
            const primaryPage = pages[0] ?? null;
            const canOpen = app.runtimeState === "running" && primaryPage !== null;
            const busy = busyAction === `${app.id}:open`;
            return (
              <div key={app.id} className="rounded-lg border bg-card p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h2 className="truncate text-base font-semibold">{app.displayName}</h2>
                    <p className="truncate text-xs text-muted-foreground">{app.id}</p>
                  </div>
                  <StatusBadge value={app.runtimeState || app.operationStatus} />
                </div>
                {app.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canOpen || busy}
                    onClick={() => {
                      if (primaryPage) {
                        void onLaunchApp(app, primaryPage, "workspace");
                      }
                    }}
                  >
                    {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LayoutGrid className="h-4 w-4" />}
                    Open
                  </Button>
                  {primaryPage && (
                    <Button asChild variant="outline" size="sm" className={cn(!canOpen && "pointer-events-none opacity-50")} aria-disabled={!canOpen}>
                      <a
                        href={canOpen ? getStandaloneHref(app, primaryPage) : undefined}
                        target="_blank"
                        rel="noreferrer"
                        tabIndex={canOpen ? undefined : -1}
                        onClick={(event) => {
                          if (!canOpen) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Standalone
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
