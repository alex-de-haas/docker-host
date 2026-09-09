import assert from "node:assert/strict";
import test from "node:test";
import {
  getAppPanelTabs,
  getAppSettingsTabs,
  resolveActiveSurfaceTab,
  resolveLaunchGate,
} from "../src/app/shell/surfaces/app-surface-tabs.ts";

const app = (overrides) => ({
  id: "com.example.app",
  displayName: "Example",
  version: "1.0.0",
  kind: "service",
  system: false,
  source: "local",
  operationStatus: "idle",
  runtimeState: "running",
  capabilities: [],
  ...overrides,
});

test("an app gets a tab only where it declares a surface", () => {
  // The pair that matters: a declaring app and a non-declaring one in the same fleet. Either
  // assertion alone is satisfied by a rule that always answers the same way.
  const apps = [
    app({ id: "declares", settingsSurface: { path: "/settings", embeddedUrl: "http://a/settings" } }),
    app({ id: "declares-nothing" }),
  ];

  assert.deepEqual(getAppSettingsTabs(apps).map((tab) => tab.appId), ["declares"]);
  assert.deepEqual(getAppPanelTabs(apps), []);
});

test("the two surfaces are independent — declaring one says nothing about the other", () => {
  const apps = [
    app({ id: "settings-only", settingsSurface: { path: "/s", embeddedUrl: "http://a/s" } }),
    app({ id: "panels-only", panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: "http://b/p" }] }),
  ];

  assert.deepEqual(getAppSettingsTabs(apps).map((tab) => tab.appId), ["settings-only"]);
  assert.deepEqual(getAppPanelTabs(apps).map((tab) => tab.appId), ["panels-only"]);
});

test("one app may ship several panels, each with its own tab and key", () => {
  const tabs = getAppPanelTabs([
    app({
      panelSurfaces: [
        { path: "/one", label: "First", embeddedUrl: "http://a/one" },
        { path: "/two", label: "Second", embeddedUrl: "http://a/two" },
      ],
    }),
  ]);

  assert.deepEqual(tabs.map((tab) => tab.label), ["First", "Second"]);
  // Distinct keys, or the strip cannot tell one of an app's panels from another.
  assert.equal(new Set(tabs.map((tab) => tab.key)).size, 2);
});

test("a surface with no label falls back to the app's name, numbered only when it needs to be", () => {
  const single = getAppPanelTabs([app({ displayName: "Demo App", panelSurfaces: [{ path: "/p" }] })]);
  assert.deepEqual(single.map((tab) => tab.label), ["Demo App"]);

  const several = getAppPanelTabs([
    app({ displayName: "Demo App", panelSurfaces: [{ path: "/a" }, { path: "/b" }] }),
  ]);
  assert.deepEqual(several.map((tab) => tab.label), ["Demo App 1", "Demo App 2"]);
});

test("a stopped app keeps its tab, carrying the reason rather than vanishing", () => {
  // A surface that disappeared with its app would read as uninstalled, and the operator would go
  // looking for the app rather than starting it.
  const tabs = getAppPanelTabs([
    app({ runtimeState: "stopped", panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: null }] }),
  ]);

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].running, false);
  assert.equal(tabs[0].embeddedUrl, null);
});

test("a stopped app's tab drops the URL Core still projects for it", () => {
  // The case the fixture above cannot reach: an endpoint keeps its reserved port while the app is
  // down, so Core hands Shell a well-formed URL that nothing answers. Embedding it renders the
  // browser's connection-error page inside the tab, and a stopped app then looks broken instead of
  // stopped. Both strips are asserted — the rule belongs to the surface, not to one of its placements.
  const stopped = [
    app({
      runtimeState: "stopped",
      settingsSurface: { path: "/s", embeddedUrl: "http://127.0.0.1:3100/s" },
      panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: "http://127.0.0.1:3100/p" }],
    }),
  ];

  assert.equal(getAppPanelTabs(stopped)[0].embeddedUrl, null);
  assert.equal(getAppSettingsTabs(stopped)[0].embeddedUrl, null);
  // The tab itself stays: it is the only thing that says the tool exists at all.
  assert.equal(getAppPanelTabs(stopped)[0].label, "Tool");
  assert.equal(getAppPanelTabs(stopped)[0].running, false);
});

test("a running app keeps the URL, so the gate cannot be satisfied by always answering null", () => {
  const running = [
    app({ panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: "http://127.0.0.1:3100/p" }] }),
  ];

  assert.equal(getAppPanelTabs(running)[0].embeddedUrl, "http://127.0.0.1:3100/p");
  assert.equal(getAppPanelTabs(running)[0].running, true);
});

test("an app mid-verb is transitioning, not stopped", () => {
  // The state the recording caught: Core reports "starting" for a couple of seconds after Start, and
  // "not running" admits it — so the tab said the app was stopped and offered a Start that would have
  // raced the one already under way. Stopped is asserted alongside it, since a flag that were always
  // true would satisfy the first assertion alone.
  const [starting] = getAppPanelTabs([
    app({ runtimeState: "starting", panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: "http://127.0.0.1:3100/p" }] }),
  ]);
  const [stopped] = getAppPanelTabs([
    app({ runtimeState: "stopped", panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: "http://127.0.0.1:3100/p" }] }),
  ]);

  assert.equal(starting.transitioning, true);
  assert.equal(starting.running, false);
  assert.equal(starting.runtimeState, "starting");
  // Still nothing to embed: the port is not answering yet either.
  assert.equal(starting.embeddedUrl, null);

  assert.equal(stopped.transitioning, false);
});

