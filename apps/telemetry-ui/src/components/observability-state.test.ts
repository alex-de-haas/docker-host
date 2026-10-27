// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, useApps } from "@/components/app-shell";
import { ObservabilityMetricsPage } from "@/components/pages/metrics-page";
import { ObservabilityStructuredLogsPage } from "@/components/pages/structured-logs-page";
import { ObservabilityTracesPage } from "@/components/pages/traces-page";
import type { AppMetricsResponse, FleetOtlpLogsResponse, FleetTracesResponse, MetricSeries } from "@/lib/types";

const { appFetch } = vi.hoisted(() => ({ appFetch: vi.fn() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch }));
vi.mock("@hosty-sdk/app/react", () => ({ HostyNavigationBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("next/navigation", () => ({ usePathname: () => "/metrics" }));
vi.mock("@/components/observability/metric-series-card", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/observability/metric-series-card")>(),
  // Keep real metric selection/grouping; chart layout belongs to browser verification.
  MetricSeriesCard: ({ series }: { series: MetricSeries }) => createElement("output", { "aria-label": series.name }, String(series.points.at(-1)?.value)),
}));

const apps = [{ id: "example.worker", displayName: "Worker" }];
const emptyLogs: FleetOtlpLogsResponse = { rangeSeconds: 900, appCount: 1, records: [] };
const logs: FleetOtlpLogsResponse = {
  ...emptyLogs,
  records: [{ appId: apps[0].id, appName: "Worker", timestampUnixMs: 1000, severityNumber: 9, severityText: "INFO", body: "Worker is ready", attributes: {} }],
};
const emptyTraces: FleetTracesResponse = { rangeSeconds: 900, appCount: 1, traces: [] };
const traces: FleetTracesResponse = {
  ...emptyTraces,
  traces: [{ traceId: "trace-123", rootName: "Worker request", rootKind: "server", rootAppId: apps[0].id, rootAppName: "Worker", hasRootSpan: true, startUnixMs: 1000, durationMs: 10, spanCount: 1, errorCount: 0, apps: [{ appId: apps[0].id, appName: "Worker" }] }],
};
const emptyMetrics: AppMetricsResponse = { appId: apps[0].id, rangeSeconds: 900, series: [] };
const metrics: AppMetricsResponse = {
  ...emptyMetrics,
  series: [
    { name: "process.cpu.percent", labels: {}, points: [{ timestampUnixMs: 1000, value: 12 }] },
    { name: "worker.completed", labels: {}, points: [{ timestampUnixMs: 1000, value: 5 }] },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appFetch.mockReset();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) { await act(async () => root.render(node)); }
async function advanceDebounce() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(found, `Button ${label}`).toBeDefined();
  return found!;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
function requestFailure() {
  const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
  expect(alert).not.toBeNull();
  expect(alert.className).toContain("bg-destructive-soft");
  expect(alert.className).not.toContain("bg-warning-soft");
  expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  return alert;
}
function retainedResults() {
  return [...container.querySelectorAll('[role="status"]')].find(element => element.textContent?.startsWith("Showing previously loaded"));
}
async function selectResource(name: string) {
  await act(async () => {
    const trigger = button("All resources");
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(element => element.textContent?.trim() === name);
  expect(option).toBeDefined();
  await click(option!);
}

async function search(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function ResourceProbe() {
  const roster = useApps();
  return createElement("p", null, roster.length ? roster.map((app) => app.displayName).join(", ") : "No resources");
}

describe("Telemetry resource roster", () => {
  it("keeps child empty states hidden until a successful roster response and retries a failure", async () => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    appFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await render(createElement(AppShell, null, createElement(ResourceProbe)));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading Telemetry");
    expect(container.textContent).not.toContain("No resources");
    await act(async () => first.resolve(json({ message: "Unavailable" }, 503)));
    expect(requestFailure().textContent).toContain("Resources could not be loaded");
    expect(container.textContent).not.toContain("No resources");
    await click(button("Try again"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading Telemetry");
    expect(container.textContent).not.toContain("No resources");
    await act(async () => retry.resolve(json({ apps: [] })));
    expect(container.textContent).toContain("No resources");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(appFetch.mock.calls.map(([url]) => url)).toEqual(["/api/apps", "/api/apps"]);
  });
});

const listCases = [
  { name: "logs", component: ObservabilityStructuredLogsPage, loading: "Loading logs", unavailable: "Structured logs unavailable", empty: "No structured logs", noMatches: "No matching logs", emptyPayload: emptyLogs, populated: logs, cachedText: "Worker is ready", searchLabel: "Search log body", endpoint: "/api/observability/logs" },
  { name: "traces", component: ObservabilityTracesPage, loading: "Loading traces", unavailable: "Traces unavailable", empty: "No traces", noMatches: "No matching traces", emptyPayload: emptyTraces, populated: traces, cachedText: "Worker request", searchLabel: "Search name or trace ID", endpoint: "/api/observability/traces" },
];

describe.each(listCases)("Telemetry $name list", (fixture) => {
  it("shows loading through the initial debounce and separates failed reads from confirmed empty data", async () => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    appFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await render(createElement(fixture.component, { apps }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(fixture.loading);
    expect(container.textContent).not.toContain(fixture.empty);
    expect(button("Refresh").disabled).toBe(true);
    expect(appFetch).not.toHaveBeenCalled();
    await advanceDebounce();
    await act(async () => first.resolve(json({ message: "Collector is unreachable" }, 502)));
    expect(requestFailure().textContent).toBe("Collector is unreachable");
    expect(container.textContent).toContain(fixture.unavailable);
    expect(container.textContent).not.toContain(fixture.empty);
    await click(button("Refresh"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(fixture.loading);
    expect(container.textContent).not.toContain(fixture.unavailable);
    await click(button("Refresh"));
    expect(appFetch).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve(json(fixture.emptyPayload)));
    expect(container.textContent).toContain(fixture.empty);
    expect(container.textContent).not.toContain(fixture.unavailable);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains cached rows and selected filters during a failed refresh, then retries the same query", async () => {
    const failed = deferred<Response>();
    appFetch.mockResolvedValueOnce(json(fixture.populated)).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(json(fixture.emptyPayload));
    await render(createElement(fixture.component, { apps }));
    await advanceDebounce();
    expect(container.textContent).toContain(fixture.cachedText);
    await click(button("1h"));
    await search(fixture.searchLabel, "  worker  ");
    await advanceDebounce();
    expect(container.textContent).toContain(fixture.cachedText);
    await act(async () => failed.reject(new Error("Network lost")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Network lost");
    expect(container.textContent).toContain(fixture.cachedText);
    expect(container.textContent).not.toContain(fixture.unavailable);
    expect(button("1h").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${fixture.searchLabel}"]`)?.value).toBe("  worker  ");
    const failedUrl = String(appFetch.mock.calls[1][0]);
    expect(failedUrl).toContain(fixture.endpoint + "?");
    expect(new URL(failedUrl, "https://telemetry.test").searchParams.get("range")).toBe("3600");
    expect(new URL(failedUrl, "https://telemetry.test").searchParams.get("q")).toBe("worker");
    await click(button("Refresh"));
    expect(appFetch.mock.calls[2][0]).toBe(failedUrl);
    expect(container.textContent).not.toContain(fixture.cachedText);
    expect(container.textContent).toContain(fixture.noMatches);
  });

  it("identifies the loaded query while a new search is pending or fails and retires the notice on success", async () => {
    const failed = deferred<Response>();
    appFetch.mockResolvedValueOnce(json(fixture.populated)).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(json(fixture.emptyPayload));
    await render(createElement(fixture.component, { apps }));
    await advanceDebounce();
    expect(retainedResults()).toBeUndefined();
    await search(fixture.searchLabel, "  another query  ");
    expect(retainedResults()?.textContent).toContain("All resources");
    expect(retainedResults()?.textContent).toContain("15m");
    expect(retainedResults()?.textContent).toContain("no search");
    expect(retainedResults()?.textContent).not.toContain("another query");
    await advanceDebounce();
    expect(retainedResults()?.textContent).toContain("no search");
    await act(async () => failed.reject(new Error("Search unavailable")));
    expect(retainedResults()?.textContent).toContain("no search");
    expect(container.textContent).toContain(fixture.cachedText);
    expect(button("Refresh").disabled).toBe(false);
    await click(button("Refresh"));
    expect(retainedResults()).toBeUndefined();
    expect(container.textContent).toContain(fixture.noMatches);
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${fixture.searchLabel}"]`)?.value).toBe("  another query  ");
  });

  it("distinguishes an empty search result from an unfiltered empty source without masking errors", async () => {
    appFetch.mockImplementation(async () => json(fixture.emptyPayload));
    await render(createElement(fixture.component, { apps }));
    await advanceDebounce();
    expect(container.textContent).toContain(fixture.empty);
    await search(fixture.searchLabel, "  missing-entry  ");
    await advanceDebounce();
    expect(container.textContent).toContain(fixture.noMatches);
    expect(container.textContent).toContain("Try a different search or adjust the filters.");
    expect(container.textContent).not.toContain("opt into telemetry");
    expect(new URL(String(appFetch.mock.calls[1][0]), "https://telemetry.test").searchParams.get("q")).toBe("missing-entry");
    appFetch.mockResolvedValueOnce(json({ message: "Collector unavailable" }, 503));
    await click(button("Refresh"));
    expect(container.textContent).toContain(fixture.unavailable);
    expect(container.textContent).not.toContain(fixture.noMatches);
    await click(button("Refresh"));
    expect(container.textContent).toContain(fixture.noMatches);
    await search(fixture.searchLabel, "   ");
    await advanceDebounce();
    expect(container.textContent).toContain(fixture.empty);
    expect(container.textContent).not.toContain(fixture.noMatches);
    expect(new URL(String(appFetch.mock.calls.at(-1)![0]), "https://telemetry.test").searchParams.has("q")).toBe(false);
  });

  it("keeps authentication recovery separate from a successful empty observation", async () => {
    appFetch.mockResolvedValue(json({ message: "Login required" }, 401));
    await render(createElement(fixture.component, { apps }));
    await advanceDebounce();
    expect(container.textContent).not.toContain(fixture.empty);
    expect(container.textContent).not.toContain(fixture.unavailable);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

it("keeps WARN log evidence amber while request failures use their distinct failure notice", async () => {
  appFetch.mockResolvedValueOnce(json({ ...logs, records: [{ ...logs.records[0], severityNumber: 13, severityText: "WARN" }] }));
  await render(createElement(ObservabilityStructuredLogsPage, { apps }));
  await advanceDebounce();
  const warning = [...container.querySelectorAll('tbody [data-slot="badge"]')].find(element => element.textContent === "WARN");
  expect(warning?.className).toContain("bg-warning-soft");
  expect(warning?.className).not.toContain("bg-destructive-soft");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the actual source of retained logs visible after selecting a different resource", async () => {
  const failed = deferred<Response>();
  const roster = [...apps, { id: "example.api", displayName: "API" }];
  const allLogs = { ...logs, records: [{ ...logs.records[0], appId: "example.api", appName: "API" }] };
  appFetch.mockResolvedValueOnce(json(allLogs)).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(json(emptyLogs));
  await render(createElement(ObservabilityStructuredLogsPage, { apps: roster }));
  await advanceDebounce();
  expect(container.querySelector('th')?.parentElement?.textContent).toContain("Source");
  await selectResource("Worker");
  expect(retainedResults()?.textContent).toContain("All resources");
  expect(container.querySelector('thead')?.textContent).toContain("Source");
  expect(container.querySelector('tbody')?.textContent).toContain("API");
  await advanceDebounce();
  await act(async () => failed.reject(new Error("Worker unavailable")));
  expect(container.querySelector('thead')?.textContent).toContain("Source");
  expect(container.querySelector('tbody')?.textContent).toContain("API");
  expect(retainedResults()?.textContent).toContain("All resources");
  expect(String(appFetch.mock.calls[1][0])).toContain("apps=example.worker");
  await click(button("Refresh"));
  expect(retainedResults()).toBeUndefined();
  expect(container.querySelector('tbody')).toBeNull();
  expect(container.textContent).toContain("No structured logs");
});

it("distinguishes an unavailable trace from a successful detail read with no stored spans", async () => {
  const detail = deferred<Response>();
  appFetch.mockResolvedValueOnce(json(traces)).mockReturnValueOnce(detail.promise).mockResolvedValueOnce(json({ traceId: "trace-123", startUnixMs: 1000, durationMs: 0, spans: [] }));
  await render(createElement(ObservabilityTracesPage, { apps }));
  await advanceDebounce();
  await click(container.querySelector<HTMLElement>('[aria-label="Open trace Worker request"]')!);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading trace");
  await act(async () => detail.resolve(json({ message: "Trace query failed" }, 503)));
  expect(requestFailure().textContent).toBe("Trace query failed");
  expect(container.textContent).toContain("Trace unavailable");
  expect(container.textContent).not.toContain("Trace not retained");
  await click(button("Refresh"));
  expect(container.textContent).toContain("Trace not retained");
  expect(container.textContent).not.toContain("Trace unavailable");
  expect(appFetch.mock.calls[1][0]).toBe("/api/observability/traces/trace-123");
  expect(appFetch.mock.calls[2][0]).toBe(appFetch.mock.calls[1][0]);
  await click(button("All traces"));
  expect(container.textContent).toContain("Worker request");
  expect(appFetch).toHaveBeenCalledTimes(3);
});

it("moves keyboard focus into trace details and restores the originating row without stealing focus on refresh", async () => {
  const detail = deferred<Response>();
  const refresh = deferred<Response>();
  const emptyDetail = { traceId: "trace-123", startUnixMs: 1000, durationMs: 0, spans: [] };
  appFetch.mockResolvedValueOnce(json(traces)).mockReturnValueOnce(detail.promise).mockReturnValueOnce(refresh.promise);
  await render(createElement("div", null,
    createElement(ObservabilityTracesPage, { apps }),
    createElement("button", null, "Other control"),
  ));
  await advanceDebounce();
  const origin = container.querySelector<HTMLElement>('[aria-label="Open trace Worker request"]')!;
  await act(async () => {
    origin.focus();
    origin.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(document.activeElement).toBe(button("All traces"));
  await act(async () => detail.resolve(json(emptyDetail)));
  expect(document.activeElement).toBe(button("All traces"));
  await act(async () => button("Other control").focus());
  await click(button("Refresh"));
  expect(document.activeElement).toBe(button("Other control"));
  await act(async () => refresh.resolve(json(emptyDetail)));
  expect(document.activeElement).toBe(button("Other control"));
  await click(button("All traces"));
  const restored = container.querySelector<HTMLElement>('[aria-label="Open trace Worker request"]')!;
  expect(document.activeElement).toBe(restored);
  expect(appFetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/observability/traces?range=900&limit=100",
    "/api/observability/traces/trace-123",
    "/api/observability/traces/trace-123",
  ]);
});

it("returns focus to the list refresh control if a background result removes the opened trace", async () => {
  const listRefresh = deferred<Response>();
  appFetch.mockResolvedValueOnce(json(traces)).mockReturnValueOnce(listRefresh.promise)
    .mockResolvedValueOnce(json({ traceId: "trace-123", startUnixMs: 1000, durationMs: 0, spans: [] }));
  await render(createElement(ObservabilityTracesPage, { apps }));
  await advanceDebounce();
  await click(button("Refresh"));
  const origin = container.querySelector<HTMLElement>('[aria-label="Open trace Worker request"]')!;
  await act(async () => {
    origin.focus();
    origin.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(document.activeElement).toBe(button("All traces"));
  await act(async () => listRefresh.resolve(json(emptyTraces)));
  expect(document.activeElement).toBe(button("All traces"));
  await click(button("All traces"));
  expect(container.textContent).toContain("No traces");
  expect(container.querySelector('[aria-label="Open trace Worker request"]')).toBeNull();
  expect(document.activeElement).toBe(button("Refresh"));
  expect(appFetch).toHaveBeenCalledTimes(3);
});

describe("Telemetry metrics", () => {
  it("shows loading until all resources settle and treats partial failure as unavailable rather than empty", async () => {
    const failed = deferred<Response>();
    const retry = deferred<Response>();
    const roster = [...apps, { id: "example.other", displayName: "Other" }];
    appFetch.mockResolvedValueOnce(json(emptyMetrics)).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(json(emptyMetrics)).mockReturnValueOnce(retry.promise);
    await render(createElement(ObservabilityMetricsPage, { apps: roster }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading metrics");
    expect(container.textContent).not.toContain("No metrics");
    await act(async () => failed.resolve(json({ message: "Metrics query failed" }, 502)));
    expect(requestFailure().textContent).toBe("Other: Metrics query failed");
    expect(container.textContent).toContain("Metrics unavailable");
    expect(container.textContent).not.toContain("No metrics");
    await click(button("Refresh"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading metrics");
    await act(async () => retry.resolve(json({ ...emptyMetrics, appId: "example.other" })));
    expect(container.textContent).toContain("No metrics");
    expect(container.textContent).not.toContain("Metrics unavailable");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a nonmatching instrument filter without hiding infrastructure or changing selected charts", async () => {
    appFetch.mockResolvedValueOnce(json(metrics));
    await render(createElement(ObservabilityMetricsPage, { apps }));
    const selected = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find((item) => item.textContent?.trim() === "worker.completed")!;
    await click(selected);
    await search("Filter metrics", "  missing.instrument  ");
    expect(container.querySelector('aside [role="status"]')?.textContent).toBe("No matching metrics");
    expect(container.querySelector("aside")?.textContent).toContain("process.cpu.percent");
    expect(container.querySelector('output[aria-label="process.cpu.percent"]')?.textContent).toBe("12");
    expect(container.querySelector('output[aria-label="worker.completed"]')?.textContent).toBe("5");
    expect(localStorage.getItem("hosty.telemetry.metrics.selected")).toBe('["worker.completed"]');
    await search("Filter metrics", "  ");
    expect(container.querySelector('aside [role="status"]')).toBeNull();
    const restored = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find((item) => item.textContent?.trim() === "worker.completed")!;
    expect(restored.getAttribute("aria-checked")).toBe("true");
    expect(appFetch).toHaveBeenCalledExactlyOnceWith("/api/apps/example.worker/metrics?range=900");
  });

  it.each([
    { catalog: "empty", payload: emptyMetrics },
    { catalog: "infrastructure-only", payload: { ...metrics, series: metrics.series.slice(0, 1) } },
  ])("does not claim a search miss for a $catalog selectable catalog", async ({ payload }) => {
    appFetch.mockResolvedValueOnce(json(payload));
    await render(createElement(ObservabilityMetricsPage, { apps }));
    if (container.querySelector('input[aria-label="Filter metrics"]')) {
      await search("Filter metrics", "missing.instrument");
    }
    expect(container.textContent).not.toContain("No matching metrics");
    if (payload.series.length) {
      expect(container.querySelector("aside")?.textContent).toContain("process.cpu.percent");
      expect(container.querySelector('output[aria-label="process.cpu.percent"]')?.textContent).toBe("12");
    } else {
      expect(container.textContent).toContain("No metrics");
    }
    expect(appFetch).toHaveBeenCalledExactlyOnceWith("/api/apps/example.worker/metrics?range=900");
  });

  it("preserves cached charts and metric selection after a range refresh fails", async () => {
    const failed = deferred<Response>();
    appFetch.mockResolvedValueOnce(json(metrics)).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(json({ ...metrics, rangeSeconds: 3600 }));
    await render(createElement(ObservabilityMetricsPage, { apps }));
    const selected = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find((item) => item.textContent?.trim() === "worker.completed")!;
    expect(selected).toBeDefined();
    await click(selected);
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('output[aria-label="worker.completed"]')?.textContent).toBe("5");
    await click(button("1h"));
    expect(retainedResults()?.textContent).toContain("Worker");
    expect(retainedResults()?.textContent).toContain("15m");
    expect(retainedResults()?.textContent).not.toContain("1h");
    expect(container.querySelector('output[aria-label="process.cpu.percent"]')?.textContent).toBe("12");
    await act(async () => failed.reject(new Error("Metric transport failed")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Worker: Metric transport failed");
    expect(container.querySelector('output[aria-label="worker.completed"]')?.textContent).toBe("5");
    expect(container.textContent).not.toContain("Metrics unavailable");
    expect(retainedResults()?.textContent).toContain("15m");
    expect(localStorage.getItem("hosty.telemetry.metrics.selected")).toBe('["worker.completed"]');
    await click(button("Refresh"));
    expect(appFetch.mock.calls[1][0]).toBe("/api/apps/example.worker/metrics?range=3600");
    expect(appFetch.mock.calls[2][0]).toBe(appFetch.mock.calls[1][0]);
    expect(retainedResults()).toBeUndefined();
    expect(container.querySelector('output[aria-label="worker.completed"]')?.textContent).toBe("5");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Core caller filters and correlation navigation", () => {
  it("filters by the calling app independently of the resource and preserves capture coverage", async () => {
    const coverage = { contractVersion: 1, runId: "run", capturing: true, rootSampleRatio: .1,
      observedAt: "2026-10-27T10:00:00Z", captureStartedAt: "2026-10-27T09:59:00Z", firstAvailableSequence: 2,
      lastSequence: 4, droppedSpans: 1, truncatedSpans: 0, state: "receiving", lastGapReason: "cursor_expired", gapCount: 1 };
    appFetch.mockImplementation(async () => json({ ...emptyTraces, coreTracing: coverage }));
    await render(createElement(ObservabilityTracesPage, { apps }));
    await advanceDebounce();
    await search("Calling app ID", "example.caller");
    await advanceDebounce();
    expect(String(appFetch.mock.calls.at(-1)?.[0])).toContain("callerAppId=example.caller");
    expect(container.textContent).toContain("10%");
    expect(container.textContent).toContain("cursor expired");
  });

  it("opens a trace deep link and offers the matching log query", async () => {
    appFetch.mockImplementation(async (url: string) => json(url.endsWith("/trace-123")
      ? { traceId: "trace-123", startUnixMs: 1000, durationMs: 10, spans: [], unavailableReason: "The trace was sampled out or expired." }
      : emptyTraces));
    await render(createElement(ObservabilityTracesPage, { apps, initialTraceId: "trace-123" }));
    expect(appFetch).toHaveBeenCalledWith("/api/observability/traces/trace-123");
    expect(container.textContent).toContain("Trace not retained");
    expect(container.textContent).toContain("sampled out or expired");
    expect(container.querySelector('a[href="/logs?traceId=trace-123"]')).not.toBeNull();
  });

  it("queries all retained logs for the linked trace and provides a return link", async () => {
    appFetch.mockResolvedValue(json({ ...emptyLogs, rangeSeconds: 0 }));
    await render(createElement(ObservabilityStructuredLogsPage, { apps, initialTraceId: "trace-123", initialCaller: "example.caller" }));
    await advanceDebounce();
    const query = new URL(String(appFetch.mock.calls[0][0]), "http://test").searchParams;
    expect(query.get("traceId")).toBe("trace-123");
    expect(query.get("callerAppId")).toBe("example.caller");
    expect(container.querySelector('a[href="/traces?traceId=trace-123"]')).not.toBeNull();
    expect(container.textContent).toContain("No retained logs match this trace");
  });
});
