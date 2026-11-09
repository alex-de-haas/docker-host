import { APP_SESSION_ENDED } from "@hosty-sdk/app/browser-auth";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppLaunchSummary, AppServicesPanel } from "../src/app/shell/pages/app-launch-summary";
import type { AppHealthResponse, AppUpdateStatusResponse, CoreApp } from "../src/app/shell/types";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: mocks.read }));
let root: Root, container: HTMLDivElement, currentApp: CoreApp;
let healthReply: () => Promise<Response>, updateReply: () => Promise<Response>;
const app: CoreApp = {
  id: "example.media", displayName: "Media", version: "1.0.0", kind: "runtime", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: [],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  currentApp = app;
  healthReply = async () => Response.json({ appId: currentApp.id, runtime: "dev", runtimeType: "localCommand", status: currentApp.health?.status ?? "unknown", services: currentApp.health?.services ?? [] });
  updateReply = async () => Response.json({ appId: currentApp.id, runtime: "dev", runtimeType: "localCommand", updatePolicy: "pinned", updateAvailable: false, services: [] });
  mocks.read.mockReset();
  mocks.read.mockImplementation((url: string) => url.endsWith("/health") ? healthReply() : updateReply());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (current: CoreApp, serviceRevision = 0) => act(async () => { currentApp = current; root.render(<AppServicesPanel app={current} coreOrigin="https://core.test" serviceRevision={serviceRevision} />); });

it("uses only observed service health and keeps declared but unobserved services unknown", async () => {
  await render({ ...app, health: { status: "healthy", observedAt: "2026-10-21T00:00:00Z", services: [
    { service: "api", status: "running", health: "healthy" }, { service: "worker", status: "exited" },
  ] }, endpoints: [ { key: "ui", service: "web", protocol: "http", public: true }, { key: "api", service: "api", protocol: "http", public: false } ] });
  const services = container.querySelector('[aria-labelledby="app-services-example.media"]')!;
  expect(services.textContent).toContain("Unknown");
  expect(services.textContent).toContain("web");
  expect(services.textContent).toContain("Exited");
  expect(container.querySelector('a[href="/dashboard"]')).not.toBeNull();
});

it("keeps dependencies separate from app state and does not infer missing readiness", async () => {
  await act(async () => root.render(<AppLaunchSummary app={{ ...app, dependencies: [
    { appId: "example.database", version: ">=1.0", required: true, installed: true, running: true, ready: true },
    { appId: "example.search", required: false, installed: true, running: true, endpoints: [{ alias: "query", endpointKey: "api", resolved: false }] },
    { appId: "example.missing", required: false, installed: false, running: false },
  ] }} />));
  expect(container.textContent).toContain("Required · >=1.0");
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain("Running · readiness unavailable");
  expect(container.textContent).toContain("Endpoint unresolved");
  expect(container.textContent).toContain("Not installed");
  expect(container.querySelector('[aria-label="Core API activity"]')).toBeNull();
  expect(container.querySelector('[aria-labelledby="app-services-example.media"]')).toBeNull();
  expect(mocks.read).not.toHaveBeenCalled();
});


it("keeps explicit health facts, image drift, candidates and image-only services in Manage", async () => {
  const locked = "sha256:" + "a".repeat(64), running = "sha256:" + "b".repeat(64), candidate = "sha256:" + "c".repeat(64);
  const health: AppHealthResponse = { appId: app.id, runtime: "docker", runtimeType: "docker", status: "degraded", services: [
    { service: "api", status: "running", runtimeType: "docker", artifact: "image", image: "registry.test/api@" + running,
      health: "unhealthy", startedAt: "2026-10-22T08:00:00Z", restartCount: 3, message: "Health probe timed out" },
    { service: "worker", status: "running", runtimeType: "docker", image: locked, health: "healthy", restartCount: 0 },
  ] };
  const update: AppUpdateStatusResponse = { appId: app.id, runtime: "docker", runtimeType: "docker", updatePolicy: "pinned", updateAvailable: true, services: [
    { service: "api", lockedDigest: locked, candidateDigest: candidate, updateAvailable: true, unknown: false },
    { service: "queue", lockedDigest: locked, updateAvailable: false, unknown: true },
    { service: "candidate-only", candidateDigest: candidate, updateAvailable: true, unknown: false },
  ] };
  healthReply = async () => Response.json(health); updateReply = async () => Response.json(update);
  await render({ ...app, artifactLocks: { api: { kind: "docker-image", imageDigest: locked, resolvedAt: "2026-10-22T00:00:00Z" }, worker: { kind: "docker-image", imageDigest: locked, resolvedAt: "2026-10-22T00:00:00Z" }, "lock-only": { kind: "docker-image", imageDigest: locked, resolvedAt: "2026-10-22T00:00:00Z" } } });
  const api = container.querySelector('[aria-label="Service api"]')!;
  expect(api.textContent).toContain("Docker · image");
  expect(api.textContent).toContain("Unhealthy");
  expect(api.textContent).toContain("Health probe timed out");
  expect(api.textContent).toContain("Restarts 3");
  expect(api.querySelector("time")?.dateTime).toBe("2026-10-22T08:00:00Z");
  for (const digest of [locked, running, candidate]) expect(api.querySelector('[title="' + digest + '"]')).not.toBeNull();
  expect(api.textContent).toContain("Running a different build");
  expect(container.querySelector('[aria-label="Service worker"] [title="Running the locked build — ' + locked + '"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Service worker"]')?.textContent).toContain("Restarts 0");
  expect(container.querySelector('[aria-label="Service queue"]')?.textContent).toContain("registry unreachable");
  expect(container.querySelector('[aria-label="Service lock-only"]')?.textContent).toContain("Unknown");
  expect(container.querySelector('[aria-label="Service candidate-only"]')?.textContent).toContain("Available");
  expect(container.textContent).not.toContain("Service address");
  expect(mocks.read.mock.calls.map(([url]) => url)).toEqual([
    "https://core.test/api/apps/example.media/health", "https://core.test/api/apps/example.media/update-status",
  ]);
  expect(mocks.read.mock.calls.every(([, options]) => options.credentials === "include" && options.signal instanceof AbortSignal)).toBe(true);
});

it("reuses reads across summary snapshots and refreshes after explicit service action without a registry probe", async () => {
  const baseline = { ...app, health: { status: "healthy", observedAt: "2026-10-22T08:00:00Z", services: [] } };
  await render(baseline);
  await render({ ...baseline, health: { ...baseline.health, observedAt: "2026-10-22T08:01:00Z" } });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh services")!.click());
  expect(mocks.read).toHaveBeenCalledTimes(4);
  await render(baseline, 1);
  expect(mocks.read).toHaveBeenCalledTimes(6);
  await render({ ...baseline, updateCheck: { updateAvailable: false, requiresReview: false, checkedAt: "2026-10-22T08:02:00Z" } }, 1);
  expect(mocks.read).toHaveBeenCalledTimes(8);
  expect(mocks.read.mock.calls.some(([url]) => url.includes("refresh=true"))).toBe(false);
});

it("refreshes after readiness or factual source changes while ignoring observation timestamps", async () => {
  const baseline = { ...app, health: { status: "healthy", observedAt: "2026-10-22T08:00:00Z", services: [] }, sourceLivePath: "/workspace/a" };
  await render(baseline);
  await render({ ...baseline, health: { ...baseline.health, status: "degraded" } });
  expect(mocks.read).toHaveBeenCalledTimes(4);
  await render({ ...baseline, health: { ...baseline.health, status: "degraded" }, sourceLivePath: "/workspace/b" });
  expect(mocks.read).toHaveBeenCalledTimes(6);
});

it("reports independent failures without replacing known health with fabricated service state", async () => {
  healthReply = async () => Response.json({ message: "Health permission denied" }, { status: 403 });
  updateReply = async () => Response.json({ message: "Cached plan is invalid" }, { status: 400 });
  await render({ ...app, endpoints: [{ key: "http", service: "unobserved", protocol: "http", public: true }] });
  expect(container.textContent).toContain("Service health is unavailable");
  expect(container.textContent).toContain("Health permission denied");
  expect(container.textContent).toContain("Digest details are unavailable");
  expect(container.textContent).toContain("Cached plan is invalid");
  expect(container.querySelector('[aria-label="Service unobserved"]')?.textContent).toContain("Unknown");
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Refresh services")?.disabled).toBe(false);
});

it("does not let an earlier app's delayed detail overwrite the current app", async () => {
  let resolveOld!: (response: Response) => void;
  healthReply = () => new Promise(resolve => { resolveOld = resolve; });
  await render(app);
  const firstSignal = mocks.read.mock.calls[0][1].signal as AbortSignal;
  healthReply = async () => Response.json({ appId: "next.app", runtime: "dev", runtimeType: "localCommand", status: "running", services: [{ service: "new-service", status: "running" }] });
  await render({ ...app, id: "next.app" });
  expect(firstSignal.aborted).toBe(true);
  await act(async () => resolveOld(Response.json({ appId: app.id, runtime: "dev", runtimeType: "docker", status: "running", services: [{ service: "old-service", status: "running" }] })));
  expect(container.querySelector('[aria-label="Service new-service"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Service old-service"]')).toBeNull();
});

it("hands an expired session to the existing login flow instead of reporting it as a service error", async () => {
  const ended = vi.fn(); window.addEventListener(APP_SESSION_ENDED, ended);
  try {
    healthReply = async () => Response.json({ message: "Sign in" }, { status: 401 });
    await render(app);
    expect(container.textContent).not.toContain("Service health is unavailable");
    expect(container.textContent).not.toContain("Sign in");
    expect(ended).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Refresh services")?.disabled).toBe(false);
  } finally { window.removeEventListener(APP_SESSION_ENDED, ended); }
});


it("keeps the service loader until both reads settle and never presents a failed read as empty", async () => {
  let resolveHealth!: (value: Response) => void, resolveUpdate!: (value: Response) => void;
  healthReply = () => new Promise<Response>(done => { resolveHealth = done; });
  updateReply = () => new Promise<Response>(done => { resolveUpdate = done; });
  await render(app);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading service observations…");
  expect(container.querySelector('[role="status"] .hosty-grid-loader')).not.toBeNull();
  expect(container.textContent).not.toContain("No service observations");
  await act(async () => resolveHealth(Response.json({ services: [] })));
  expect(container.textContent).toContain("Loading service observations");
  await act(async () => resolveUpdate(Response.json({ message: "Registry unavailable" }, { status: 503 })));
  expect(container.textContent).toContain("Registry unavailable");
  expect(container.textContent).toContain("Service observations could not be confirmed");
  expect(container.querySelector('.hosty-empty-slots')).toBeNull();
  healthReply = async () => Response.json({ services: [] }); updateReply = healthReply;
  await act(async () => [...container.querySelectorAll('button')].find(node => node.textContent === "Refresh services")!.click());
  expect(container.textContent).toContain("No service observations are available");
  expect(container.querySelector('.hosty-empty-slots')).not.toBeNull();
  expect(container.textContent).not.toContain("Registry unavailable");
});
