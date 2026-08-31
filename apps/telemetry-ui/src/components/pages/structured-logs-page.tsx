"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, RefreshCw, ScrollText, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isAuthRequiredError, readApiError, throwIfAuthRequired } from "@/lib/api-client";
import { OtlpLogTable, SEVERITY_FILTERS } from "@/components/observability/otlp-log-table";
import type { FleetOtlpLogsResponse, TelemetryApp } from "@/lib/types";
import { withCoreSource } from "@/lib/core-source";
import { EmptyState, PageHeader } from "@/components/page-shell";

const ALL = "__all__";

const RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

type LogsState = { loading: boolean; error: string | null; response: FleetOtlpLogsResponse | null };

// Cross-resource Structured logs view, modelled on the .NET Aspire "Structured logs" page: OTLP log
// records merged across every resource into one searchable, severity-filterable stream. Backed by the
// Core fleet endpoint (GET /api/observability/logs) which does the cross-app merge + global ordering.
// This is the structured OTLP stream — never interleaved with the console (docker logs) view.
export function ObservabilityStructuredLogsPage({ apps: roster }: { apps: TelemetryApp[] }) {
  // Hosty Core is a source without an installed app behind it, so the roster alone would leave its
  // records visible under "All resources" and impossible to isolate.
  const apps = withCoreSource(roster);
  const [selectedAppId, setSelectedAppId] = useState<string>(ALL);
  const [severityFloor, setSeverityFloor] = useState(0);
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LogsState>({ loading: false, error: null, response: null });

  // Keep the selection valid as the app set changes (adjust during render, not in an effect).
  const appsSignature = apps.map((app) => app.id).join(",");
  const [prevAppsSignature, setPrevAppsSignature] = useState(appsSignature);
  if (prevAppsSignature !== appsSignature) {
    setPrevAppsSignature(appsSignature);
    if (selectedAppId !== ALL && !apps.some((app) => app.id === selectedAppId)) {
      setSelectedAppId(ALL);
    }
  }

  // Debounced typing + manual refresh can overlap; a request token ensures only the latest in-flight
  // request updates state, so a slower earlier response can't overwrite newer results or errors.
  const requestRef = useRef(0);
  const loadLogs = useCallback(
    async (appId: string, severity: number, range: number, text: string) => {
      const token = ++requestRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ range: String(range), limit: "500" });
        if (severity > 0) {
          params.set("severity", String(severity));
        }
        if (appId !== ALL) {
          params.set("apps", appId);
        }
        const trimmed = text.trim();
        if (trimmed) {
          params.set("q", trimmed);
        }
        const response = await fetch(`/api/observability/logs?${params.toString()}`);
        throwIfAuthRequired(response);
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        const payload = (await response.json()) as FleetOtlpLogsResponse;
        if (token !== requestRef.current) {
          return;
        }
        setState({ loading: false, error: null, response: payload });
      } catch (error) {
        if (isAuthRequiredError(error) || token !== requestRef.current) {
          return;
        }
        // Keep the previously loaded logs on a transient failure rather than blanking the table (S-M2).
        setState((current) => ({
          loading: false,
          error: error instanceof Error ? error.message : "Structured logs are unavailable.",
          response: current.response,
        }));
      }
    },
    [],
  );

  // Refetch on any filter change; debounce so typing in the search box does not hammer Core.
  useEffect(() => {
    const handle = setTimeout(() => void loadLogs(selectedAppId, severityFloor, rangeSeconds, query), 300);
    return () => clearTimeout(handle);
  }, [loadLogs, selectedAppId, severityFloor, rangeSeconds, query]);

  const records = state.response?.records ?? [];
  const showSource = selectedAppId === ALL;
  const selectedLabel =
    selectedAppId === ALL ? "All resources" : apps.find((app) => app.id === selectedAppId)?.displayName ?? "All resources";

  return (
    <div className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Structured logs"
        description="OTLP log records across every resource (live, last hour). Distinct from the console logs view."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadLogs(selectedAppId, severityFloor, rangeSeconds, query)}
            disabled={state.loading}
          >
            <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {selectedLabel}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Resource</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={selectedAppId} onValueChange={setSelectedAppId}>
              <DropdownMenuRadioItem value={ALL}>All resources</DropdownMenuRadioItem>
              {apps.map((app) => (
                <DropdownMenuRadioItem key={app.id} value={app.id}>
                  {app.displayName}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex gap-1">
          {SEVERITY_FILTERS.map((option) => (
            <Button
              key={option.floor}
              variant={option.floor === severityFloor ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSeverityFloor(option.floor)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div className="flex gap-1">
          {RANGES.map((range) => (
            <Button
              key={range.seconds}
              variant={range.seconds === rangeSeconds ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setRangeSeconds(range.seconds)}
            >
              {range.label}
            </Button>
          ))}
        </div>

        <div className="relative ml-auto min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search log body…"
            className="pl-8"
          />
        </div>
      </div>

      {state.error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {state.error}
        </div>
      )}

      {state.loading && records.length === 0 ? (
        <EmptyState icon={LoaderCircle} title="Loading logs" iconClassName="animate-spin" />
      ) : records.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No structured logs"
          description="Records appear for apps that opt into telemetry and export the OpenTelemetry logs signal, with the Telemetry app enabled on the host (Shell platform panel or hosty setup --with hosty.telemetry)."
        />
      ) : (
        <OtlpLogTable records={records} showSource={showSource} />
      )}
    </div>
  );
}
