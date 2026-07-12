import { describe, expect, it } from "vitest";
import { buildNameLookup, enrichLogs, enrichTraceDetail, enrichTraces } from "./enrich";
import type { BackendFleetLogsResponse, BackendTraceDetailResponse, BackendTracesResponse } from "./types";

const names = buildNameLookup([
  { id: "media-server", displayName: "Media Server" },
  { id: "hosty.telemetry", displayName: "Hosty Telemetry" },
]);

describe("buildNameLookup", () => {
  it("maps id to displayName", () => {
    expect(names.get("media-server")).toBe("Media Server");
    expect(names.get("hosty.telemetry")).toBe("Hosty Telemetry");
  });
});

describe("enrichLogs", () => {
  it("injects appName, falling back to the id for unknown apps", () => {
    const backend: BackendFleetLogsResponse = {
      rangeSeconds: 900,
      appCount: 2,
      records: [
        { appId: "media-server", timestampUnixMs: 1, severityNumber: 9, severityText: "INFO", body: "a", attributes: {} },
        { appId: "ghost", timestampUnixMs: 2, severityNumber: 17, severityText: "ERROR", body: "b", attributes: {} },
      ],
    };
    const result = enrichLogs(backend, names);
    expect(result.rangeSeconds).toBe(900);
    expect(result.records[0].appName).toBe("Media Server");
    expect(result.records[1].appName).toBe("ghost"); // unknown id passes through unchanged
  });
});

describe("enrichTraces", () => {
  it("sets rootAppName and expands appIds into {appId, appName}", () => {
    const backend: BackendTracesResponse = {
      rangeSeconds: 900,
      appCount: 1,
      traces: [
        {
          traceId: "t1",
          rootName: "GET /",
          rootKind: "server",
          rootAppId: "media-server",
          hasRootSpan: true,
          startUnixMs: 1,
          durationMs: 5,
          spanCount: 3,
          errorCount: 0,
          appIds: ["media-server", "ghost"],
        },
      ],
    };
    const result = enrichTraces(backend, names);
    expect(result.traces[0].rootAppName).toBe("Media Server");
    expect(result.traces[0].apps).toEqual([
      { appId: "media-server", appName: "Media Server" },
      { appId: "ghost", appName: "ghost" },
    ]);
  });
});

describe("enrichTraceDetail", () => {
  it("injects appName on each span", () => {
    const backend: BackendTraceDetailResponse = {
      traceId: "t1",
      startUnixMs: 1,
      durationMs: 5,
      spans: [
        {
          appId: "media-server",
          spanId: "s1",
          parentSpanId: null,
          name: "op",
          kind: "server",
          startUnixMs: 1,
          durationMs: 2,
          statusCode: "ok",
          statusMessage: null,
          attributes: {},
        },
      ],
    };
    const result = enrichTraceDetail(backend, names);
    expect(result.spans[0].appName).toBe("Media Server");
  });
});
