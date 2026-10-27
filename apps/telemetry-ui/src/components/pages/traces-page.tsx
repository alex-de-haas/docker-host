"use client";

import Link from "next/link";
import { CoreTraceCoverageNote } from "@/components/observability/core-trace-coverage";
import { appFetch } from "@hosty-sdk/app/browser-auth";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock3,
  Layers,
  RefreshCw,
  Search,
  Timer,
  Waypoints,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { buildServiceAccents, SERVICE_ACCENTS } from "@/components/observability/service-accents";
import type { FleetTraceSummary, FleetTracesResponse, TelemetryApp, TraceDetailResponse, TraceDetailSpan } from "@/lib/types";
import { withCoreSource } from "@/lib/core-source";
import { EmptyState, PageHeader, RequestError, RetainedResults } from "@/components/page-shell";

const ALL = "__all__";

const RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

const TRACE_ROW_PADDING_X_PX = 12;
const TRACE_DEPTH_GUIDE_STEP_PX = 18;
const TRACE_TOGGLE_ICON_CENTER_PX = 7;
const TRACE_DETAIL_ROOT_ICON_OFFSET_PX = 5;
const TRACE_DETAIL_GUIDE_CONTENT_GAP_PX = 16;

type LoadedTracesQuery = { appId: string; range: number; text: string; caller: string };
type ListState = { loading: boolean; error: string | null; response: FleetTracesResponse | null; loadedQuery: LoadedTracesQuery | null };
type DetailState = { loading: boolean; error: string | null; response: TraceDetailResponse | null };

