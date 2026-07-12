// Wire shapes for the telemetry UI. The backend query API serializes camelCase (ASP.NET Core Web
// defaults) and keys everything by hosty.app.id; the UI server routes add the display name (appName)
// from the Core roster — the same enrichment Core's former read proxy did. These mirror the shapes the
// observability pages consume. See docs/features/observability-phase-2-backend.md.

export type ApiError = { code?: string; message?: string };

// An app in the fleet roster (id → display name), fetched from Core with the app service token. Pages
// use `id` for filtering/keys and `displayName` for labels.
export type TelemetryApp = { id: string; displayName: string };

// ── Metrics ──────────────────────────────────────────────────────────────────────────────────────
export type MetricPoint = { timestampUnixMs: number; value: number };
export type MetricSeries = { name: string; labels: Record<string, string>; points: MetricPoint[] };
export type AppMetricsResponse = { appId: string; rangeSeconds: number; series: MetricSeries[] };

// ── Structured OTLP logs ───────────────────────────────────────────────────────────────────────────
export type OtlpLogRecord = {
  timestampUnixMs: number;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, string>;
  traceId?: string | null;
  spanId?: string | null;
};
export type FleetOtlpLogRecord = OtlpLogRecord & { appId: string; appName: string };
export type FleetOtlpLogsResponse = { rangeSeconds: number; appCount: number; records: FleetOtlpLogRecord[] };

// ── Traces ──────────────────────────────────────────────────────────────────────────────────────
export type TraceAppRef = { appId: string; appName: string };
export type FleetTraceSummary = {
  traceId: string;
  rootName: string;
  rootKind: string;
  rootAppId: string;
  rootAppName: string;
  hasRootSpan: boolean;
  startUnixMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  apps: TraceAppRef[];
};
export type FleetTracesResponse = { rangeSeconds: number; appCount: number; traces: FleetTraceSummary[] };
export type TraceDetailSpan = {
  appId: string;
  appName: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind: string;
  startUnixMs: number;
  durationMs: number;
  statusCode: string;
  statusMessage?: string | null;
  attributes: Record<string, string>;
};
export type TraceDetailResponse = {
  traceId: string;
  startUnixMs: number;
  durationMs: number;
  spans: TraceDetailSpan[];
};

// ── Backend (pre-enrichment) shapes ────────────────────────────────────────────────────────────────
// The backend keys by appId only; the UI server routes map these into the *appName-enriched shapes
// above. Kept in sync with apps/telemetry-backend/.../Query/QueryResponses.cs.
export type BackendFleetLogRecord = OtlpLogRecord & { appId: string };
export type BackendFleetLogsResponse = { rangeSeconds: number; appCount: number; records: BackendFleetLogRecord[] };
export type BackendTraceSummary = {
  traceId: string;
  rootName: string;
  rootKind: string;
  rootAppId: string;
  hasRootSpan: boolean;
  startUnixMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  appIds: string[];
};
export type BackendTracesResponse = { rangeSeconds: number; appCount: number; traces: BackendTraceSummary[] };
export type BackendTraceDetailSpan = Omit<TraceDetailSpan, "appName">;
export type BackendTraceDetailResponse = {
  traceId: string;
  startUnixMs: number;
  durationMs: number;
  spans: BackendTraceDetailSpan[];
};
