import type {
  BackendFleetLogsResponse,
  BackendTraceDetailResponse,
  BackendTracesResponse,
  FleetOtlpLogsResponse,
  FleetTracesResponse,
  TelemetryApp,
  TraceDetailResponse,
} from "@/lib/types";

// Display-name enrichment: the backend's query API is keyed by hosty.app.id; these functions inject the
// human-readable app name (from the Core roster) into the merged logs/traces shapes the pages render.
// This is exactly the mapping Core's former read proxy (TelemetryBackendMapping) performed.

export function buildNameLookup(apps: TelemetryApp[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const app of apps) {
    names.set(app.id, app.displayName);
  }
  return names;
}

function nameOf(names: Map<string, string>, appId: string): string {
  return names.get(appId) ?? appId;
}

export function enrichLogs(response: BackendFleetLogsResponse, names: Map<string, string>): FleetOtlpLogsResponse {
  return {
    ...response,
    records: response.records.map((record) => ({ ...record, appName: nameOf(names, record.appId) })),
  };
}

export function enrichTraces(response: BackendTracesResponse, names: Map<string, string>): FleetTracesResponse {
  return {
    ...response,
    traces: response.traces.map((trace) => ({
      traceId: trace.traceId,
      rootName: trace.rootName,
      rootKind: trace.rootKind,
      rootAppId: trace.rootAppId,
      rootAppName: nameOf(names, trace.rootAppId),
      hasRootSpan: trace.hasRootSpan,
      startUnixMs: trace.startUnixMs,
      durationMs: trace.durationMs,
      spanCount: trace.spanCount,
      errorCount: trace.errorCount,
      apps: trace.appIds.map((appId) => ({ appId, appName: nameOf(names, appId) })),
    })),
  };
}

export function enrichTraceDetail(
  response: BackendTraceDetailResponse,
  names: Map<string, string>,
): TraceDetailResponse {
  return {
    ...response,
    spans: response.spans.map((span) => ({ ...span, appName: nameOf(names, span.appId) })),
  };
}