// Cross-resource Traces view, modelled on the .NET Aspire "Traces" page: recent traces merged across
// every resource (GET /api/observability/traces), each opening into a span waterfall
// (GET /api/observability/traces/{traceId}). A distributed trace's spans can come from several apps,
// so both reads are fleet-shaped; the resource filter narrows which apps' spans start a trace.
export function ObservabilityTracesPage({ apps: roster, initialTraceId = null, initialCaller = "" }: { apps: TelemetryApp[]; initialTraceId?: string | null; initialCaller?: string }) {
  // See the logs page: Core is a telemetry source with no roster entry behind it.
  const apps = withCoreSource(roster);
  const [selectedAppId, setSelectedAppId] = useState<string>(ALL);
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [query, setQuery] = useState("");
  const [caller, setCaller] = useState(initialCaller);
  const [list, setList] = useState<ListState>({ loading: true, error: null, response: null, loadedQuery: null });
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(initialTraceId);
  const [detail, setDetail] = useState<DetailState>({ loading: false, error: null, response: null });
  const listRootRef = useRef<HTMLDivElement>(null);
  const returnFocusTraceRef = useRef<string | null>(null);

  // Keep the selection valid as the app set changes. Adjusted during render (not in an effect) per
  // React's derived-state guidance; the guard is self-limiting — once reset to ALL the condition is
  // false on the re-render, so this cannot loop.
  if (selectedAppId !== ALL && !apps.some((app) => app.id === selectedAppId)) {
    setSelectedAppId(ALL);
  }

  // Debounced typing + manual refresh can overlap; a request token ensures only the latest in-flight
  // request updates state, so a slower earlier response can't overwrite newer results or errors.
  const listRequestRef = useRef(0);
  const loadTraces = useCallback(
    async (appId: string, range: number, text: string, caller: string) => {
      const token = ++listRequestRef.current;
      setList((current) => ({ ...current, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ range: String(range), limit: "100" });
        if (caller.trim()) params.set("callerAppId", caller.trim());
        if (appId !== ALL) {
          params.set("apps", appId);
        }
        const trimmed = text.trim();
        if (trimmed) {
          params.set("q", trimmed);
        }
        const response = await appFetch(`/api/observability/traces?${params.toString()}`);
        throwIfAuthRequired(response);
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        const payload = (await response.json()) as FleetTracesResponse;
        if (token !== listRequestRef.current) {
          return;
        }
        setList({ loading: false, error: null, response: payload, loadedQuery: { appId, range, text: trimmed, caller } });
      } catch (error) {
        if (isAuthRequiredError(error) || token !== listRequestRef.current) {
          return;
        }
        // Keep the previously loaded traces on a transient failure (e.g. a 502 mid-typing on the
        // debounced search) rather than blanking the table — show the error alongside stale data (S-M2).
        setList((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Traces are unavailable.",
          response: current.response,
        }));
      }
    },
    [],
  );

  const detailRequestRef = useRef(0);
  const loadTrace = useCallback(
    async (traceId: string) => {
      const token = ++detailRequestRef.current;
      setDetail({ loading: true, error: null, response: null });
      try {
        const response = await appFetch(`/api/observability/traces/${encodeURIComponent(traceId)}`);
        throwIfAuthRequired(response);
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        const payload = (await response.json()) as TraceDetailResponse;
        if (token !== detailRequestRef.current) {
          return;
        }
        setDetail({ loading: false, error: null, response: payload });
      } catch (error) {
        if (isAuthRequiredError(error) || token !== detailRequestRef.current) {
          return;
        }
        setDetail({
          loading: false,
          error: error instanceof Error ? error.message : "The trace is unavailable.",
          response: null,
        });
      }
    },
    [],
  );

  useEffect(() => { if (initialTraceId) void loadTrace(initialTraceId); }, [initialTraceId, loadTrace]);

  // Refetch on any filter change; debounce so typing in the search box does not hammer Core.
  useEffect(() => {
    const handle = setTimeout(() => void loadTraces(selectedAppId, rangeSeconds, query, caller), 300);
    return () => clearTimeout(handle);
  }, [loadTraces, selectedAppId, rangeSeconds, query, caller]);

  useEffect(() => {
    if (selectedTraceId !== null || returnFocusTraceRef.current === null) {
      return;
    }
    const traceId = returnFocusTraceRef.current;
    returnFocusTraceRef.current = null;
    const row = [...(listRootRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-trace-id]") ?? [])]
      .find((candidate) => candidate.dataset.traceId === traceId);
    const fallback = listRootRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (row ?? fallback)?.focus();
  }, [selectedTraceId]);

  const openTrace = (traceId: string) => {
    returnFocusTraceRef.current = traceId;
    setSelectedTraceId(traceId);
    void loadTrace(traceId);
  };

  if (selectedTraceId) {
    return (
      <TraceWaterfall
        traceId={selectedTraceId}
        state={detail}
        onBack={() => { setSelectedTraceId(null); window.history.replaceState(null, "", "/traces"); }}
        onRefresh={() => void loadTrace(selectedTraceId)}
      />
    );
  }

  const traces = list.response?.traces ?? [];
  const loadedQuery = list.loadedQuery;
  const showingPrevious = loadedQuery !== null && (list.loading || list.error !== null
    || loadedQuery.caller !== caller || loadedQuery.appId !== selectedAppId || loadedQuery.range !== rangeSeconds || loadedQuery.text !== query.trim());
  const loadedResource = loadedQuery?.appId === ALL ? "All resources"
    : apps.find(app => app.id === loadedQuery?.appId)?.displayName ?? loadedQuery?.appId;
  const loadedRange = RANGES.find(range => range.seconds === loadedQuery?.range)?.label;
  const displayedSearch = loadedQuery?.text ?? query.trim();
  const selectedLabel =
    selectedAppId === ALL ? "All resources" : apps.find((app) => app.id === selectedAppId)?.displayName ?? "All resources";

  return (
    <div ref={listRootRef} className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Traces"
        description="Distributed traces across every resource (live, last hour). Select a trace to inspect its span waterfall."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadTraces(selectedAppId, rangeSeconds, query, caller)}
            disabled={list.loading}
          >
            <RefreshCw className={cn("h-4 w-4", list.loading && "animate-spin text-info")} />
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

        <Input value={caller} onChange={event => setCaller(event.target.value)} placeholder="Calling app ID (Core)" aria-label="Calling app ID" className="w-56" />

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
            placeholder="Search name or trace id…"
            aria-label="Search name or trace ID"
            className="pl-8"
          />
        </div>
      </div>

      <CoreTraceCoverageNote coverage={list.response?.coreTracing} />

      {list.error && (
        <RequestError>{list.error}</RequestError>
      )}

      {showingPrevious && loadedQuery && (
        <RetainedResults>traces: {loadedResource} · {loadedRange} · {loadedQuery.text ? `search “${loadedQuery.text}”` : "no search"}</RetainedResults>
      )}

      {list.loading && traces.length === 0 ? (
        <EmptyState icon={Waypoints} title="Loading traces" loading />
      ) : list.error && traces.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="Traces unavailable"
          description="Could not load traces for the selected filters. Refresh to try again."
        />
      ) : traces.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title={displayedSearch ? "No matching traces" : "No traces"}
          description={displayedSearch
            ? "Try a different search or adjust the filters."
            : "Traces appear for apps that opt into telemetry and export the OpenTelemetry traces signal, with the Telemetry app enabled on the host (Shell platform panel or hosty setup --with hosty.telemetry)."}
        />
      ) : (
        <TraceListTable traces={traces} onOpen={openTrace} />
      )}
    </div>
  );
}

