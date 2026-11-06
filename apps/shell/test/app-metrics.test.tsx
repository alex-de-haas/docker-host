import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMetricsPanel } from "../src/app/shell/resources/resource-usage";
import type { ResourceSnapshot } from "../src/app/shell/resources/resource-data";
import type { ResourceView } from "../src/app/shell/resources/resource-stream";
import type { CoreApp } from "../src/app/shell/types";

const mocks = vi.hoisted(() => ({ watch: vi.fn(), stop: vi.fn() }));
vi.mock("../src/app/shell/resources/resource-stream", () => ({ watchResources: mocks.watch }));
vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => <div aria-label={props["aria-label"]}>{children}</div>,
  ChartTooltip: () => null, ChartTooltipContent: () => null,
}));
vi.mock("recharts", () => ({
  LineChart: ({ data }: { data: unknown }) => <span data-points={JSON.stringify(data)} />,
  CartesianGrid: () => null, Line: () => null, XAxis: () => null, YAxis: () => null,
}));
let root: Root, container: HTMLDivElement, publish: (view: ResourceView) => void;
const app: CoreApp = { id: "example.app", displayName: "Example", version: "1", kind: "runtime", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: [],
  endpoints: [{ key: "web", service: "web", protocol: "http", public: true }] };
const timestamp = "2026-10-28T12:00:00Z";
const snapshot: ResourceSnapshot = { runId: "run", now: timestamp, logicalProcessors: 8, history: [{ timestamp, services: [
  { appId: app.id, service: "web", runtime: "docker", timestamp, cpuPercent: 25, memoryBytes: 104857600 },
  { appId: app.id, service: "worker", runtime: "docker", timestamp, cpuPercent: 150, memoryBytes: 209715200 },
  { appId: "another.app", service: "private", runtime: "docker", timestamp, cpuPercent: 99, memoryBytes: 1 },
] }] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.watch.mockReset().mockImplementation((_origin, listener) => { publish = listener; return mocks.stop; });
  mocks.stop.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (current = app) => act(async () => root.render(<AppMetricsPanel app={current} coreOrigin="https://core.test" />));

const selectService = (service: string) => act(async () => {
  [...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === service)!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
});

it("switches between service tabs with only the selected CPU and RAM histories mounted", async () => {
  await render(); await act(async () => publish({ snapshot, fresh: true }));
  expect(container.querySelector('[aria-label="Core API activity"]')).not.toBeNull();
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["web", "worker"]);
  for (const [service, cpu, memory] of [["web", 25, 100], ["worker", 150, 200]] as const) {
    await selectService(service);
    expect(container.querySelectorAll('[aria-label$="usage history"]')).toHaveLength(2);
    const panel = container.querySelector(`[aria-label="${service} resources"]`)!;
    expect(panel.textContent).toContain(`CPU ${cpu.toFixed(1)}%`);
    expect(panel.textContent).toContain(`RAM ${memory} MiB`);
    expect(panel.querySelectorAll('[aria-label$="usage history"]')).toHaveLength(2);
    const points = JSON.parse(panel.querySelector('[data-points]')!.getAttribute('data-points')!);
    expect(points[0].cpu).toBe(cpu);
    expect(points[0].memory).toBe(memory * 1048576);
  }
  expect(container.querySelector('[aria-label="private resources"]')).toBeNull();
  expect(mocks.watch).toHaveBeenCalledOnce();
  expect(mocks.stop).not.toHaveBeenCalled();
});

it("retains history while hiding stale or inactive live readings", async () => {
  await render(); await act(async () => publish({ snapshot, fresh: false }));
  const panel = () => container.querySelector('[aria-label="web resources"]')!;
  expect(panel().textContent).toContain("CPU —");
  expect(panel().textContent).toContain("Retained points are historical");
  expect(panel().querySelectorAll('[aria-label$="usage history"]')).toHaveLength(2);
  await act(async () => publish({ snapshot, fresh: true }));
  await render({ ...app, runtimeState: "stopped" });
  expect(panel().textContent).toContain("RAM —");
  await render({ ...app, health: { status: "healthy", observedAt: timestamp, services: [{ service: "web", status: "exited" }] } });
  expect(panel().textContent).toContain("CPU —");
});

it("keeps missing readings explicit without inventing zeroes", async () => {
  await render();
  expect(container.textContent).toContain("Waiting for resource samples");
  expect(container.textContent).toContain("CPU —");
  expect(container.querySelector('[aria-label="CPU usage history"]')).toBeNull();
});

it("preserves the selected service across samples and falls back when it disappears", async () => {
  await render(); await act(async () => publish({ snapshot, fresh: true }));
  await selectService("worker");
  await act(async () => publish({ snapshot: { ...snapshot, sequence: 2 }, fresh: true }));
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("worker");
  expect(container.querySelector('[aria-label="web resources"]')).toBeNull();
  const onlyWeb = { ...snapshot, history: snapshot.history.map(frame => ({ ...frame, services: frame.services.filter(sample => sample.service === "web") })) };
  await act(async () => publish({ snapshot: onlyWeb, fresh: true }));
  expect(container.querySelector('[aria-label="web resources"]')).not.toBeNull();
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  await act(async () => publish({ snapshot, fresh: true }));
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("web");
});

it("resets service selection for another app and handles an empty service inventory", async () => {
  await render(); await act(async () => publish({ snapshot, fresh: true }));
  await selectService("worker");
  await render({ ...app, id: "next.app", endpoints: [], health: { status: "healthy", observedAt: timestamp,
    services: [{ service: "api", status: "running" }, { service: "worker", status: "running" }] } });
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("api");
  expect(container.querySelector('[aria-label="worker resources"]')).toBeNull();
  await render({ ...app, id: "empty.app", endpoints: [] });
  expect(container.textContent).toContain("No service resource observations are available");
  expect(container.querySelector('[role="tablist"]')).toBeNull();
});