// --- Readiness (docs/features/app-readiness/) ------------------------------------------------------

const url = "http://127.0.0.1:3100/p";
const panelOn = (service) => ({ panelSurfaces: [{ path: "/p", label: "Tool", embeddedUrl: url, service }] });
const health = (status, services) => ({ status, services, observedAt: "2026-09-09T00:00:00Z" });

test("a surface opens on its own only when the service that serves it answers", () => {
  // Same lifecycle state, three readings: the URL is there in all three (the service is alive), and
  // only readiness differs — which is exactly the split the panel needs to show progress, offer
  // "open anyway", or embed.
  const [starting] = getAppPanelTabs([app({ ...panelOn("web"), health: health("starting", [{ service: "web", status: "running", health: "starting" }]) })]);
  const [degraded] = getAppPanelTabs([app({ ...panelOn("web"), health: health("degraded", [{ service: "web", status: "running", health: "unhealthy" }]) })]);
  const [ready] = getAppPanelTabs([app({ ...panelOn("web"), health: health("healthy", [{ service: "web", status: "running", health: "healthy" }]) })]);

  assert.deepEqual([starting.embeddedUrl, starting.readiness], [url, "starting"]);
  assert.deepEqual([degraded.embeddedUrl, degraded.readiness], [url, "degraded"]);
  assert.deepEqual([ready.embeddedUrl, ready.readiness], [url, "ready"]);
});

test("a service nothing probes is ready the moment it is alive", () => {
  const [tab] = getAppPanelTabs([app({ ...panelOn("web"), health: health("healthy", [{ service: "web", status: "running", health: null }]) })]);
  assert.equal(tab.readiness, "ready");
});

test("a running app Core has not read yet is unobserved, not stopped and not ready", () => {
  const [tab] = getAppPanelTabs([app({ ...panelOn("web"), health: null })]);
  assert.deepEqual([tab.embeddedUrl, tab.readiness], [url, "unobserved"]);
});

test("a dead sibling service does not close a working endpoint", () => {
  // The fold is `unhealthy` and the app `unknown`; the surface on the living service keeps its URL
  // and its readiness, and the surface on the dead one loses its URL — per service, not per app.
  const reading = health("unhealthy", [
    { service: "web", status: "running", health: "healthy" },
    { service: "worker", status: "exited", health: null },
  ]);
  const [onWeb] = getAppPanelTabs([app({ runtimeState: "unknown", ...panelOn("web"), health: reading })]);
  const [onWorker] = getAppPanelTabs([app({ runtimeState: "unknown", ...panelOn("worker"), health: reading })]);

  assert.deepEqual([onWeb.embeddedUrl, onWeb.readiness], [url, "ready"]);
  assert.equal(onWorker.embeddedUrl, null);
});

test("a verb in flight blocks every open, whatever the service reads", () => {
  const reading = health("healthy", [{ service: "web", status: "running", health: "healthy" }]);
  const [tab] = getAppPanelTabs([app({ runtimeState: "stopping", ...panelOn("web"), health: reading })]);
  assert.equal(tab.embeddedUrl, null);
});

test("a surface Core named no service for falls back to the fold", () => {
  const [tab] = getAppPanelTabs([app({ ...panelOn(null), health: health("degraded", [{ service: "web", status: "running", health: "unhealthy" }]) })]);
  assert.deepEqual([tab.embeddedUrl, tab.readiness], [url, "degraded"]);
});

test("the launch gate holds a starting page and lets a degraded one through", () => {
  // A row click is the row's "open anyway": degraded proceeds, starting and unobserved wait, and
  // anything not up is refused — the same rule a surface tab opens by.
  const gateFor = (overrides) => resolveLaunchGate(app(overrides), "web");
  assert.equal(gateFor({ health: health("starting", [{ service: "web", status: "running", health: "starting" }]) }).allowed, false);
  assert.equal(gateFor({ health: null }).allowed, false);
  assert.equal(gateFor({ health: health("degraded", [{ service: "web", status: "running", health: "unhealthy" }]) }).allowed, true);
  assert.equal(gateFor({ health: health("healthy", [{ service: "web", status: "running", health: "healthy" }]) }).allowed, true);
  assert.deepEqual(gateFor({ runtimeState: "stopped", health: null }), { up: false, readiness: "ready", allowed: false });
});

test("the active tab survives what it can and falls back rather than pointing at nothing", () => {
  const tabs = getAppPanelTabs([
    app({ id: "a", panelSurfaces: [{ path: "/p", label: "Kept" }] }),
    app({ id: "b", panelSurfaces: [{ path: "/p", label: "Other" }] }),
  ]);

  assert.equal(resolveActiveSurfaceTab(tabs, "b#0")?.label, "Other");
  // The app behind the chosen tab was uninstalled: fall back instead of rendering a blank panel.
  assert.equal(resolveActiveSurfaceTab(tabs, "gone#0")?.label, "Kept");
  assert.equal(resolveActiveSurfaceTab(tabs, null)?.label, "Kept");
  assert.equal(resolveActiveSurfaceTab([], "b#0"), null);
});
