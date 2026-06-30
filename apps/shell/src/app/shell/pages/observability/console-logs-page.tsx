"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../../core-api";
import type { CoreApp, LogsResponse, LogsServiceSegment } from "../../types";
import { EmptyState, PageHeader } from "../../ui";

type ConsoleLogsState = { loading: boolean; error: string | null; text: string; services: LogsServiceSegment[] };

// Cross-resource Console logs view, modelled on the .NET Aspire "Console logs" page: pick a resource,
// see its raw stdout/stderr tail (docker logs). This is deliberately separate from the structured
// OTLP-logs stream — the two are never interleaved.
export function ObservabilityConsoleLogsPage({
  runtimeApps,
  systemApps,
  coreOrigin,
}: {
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  coreOrigin: string;
}) {
  const apps = useMemo(() => [...runtimeApps, ...systemApps], [runtimeApps, systemApps]);

  // Default to the first running app so the page lands on something with output.
  const defaultAppId = useMemo(() => {
    const running = apps.find((app) => app.runtimeState === "running");
    return running?.id ?? apps[0]?.id ?? null;
  }, [apps]);

  const [selectedAppId, setSelectedAppId] = useState<string | null>(defaultAppId);
  const [state, setState] = useState<ConsoleLogsState>({ loading: false, error: null, text: "", services: [] });
  const [activeService, setActiveService] = useState<string | null>(null);

  // Keep the selection valid as the app set changes (adjust during render, not in an effect).
  const appsSignature = apps.map((app) => app.id).join(",");
  const [prevAppsSignature, setPrevAppsSignature] = useState(appsSignature);
  if (prevAppsSignature !== appsSignature) {
    setPrevAppsSignature(appsSignature);
    if (!selectedAppId || !apps.some((app) => app.id === selectedAppId)) {
      setSelectedAppId(defaultAppId);
    }
  }

  const selectedApp = apps.find((app) => app.id === selectedAppId) ?? null;

  const loadLogs = useCallback(
    async (appId: string) => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/logs?tail=200`, {
          credentials: "include",
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const payload = (await response.json()) as LogsResponse;
        const services = payload.services ?? [];
        setState({ loading: false, error: null, text: payload.text || "", services });
        setActiveService(services[0]?.service ?? null);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }
        setState({
          loading: false,
          error: error instanceof Error ? error.message : "Console logs are unavailable.",
          text: "",
          services: [],
        });
      }
    },
    [coreOrigin],
  );

  useEffect(() => {
    if (selectedAppId) {
      void loadLogs(selectedAppId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppId]);

  const hasTabs = state.services.length > 1;
  const activeSegment = state.services.find((segment) => segment.service === activeService) ?? state.services[0];
  const body = state.loading
    ? "Loading logs"
    : state.services.length > 0
      ? activeSegment?.text || "No logs"
      : state.text || "No logs";

  return (
    <div className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Console logs"
        description="Raw stdout/stderr tail for a resource (separate from the structured OTLP-logs stream)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={apps.length === 0}>
                  {selectedApp?.displayName ?? "Select resource"}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Resource</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={selectedAppId ?? ""} onValueChange={setSelectedAppId}>
                  {apps.map((app) => (
                    <DropdownMenuRadioItem key={app.id} value={app.id}>
                      {app.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              onClick={() => selectedAppId && void loadLogs(selectedAppId)}
              disabled={!selectedAppId || state.loading}
            >
              <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      {apps.length === 0 ? (
        <EmptyState icon={Terminal} title="No resources" description="Install an app to see its console logs." />
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          {state.error && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              {state.error}
            </div>
          )}
          {hasTabs && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {state.services.map((segment) => (
                <Button
                  key={segment.service}
                  variant={segment.service === activeService ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveService(segment.service)}
                >
                  {segment.service}
                </Button>
              ))}
            </div>
          )}
          <pre className="min-h-[24rem] min-w-0 max-w-full flex-1 overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">
            {body}
          </pre>
        </div>
      )}
    </div>
  );
}