function TraceListTable({ traces, onOpen }: { traces: FleetTraceSummary[]; onOpen: (traceId: string) => void }) {
  const accents = useMemo(
    () => buildServiceAccents(traces.flatMap((trace) => trace.apps.map((app) => app.appId))),
    [traces],
  );
  return (
    <div className="telemetry-table overflow-x-auto rounded-xl border bg-card">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-muted/30">
          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Resources</th>
            <th className="px-3 py-2 text-right font-medium">Spans</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="w-0 px-3 py-2" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {traces.map((trace) => {
            const hasError = trace.errorCount > 0;
            return (
              <tr
                key={trace.traceId}
                data-trace-id={trace.traceId}
                tabIndex={0}
                aria-label={`Open trace ${trace.rootName || trace.traceId}`}
                className={cn(
                  "group cursor-pointer border-b align-top transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0",
                  hasError && "bg-destructive-soft/40",
                )}
                onClick={() => onOpen(trace.traceId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(trace.traceId);
                  }
                }}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                  {new Date(trace.startUnixMs).toLocaleTimeString()}
                </td>
                <td className="px-3 py-2">
                  <div className="break-words font-mono">
                    {trace.rootName || "—"}
                    {!trace.hasRootSpan && (
                      <span className="ml-1 text-muted-foreground" title="The trace's root span is not in the window.">
                        (partial)
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{trace.traceId}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {trace.apps.map((app) => (
                      <Badge key={app.appId} variant="outline" className="gap-1.5 font-normal">
                        <span aria-hidden className={cn("h-2 w-2 rounded-full", accents.get(app.appId) ?? SERVICE_ACCENTS[0])} />
                        {app.appName || app.appId}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                  {trace.spanCount}
                  {hasError && (
                    <Badge variant="outline" className="ml-1.5 border-transparent bg-destructive-soft text-destructive-foreground">
                      {trace.errorCount} err
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{formatDuration(trace.durationMs)}</td>
                <td className="px-3 py-2 align-middle">
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// One trace's spans as an indented waterfall: rows in tree order (parents before children), each with
// an offset/width bar over the trace's wall-clock envelope. Clicking a row toggles its attributes.
function TraceWaterfall({
  traceId,
  state,
  onBack,
  onRefresh,
}: {
  traceId: string;
  state: DetailState;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);
  const response = state.response;
  const rows = useMemo(() => (response ? buildWaterfallRows(response.spans) : []), [response]);
  const appAccents = useMemo(() => buildServiceAccents(rows.map((row) => row.span.appId)), [rows]);
  const errorCount = useMemo(
    () => rows.reduce((count, row) => count + (row.span.statusCode === "error" ? 1 : 0), 0),
    [rows],
  );
  const services = useMemo(() => {
    const seen = new Map<string, { appId: string; appName: string; accent: string }>();
    for (const row of rows) {
      if (!seen.has(row.span.appId)) {
        seen.set(row.span.appId, {
          appId: row.span.appId,
          appName: row.span.appName || row.span.appId,
          accent: appAccents.get(row.span.appId) ?? SERVICE_ACCENTS[0],
        });
      }
    }
    return [...seen.values()];
  }, [rows, appAccents]);

  return (
    <div className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Trace"
        actions={
          <div className="flex gap-2">
            <Button ref={backButtonRef} variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              All traces
            </Button>
            <Button asChild variant="outline" size="sm"><Link href={`/logs?traceId=${encodeURIComponent(traceId)}`}>Related logs</Link></Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={state.loading}>
              <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin text-info")} />
              Refresh
            </Button>
          </div>
        }
      />

      <CoreTraceCoverageNote coverage={response?.coreTracing} />

      {state.error && (
        <RequestError>{state.error}</RequestError>
      )}

      {state.loading ? (
        <EmptyState icon={Waypoints} title="Loading trace" loading />
      ) : state.error ? (
        <EmptyState
          icon={Waypoints}
          title="Trace unavailable"
          description="Could not load this trace. Refresh to try again."
        />
      ) : !response || response.spans.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="Trace not retained"
          description={response?.unavailableReason ?? "No retained spans. The trace may be sampled out, outside capture, dropped or past retention."}
        />
      ) : (
        <div className="space-y-4">
          <TraceSummaryCard traceId={traceId} response={response} errorCount={errorCount} services={services} />

          <div className="telemetry-table overflow-x-auto rounded-xl border bg-card">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-muted/30">
                <tr className="border-b">
                  <th className="w-[44%] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Span
                  </th>
                  <th className="px-3 py-2">
                    <div className="flex items-center justify-between text-[10px] font-normal tabular-nums text-muted-foreground/70">
                      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                        <span key={fraction}>
                          {fraction === 0
                            ? "0"
                            : formatDuration((response.durationMs > 0 ? response.durationMs : 1) * fraction)}
                        </span>
                      ))}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isError = row.span.statusCode === "error";
                  const expanded = expandedSpanId === row.span.spanId;
                  const accent = isError ? "bg-destructive" : appAccents.get(row.span.appId) ?? SERVICE_ACCENTS[0];
                  const attributes = Object.entries(row.span.attributes ?? {});
                  const toggle = () => setExpandedSpanId(expanded ? null : row.span.spanId);
                  return (
                    <Fragment key={row.span.spanId}>
                      <tr
                        tabIndex={0}
                        aria-expanded={expanded}
                        aria-label={`Toggle attributes of span ${row.span.name || row.span.spanId}`}
                        className={cn(
                          "group cursor-pointer border-b align-middle transition-colors hover:bg-muted/40 focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0",
                          expanded && "bg-accent",
                          isError && !expanded && "bg-destructive-soft/40",
                        )}
                        onClick={toggle}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggle();
                          }
                        }}
                      >
                        <td className="max-w-0 px-3 py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {Array.from({ length: row.depth }, (_, level) => (
                              <span key={level} aria-hidden className="relative h-5 w-3 shrink-0">
                                <span
                                  className="absolute inset-y-0 block border-l border-border/60"
                                  style={{ left: `${TRACE_TOGGLE_ICON_CENTER_PX}px` }}
                                />
                              </span>
                            ))}
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
                                expanded && "rotate-90 text-muted-foreground",
                              )}
                            />
                            <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", accent)} />
                            <span
                              className={cn("truncate font-mono", isError && "text-destructive-foreground")}
                              title={row.span.name || undefined}
                            >
                              {row.span.name || "—"}
                            </span>
                            <Badge variant="outline" className="shrink-0 font-normal">
                              {row.span.appName || row.span.appId}
                            </Badge>
                            {row.span.kind !== "internal" && row.span.kind !== "unspecified" && (
                              <span className="shrink-0 text-[11px] text-muted-foreground">{row.span.kind}</span>
                            )}
                            {isError && (
                              <Badge
                                variant="outline"
                                className="shrink-0 gap-1 border-transparent bg-destructive-soft text-destructive-foreground"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                error
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <WaterfallBar
                            span={row.span}
                            traceStartMs={response.startUnixMs}
                            traceDurationMs={response.durationMs}
                            accent={accent}
                            isError={isError}
                          />
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b">
                          <td colSpan={2} className="pb-0 pr-3 pt-0">
                            <SpanDetails span={row.span} traceStartMs={response.startUnixMs} depth={row.depth} attributes={attributes} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Header panel that lifts the trace's metadata out of the page heading: a strip of stat tiles plus the
// full trace id and the services (apps) the trace fanned across, each with its waterfall accent.
function TraceSummaryCard({
  traceId,
  response,
  errorCount,
  services,
}: {
  traceId: string;
  response: TraceDetailResponse;
  errorCount: number;
  services: { appId: string; appName: string; accent: string }[];
}) {
  return (
    <div className="telemetry-table overflow-x-auto rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Waypoints className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>
          {traceId}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
        <SummaryTile icon={Clock3} label="Started" value={new Date(response.startUnixMs).toLocaleTimeString()} />
        <SummaryTile icon={Timer} label="Duration" value={formatDuration(response.durationMs)} />
        <SummaryTile icon={Layers} label="Spans" value={String(response.spans.length)} />
        <SummaryTile
          icon={AlertTriangle}
          label="Errors"
          value={String(errorCount)}
          tone={errorCount > 0 ? "error" : "muted"}
        />
      </div>
      {services.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2.5">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Services</span>
          {services.map((service) => (
            <Badge key={service.appId} variant="outline" className="gap-1.5 font-normal">
              <span aria-hidden className={cn("h-2 w-2 rounded-full", service.accent)} />
              {service.appName}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  tone = "muted",
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex items-center gap-2.5 bg-card px-3 py-2.5">
      <Icon className={cn("h-4 w-4 shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn("truncate font-mono text-sm", tone === "error" && "text-destructive-foreground")}>
          {value}
        </div>
      </div>
    </div>
  );
}

// Full-width details for an expanded span: identity/timing facts as a grid, then the raw attribute
// bag as an aligned key/value list. Rendered in its own table row so it gets the whole width instead
// of being squeezed into the half-width name column.
function SpanDetails({
  span,
  traceStartMs,
  depth,
  attributes,
}: {
  span: TraceDetailSpan;
  traceStartMs: number;
  depth: number;
  attributes: [string, string][];
}) {
  const isError = span.statusCode === "error";
  const status = span.statusMessage ? `${span.statusCode} · ${span.statusMessage}` : span.statusCode;
  const guideLeftsPx = Array.from(
    { length: depth },
    (_, level) => TRACE_ROW_PADDING_X_PX + TRACE_TOGGLE_ICON_CENTER_PX + level * TRACE_DEPTH_GUIDE_STEP_PX,
  );
  const lastGuideLeftPx = guideLeftsPx.length > 0 ? guideLeftsPx[guideLeftsPx.length - 1] : null;
  const contentPaddingLeftPx =
    lastGuideLeftPx === null
      ? TRACE_ROW_PADDING_X_PX + TRACE_DETAIL_ROOT_ICON_OFFSET_PX
      : lastGuideLeftPx + TRACE_DETAIL_GUIDE_CONTENT_GAP_PX;
  return (
    <div className="relative py-1.5" style={contentPaddingLeftPx ? { paddingLeft: `${contentPaddingLeftPx}px` } : undefined}>
      {guideLeftsPx.map((guideLeftPx) => (
        <span
          key={guideLeftPx}
          aria-hidden
          className="absolute bottom-2 top-2 block border-l border-border/70"
          style={{ left: `${guideLeftPx}px` }}
        />
      ))}
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          <DetailField label="Span ID" value={span.spanId} />
          <DetailField label="Parent" value={span.parentSpanId || "—"} />
          <DetailField label="Producer" value={span.appName || span.appId} mono={false} />
          {span.appId === "hosty.core" && span.attributes["hosty.caller.app.id"] && <DetailField label="Calling app" value={span.attributes["hosty.caller.app.id"]} />}
          <DetailField label="Kind" value={span.kind} mono={false} />
          <DetailField label="Start offset" value={`+${formatDuration(span.startUnixMs - traceStartMs)}`} />
          <DetailField label="Duration" value={formatDuration(span.durationMs)} />
          <DetailField label="Status" value={status} mono={false} tone={isError ? "error" : undefined} />
        </dl>
        {attributes.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Attributes · {attributes.length}
            </div>
            <div className="divide-y divide-border/60">
              {attributes.map(([key, value], index) => (
                <div
                  key={key}
                  className={cn(
                    "grid grid-cols-1 gap-0.5 py-1.5 text-[11px] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-3",
                    index === 0 && "pt-0",
                  )}
                >
                  <span className="min-w-0 break-all font-mono text-muted-foreground">
                    {key}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap break-all font-mono">{value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">No attributes recorded.</div>
        )}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono = true,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "error";
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("break-all text-xs", mono && "font-mono", tone === "error" && "text-destructive-foreground")}>
        {value}
      </dd>
    </div>
  );
}

function WaterfallBar({
  span,
  traceStartMs,
  traceDurationMs,
  accent,
  isError,
}: {
  span: TraceDetailSpan;
  traceStartMs: number;
  traceDurationMs: number;
  accent: string;
  isError: boolean;
}) {
  // Guard the zero-duration trace (single instantaneous span): draw a minimal bar at the origin.
  const total = traceDurationMs > 0 ? traceDurationMs : 1;
  const minWidth = 0.75;
  // Cap the offset so an instantaneous span at the very end of the trace still leaves room for the
  // minimum bar width — otherwise `100 - left` collapses to 0 and the bar/label disappears.
  const left = Math.min(Math.max(((span.startUnixMs - traceStartMs) / total) * 100, 0), 100 - minWidth);
  const width = Math.min(Math.max((span.durationMs / total) * 100, minWidth), 100 - left);
  const end = left + width;
  const label = formatDuration(span.durationMs);
  // Keep the duration readable: sit it just past the bar, unless the bar reaches near the right edge,
  // in which case tuck it inside against the bar's trailing end.
  const labelInside = end > 82;
  return (
    <div className="relative h-5 w-full min-w-32 rounded bg-muted/50">
      {[25, 50, 75].map((position) => (
        <div key={position} aria-hidden className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${position}%` }} />
      ))}
      <div
        className={cn("absolute inset-y-1 rounded-[3px]", accent, isError && "ring-1 ring-destructive/40")}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
      {labelInside ? (
        <span
          className="absolute inset-y-0 flex items-center pr-1.5 text-[10px] font-medium tabular-nums"
          style={{ right: `${100 - end}%` }}
        >
          <span className="bg-card px-1 text-card-foreground">{label}</span>
        </span>
      ) : (
        <span
          className="absolute inset-y-0 flex items-center whitespace-nowrap pl-1.5 text-[10px] tabular-nums text-muted-foreground"
          style={{ left: `${end}%` }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

type WaterfallRow = { span: TraceDetailSpan; depth: number };

// Orders spans parent-before-children with indentation depth. Spans whose parent is not in the
// response (partial traces) are treated as roots. Children under one parent keep start-time order
// (Core already sorts the flat list by start).
function buildWaterfallRows(spans: TraceDetailSpan[]): WaterfallRow[] {
  const present = new Set(spans.map((span) => span.spanId));
  const childrenByParent = new Map<string, TraceDetailSpan[]>();
  const roots: TraceDetailSpan[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId ?? null;
    if (parent && present.has(parent) && parent !== span.spanId) {
      const siblings = childrenByParent.get(parent);
      if (siblings) {
        siblings.push(span);
      } else {
        childrenByParent.set(parent, [span]);
      }
    } else {
      roots.push(span);
    }
  }

  const rows: WaterfallRow[] = [];
  const visited = new Set<string>();
  const visit = (span: TraceDetailSpan, depth: number) => {
    if (visited.has(span.spanId)) {
      return; // A duplicate span id or a parent cycle: render each span once.
    }
    visited.add(span.spanId);
    rows.push({ span, depth });
    for (const child of childrenByParent.get(span.spanId) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  // Malformed parent links can form a cycle with no reachable root; every span must still render
  // (flat, in the response's start order) rather than vanish from the waterfall.
  for (const span of spans) {
    visit(span, 0);
  }
  return rows;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1) {
    return `${Math.round(durationMs * 1000)}µs`;
  }
  if (durationMs < 1000) {
    return `${durationMs.toFixed(durationMs < 10 ? 2 : 1)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}
