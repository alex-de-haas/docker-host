"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, LoaderCircle, RefreshCw, Search, Waypoints } from "lucide-react";
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
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../../core-api";
import type { CoreApp, FleetTraceSummary, FleetTracesResponse, TraceDetailResponse, TraceDetailSpan } from "../../types";
import { EmptyState, PageHeader } from "../../ui";

const ALL = "__all__";

const RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

// Muted per-resource accents for waterfall bars and app chips, assigned by first appearance so the
// same app keeps its color within one trace view. Error spans override with the destructive accent.
const APP_ACCENTS = [
  "bg-sky-500/70",
  "bg-violet-500/70",
  "bg-emerald-500/70",
  "bg-amber-500/70",
  "bg-rose-500/70",
  "bg-cyan-500/70",
];

type ListState = { loading: boolean; error: string | null; response: FleetTracesResponse | null };
type DetailState = { loading: boolean; error: string | null; response: TraceDetailResponse | null };

// Cross-resource Traces view, modelled on the .NET Aspire "Traces" page: recent traces merged across
// every resource (GET /api/observability/traces), each opening into a span waterfall
// (GET /api/observability/traces/{traceId}). A distributed trace's spans can come from several apps,
// so both reads are fleet-shaped; the resource filter narrows which apps' spans start a trace.
export function ObservabilityTracesPage({
  runtimeApps,
  systemApps,
  coreOrigin,
}: {
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  coreOrigin: string;
}) {
  const apps = useMemo(() => [...runtimeApps, ...systemApps], [runtimeApps, systemApps]);
  const [selectedAppId, setSelectedAppId] = useState<string>(ALL);
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ListState>({ loading: false, error: null, response: null });
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ loading: false, error: null, response: null });

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
    async (appId: string, range: number, text: string) => {
      const token = ++listRequestRef.current;
      setList((current) => ({ ...current, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ range: String(range), limit: "100" });
        if (appId !== ALL) {
          params.set("apps", appId);
        }
        const trimmed = text.trim();
        if (trimmed) {
          params.set("q", trimmed);
        }
        const response = await fetch(`${coreOrigin}/api/observability/traces?${params.toString()}`, {
          credentials: "include",
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const payload = (await response.json()) as FleetTracesResponse;
        if (token !== listRequestRef.current) {
          return;
        }
        setList({ loading: false, error: null, response: payload });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || token !== listRequestRef.current) {
          return;
        }
        setList({
          loading: false,
          error: error instanceof Error ? error.message : "Traces are unavailable.",
          response: null,
        });
      }
    },
    [coreOrigin],
  );

  const detailRequestRef = useRef(0);
  const loadTrace = useCallback(
    async (traceId: string) => {
      const token = ++detailRequestRef.current;
      setDetail({ loading: true, error: null, response: null });
      try {
        const response = await fetch(`${coreOrigin}/api/observability/traces/${encodeURIComponent(traceId)}`, {
          credentials: "include",
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const payload = (await response.json()) as TraceDetailResponse;
        if (token !== detailRequestRef.current) {
          return;
        }
        setDetail({ loading: false, error: null, response: payload });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || token !== detailRequestRef.current) {
          return;
        }
        setDetail({
          loading: false,
          error: error instanceof Error ? error.message : "The trace is unavailable.",
          response: null,
        });
      }
    },
    [coreOrigin],
  );

  // Refetch on any filter change; debounce so typing in the search box does not hammer Core.
  useEffect(() => {
    const handle = setTimeout(() => void loadTraces(selectedAppId, rangeSeconds, query), 300);
    return () => clearTimeout(handle);
  }, [loadTraces, selectedAppId, rangeSeconds, query]);

  const openTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    void loadTrace(traceId);
  };

  if (selectedTraceId) {
    return (
      <TraceWaterfall
        traceId={selectedTraceId}
        state={detail}
        onBack={() => setSelectedTraceId(null)}
        onRefresh={() => void loadTrace(selectedTraceId)}
      />
    );
  }

  const traces = list.response?.traces ?? [];
  const selectedLabel =
    selectedAppId === ALL ? "All resources" : apps.find((app) => app.id === selectedAppId)?.displayName ?? "All resources";

  return (
    <div className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Traces"
        description="Distributed traces across every resource (live, last hour). Select a trace to inspect its span waterfall."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadTraces(selectedAppId, rangeSeconds, query)}
            disabled={list.loading}
          >
            <RefreshCw className={cn("h-4 w-4", list.loading && "animate-spin")} />
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
            placeholder="Search name or trace id…"
            className="pl-8"
          />
        </div>
      </div>

      {list.error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {list.error}
        </div>
      )}

      {list.loading && traces.length === 0 ? (
        <EmptyState icon={LoaderCircle} title="Loading traces" iconClassName="animate-spin" />
      ) : traces.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="No traces"
          description="Traces appear for apps that opt into telemetry and export the OpenTelemetry traces signal, with observability enabled on the host (HOSTY_OBSERVABILITY_ENABLED)."
        />
      ) : (
        <TraceListTable traces={traces} onOpen={openTrace} />
      )}
    </div>
  );
}

