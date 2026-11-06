"use client";

import Link from "next/link";
import { CoreTraceCoverageNote } from "@/components/observability/core-trace-coverage";
import { appFetch } from "@hosty-sdk/app/browser-auth";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw, ScrollText, Search } from "lucide-react";
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
import { EmptyState, PageHeader, RequestError, RetainedResults } from "@/components/page-shell";

const ALL = "__all__";

const RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

type LoadedLogsQuery = { appId: string; severity: number; range: number; text: string; caller: string; traceId: string };
type LogsState = { loading: boolean; error: string | null; response: FleetOtlpLogsResponse | null; loadedQuery: LoadedLogsQuery | null };

// Cross-resource Structured logs view, modelled on the .NET Aspire "Structured logs" page: OTLP log
// records merged across every resource into one searchable, severity-filterable stream. Backed by the
// Core fleet endpoint (GET /api/observability/logs) which does the cross-app merge + global ordering.
// This is the structured OTLP stream — never interleaved with the console (docker logs) view.
export function ObservabilityStructuredLogsPage({ apps: roster, initialTraceId = "", initialCaller = "" }: { apps: TelemetryApp[]; initialTraceId?: string; initialCaller?: string }) {
  // Hosty Core is a source without an installed app behind it, so the roster alone would leave its
  // records visible under "All resources" and impossible to isolate.
  const apps = withCoreSource(roster);
  const [selectedAppId, setSelectedAppId] = useState<string>(ALL);
  const [severityFloor, setSeverityFloor] = useState(0);
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [query, setQuery] = useState("");
  const [caller, setCaller] = useState(initialCaller);
  const [traceId, setTraceId] = useState(initialTraceId);
  const [state, setState] = useState<LogsState>({ loading: true, error: null, response: null, loadedQuery: null });

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
    async (appId: string, severity: number, range: number, text: string, caller: string, traceId: string) => {
      const token = ++requestRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ range: String(range), limit: "500" });
        if (caller.trim()) params.set("callerAppId", caller.trim());
        if (traceId.trim()) params.set("traceId", traceId.trim());
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
        const response = await appFetch(`/api/observability/logs?${params.toString()}`);
        throwIfAuthRequired(response);
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        const payload = (await response.json()) as FleetOtlpLogsResponse;
        if (token !== requestRef.current) {
          return;
        }
        setState({ loading: false, error: null, response: payload, loadedQuery: { appId, severity, range, text: trimmed, caller, traceId } });
      } catch (error) {
        if (isAuthRequiredError(error) || token !== requestRef.current) {
          return;
        }
        // Keep the previously loaded logs on a transient failure rather than blanking the table (S-M2).
        setState((current) => ({
          ...current,
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
    const handle = setTimeout(() => void loadLogs(selectedAppId, severityFloor, rangeSeconds, query, caller, traceId), 300);
    return () => clearTimeout(handle);
  }, [loadLogs, selectedAppId, severityFloor, rangeSeconds, query, caller, traceId]);

  const records = state.response?.records ?? [];
  const loadedQuery = state.loadedQuery;
  const showingPrevious = loadedQuery !== null && (state.loading || state.error !== null
    || loadedQuery.caller !== caller || loadedQuery.traceId !== traceId || loadedQuery.appId !== selectedAppId || loadedQuery.severity !== severityFloor
    || loadedQuery.range !== rangeSeconds || loadedQuery.text !== query.trim());
  const showSource = selectedAppId === ALL || loadedQuery?.appId === ALL
    || (showingPrevious && loadedQuery?.appId !== selectedAppId);
  const loadedResource = loadedQuery?.appId === ALL ? "All resources"
    : apps.find(app => app.id === loadedQuery?.appId)?.displayName ?? loadedQuery?.appId;
  const loadedRange = RANGES.find(range => range.seconds === loadedQuery?.range)?.label;
  const loadedSeverity = SEVERITY_FILTERS.find(severity => severity.floor === loadedQuery?.severity)?.label;
  const displayedSearch = loadedQuery?.text ?? query.trim();
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
            onClick={() => void loadLogs(selectedAppId, severityFloor, rangeSeconds, query, caller, traceId)}
            disabled={state.loading}
          >
            <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin text-info")} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal text-left">
              <span className="min-w-0 wrap-anywhere">{selectedLabel}</span>
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel>Resource</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={selectedAppId} onValueChange={setSelectedAppId}>
              <DropdownMenuRadioItem value={ALL}>All resources</DropdownMenuRadioItem>
              {apps.map((app) => (
                <DropdownMenuRadioItem key={app.id} value={app.id}>
                  <span className="min-w-0 wrap-anywhere">{app.displayName}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div role="group" aria-label="Severity" className="flex gap-1">
          {SEVERITY_FILTERS.map((option) => (
            <Button
              key={option.floor}
              variant="ghost"
              aria-pressed={option.floor === severityFloor}
              className="telemetry-filter-button"
              size="sm"
              onClick={() => setSeverityFloor(option.floor)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div role="group" aria-label="Time range" className="flex gap-1">
          {RANGES.map((range) => (
            <Button
              key={range.seconds}
              variant="ghost"
              aria-pressed={range.seconds === rangeSeconds}
              className="telemetry-filter-button"
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
            aria-label="Search log body"
            className="pl-8"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={caller} onChange={event => setCaller(event.target.value)} placeholder="Calling app ID (Core)" aria-label="Calling app ID" className="w-56" />
        <Input value={traceId} onChange={event => setTraceId(event.target.value)} placeholder="Trace ID" aria-label="Trace ID filter" className="w-72 font-mono" />
        {traceId && <><Button asChild size="sm" variant="outline"><Link href={`/traces?traceId=${encodeURIComponent(traceId)}`}>Open trace</Link></Button>
          <span className="text-xs text-muted-foreground">Searching all retained logs for this trace.</span></>}
      </div>
      <CoreTraceCoverageNote coverage={state.response?.coreTracing} />

      {state.error && (
        <RequestError>{state.error}</RequestError>
      )}

      {showingPrevious && loadedQuery && (
        <RetainedResults>logs: {loadedResource} · {loadedSeverity} levels · {loadedRange} · {loadedQuery.text ? `search “${loadedQuery.text}”` : "no search"}</RetainedResults>
      )}

      {state.loading && records.length === 0 ? (
        <EmptyState icon={ScrollText} title="Loading logs" loading />
      ) : state.error && records.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Structured logs unavailable"
          description="Could not load records for the selected filters. Refresh to try again."
        />
      ) : records.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={displayedSearch ? "No matching logs" : "No structured logs"}
          description={traceId ? "No retained logs match this trace and the selected filters. Logs may have expired or no log was emitted." : displayedSearch
            ? "Try a different search or adjust the filters."
            : "Records appear for apps that opt into telemetry and export the OpenTelemetry logs signal, with the Telemetry app enabled on the host (Shell platform panel or hosty setup --with hosty.telemetry)."}
        />
      ) : (
        <OtlpLogTable records={records} showSource={showSource} />
      )}
    </div>
  );
}