function TraceListTable({ traces, onOpen }: { traces: FleetTraceSummary[]; onOpen: (traceId: string) => void }) {
  return (
    <div className="max-h-[32rem] min-h-0 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">Time</th>
            <th className="px-2 py-1.5 font-medium">Name</th>
            <th className="px-2 py-1.5 font-medium">Resources</th>
            <th className="px-2 py-1.5 font-medium text-right">Spans</th>
            <th className="px-2 py-1.5 font-medium text-right">Duration</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((trace) => (
            <tr
              key={trace.traceId}
              tabIndex={0}
              aria-label={`Open trace ${trace.rootName || trace.traceId}`}
              className="cursor-pointer border-b align-top last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
              onClick={() => onOpen(trace.traceId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(trace.traceId);
                }
              }}
            >
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                {new Date(trace.startUnixMs).toLocaleTimeString()}
              </td>
              <td className="px-2 py-1.5">
                <div className="break-words font-mono">
                  {trace.rootName || "—"}
                  {!trace.hasRootSpan && (
                    <span className="ml-1 text-muted-foreground" title="The trace's root span is not in the window.">
                      (partial)
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{shortTraceId(trace.traceId)}</div>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap gap-1">
                  {trace.apps.map((app) => (
                    <Badge key={app.appId} variant="outline" className="font-normal">
                      {app.appName || app.appId}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">
                {trace.spanCount}
                {trace.errorCount > 0 && (
                  <Badge variant="outline" className="ml-1.5 border-transparent bg-red-500/10 text-red-700 dark:text-red-300">
                    {trace.errorCount} err
                  </Badge>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">{formatDuration(trace.durationMs)}</td>
            </tr>
          ))}
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
  const response = state.response;
  const rows = useMemo(() => (response ? buildWaterfallRows(response.spans) : []), [response]);
  const appAccents = useMemo(() => {
    const accents = new Map<string, string>();
    for (const row of rows) {
      if (!accents.has(row.span.appId)) {
        accents.set(row.span.appId, APP_ACCENTS[accents.size % APP_ACCENTS.length]);
      }
    }
    return accents;
  }, [rows]);

  return (
    <div className="flex min-h-0 flex-col space-y-6">
      <PageHeader
        title="Trace"
        description={shortTraceId(traceId)}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              All traces
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={state.loading}>
              <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      {state.error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {state.error}
        </div>
      )}

      {state.loading ? (
        <EmptyState icon={LoaderCircle} title="Loading trace" iconClassName="animate-spin" />
      ) : !response || response.spans.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="Trace not found"
          description="The trace has no stored spans — it may have aged out of the live window (last hour)."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Started <span className="font-mono">{new Date(response.startUnixMs).toLocaleTimeString()}</span>
            </span>
            <span>
              Duration <span className="font-mono">{formatDuration(response.durationMs)}</span>
            </span>
            <span>
              {response.spans.length} span{response.spans.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="max-h-[32rem] min-h-0 overflow-auto rounded-md border">
            <table className="w-full border-collapse text-left text-xs">
              <tbody>
                {rows.map((row) => {
                  const isError = row.span.statusCode === "error";
                  const expanded = expandedSpanId === row.span.spanId;
                  const attributes = Object.entries(row.span.attributes ?? {});
                  return (
                    <tr
                      key={row.span.spanId}
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-label={`Toggle attributes of span ${row.span.name || row.span.spanId}`}
                      className="cursor-pointer border-b align-top last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                      onClick={() => setExpandedSpanId(expanded ? null : row.span.spanId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setExpandedSpanId(expanded ? null : row.span.spanId);
                        }
                      }}
                    >
                      <td className="w-1/2 px-2 py-1.5">
                        <div className="flex items-center gap-1.5" style={{ paddingLeft: `${row.depth * 16}px` }}>
                          <span className={cn("break-words font-mono", isError && "text-red-700 dark:text-red-300")}>
                            {row.span.name || "—"}
                          </span>
                          <Badge variant="outline" className="shrink-0 font-normal">
                            {row.span.appName || row.span.appId}
                          </Badge>
                          {row.span.kind !== "internal" && row.span.kind !== "unspecified" && (
                            <span className="shrink-0 text-[11px] text-muted-foreground">{row.span.kind}</span>
                          )}
                          {isError && (
                            <Badge variant="outline" className="shrink-0 border-transparent bg-red-500/10 text-red-700 dark:text-red-300">
                              error
                            </Badge>
                          )}
                        </div>
                        {expanded && (
                          <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground" style={{ paddingLeft: `${row.depth * 16}px` }}>
                            <div className="font-mono">span={row.span.spanId}</div>
                            {row.span.statusMessage && <div className="font-mono">status={row.span.statusMessage}</div>}
                            {attributes.map(([key, value]) => (
                              <div key={key} className="break-all font-mono">
                                {key}={value}
                              </div>
                            ))}
                            {attributes.length === 0 && !row.span.statusMessage && <div>No attributes.</div>}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <WaterfallBar
                          span={row.span}
                          traceStartMs={response.startUnixMs}
                          traceDurationMs={response.durationMs}
                          accent={isError ? "bg-red-500/70" : appAccents.get(row.span.appId) ?? APP_ACCENTS[0]}
                        />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-muted-foreground">
                        {formatDuration(row.span.durationMs)}
                      </td>
                    </tr>
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

function WaterfallBar({
  span,
  traceStartMs,
  traceDurationMs,
  accent,
}: {
  span: TraceDetailSpan;
  traceStartMs: number;
  traceDurationMs: number;
  accent: string;
}) {
  // Guard the zero-duration trace (single instantaneous span): draw a minimal bar at the origin.
  const total = traceDurationMs > 0 ? traceDurationMs : 1;
  const left = Math.min(Math.max(((span.startUnixMs - traceStartMs) / total) * 100, 0), 100);
  const width = Math.min(Math.max((span.durationMs / total) * 100, 0.5), 100 - left);
  return (
    <div className="relative h-4 min-w-24 rounded-sm bg-muted/60">
      <div className={cn("absolute inset-y-0.5 rounded-sm", accent)} style={{ left: `${left}%`, width: `${width}%` }} />
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

function shortTraceId(traceId: string) {
  return traceId.length > 16 ? `${traceId.slice(0, 16)}…` : traceId;
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
