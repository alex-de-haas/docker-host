import { describe, expect, it } from "vitest";
import { APPLICATIONS, appPages, clampBounds, defaultWorkspace, displayedBounds, dockApps, focusWindow, pageReady, pageUrl, restoreWorkspace, storageKey, visibleApps, type App, type User } from "../src/lib/model";
const user: User = { id: "alice", displayName: "Alice", role: "host.user" };
const running: App = { id: "example.notes", displayName: "Notes", runtimeState: "running", entryEndpoint: "web", embeddedUrl: "https://notes.example/" };
const viewport = { width: 1440, height: 900 };
describe("app access and readiness", () => {
  it("limits users to running assigned UI apps and excludes the desktop itself", () => {
    const apps = [running, { ...running, id: "stopped", runtimeState: "stopped" }, { ...running, id: "starting", runtimeState: "starting" },
      { ...running, id: "headless", entryEndpoint: null, embeddedUrl: null }, { ...running, id: "desktop" }];
    expect(visibleApps(apps, user, "desktop").map(app => app.id)).toEqual([running.id]);
    expect(visibleApps(apps, { ...user, role: "host.admin" }, "desktop").map(app => app.id)).toEqual([running.id, "stopped", "starting"]);
  });
  it("waits for the selected service without confusing runtime and probe states", () => {
    const app = { ...running, health: { services: [{ service: "web", status: "running", health: "starting" }] } };
    expect(pageReady(app, { label: "Notes", path: "/", service: "web" })).toBe(false);
    app.health.services[0].health = "healthy";
    expect(pageReady(app, { label: "Notes", path: "/", service: "web" })).toBe(true);
    expect(pageReady({ ...app, runtimeState: "stopping" }, { label: "Notes", path: "/", service: "web" })).toBe(false);
  });
  it.each([
    { aggregate: "starting", selected: "healthy", ready: true },
    { aggregate: "starting", selected: null, ready: true },
    { aggregate: "degraded", selected: "starting", ready: false },
  ])("uses the selected service probe ($selected) instead of aggregate $aggregate", ({ aggregate, selected, ready }) => {
    // Core serializes each service's Health as a nullable string, not a nested object.
    const app: App = { ...running, endpoints: [{ key: "web", service: "frontend" }], health: { status: aggregate, services: [
      { service: "frontend", status: "running", health: selected },
      { service: "worker", status: "running", health: aggregate === "starting" ? "starting" : "unhealthy" },
    ] } };
    expect(pageReady(app, { label: "Notes", path: "/", endpoint: "web" })).toBe(ready);
  });
  it("falls back to aggregate readiness only when the selected service has no reading", () => {
    const page = { label: "Notes", path: "/", service: "web" };
    expect(pageReady({ ...running, health: { status: "starting", services: [] } }, page)).toBe(false);
    expect(pageReady({ ...running, health: { status: "healthy", services: [] } }, page)).toBe(true);
    expect(pageReady({ ...running, health: { status: "healthy", services: [{ service: "web", status: "stopped", health: null }] } }, page)).toBe(false);
  });
  it("only opens valid Core-projected HTTP surfaces and removes stale composition hints", () => {
    const page = { label: "Notes", path: "/", embeddedUrl: "https://notes.example/work?q=hello#draft" };
    expect(pageUrl(running, page)).toBe(page.embeddedUrl);
    expect(pageUrl(running, { ...page, embeddedUrl: "javascript:alert(1)" })).toBeNull();
    expect(pageUrl(running, { ...page, embeddedUrl: "https://secret:password@notes.example" })).toBeNull();
    expect(pageUrl(running, { ...page, embeddedUrl: "https://notes.example/?hosty_theme=dark&hosty_navigation=hide" })).toBe("https://notes.example/");
    expect(appPages(running)[0].endpoint).toBe("web");
  });
});
describe("window restoration", () => {
  it("recovers from malformed storage, duplicate windows and inaccessible apps", () => {
    expect(restoreWorkspace("not-json", [], viewport)).toEqual(defaultWorkspace);
    const win = { id: running.id, bounds: { x: -99, y: 10000, width: 8000, height: -2 }, minimized: false, mode: "normal", page: 0 };
    const state = restoreWorkspace(JSON.stringify({ windows: [win, win, { ...win, id: "not-assigned" }, { ...win, id: APPLICATIONS, bounds: {} }], theme: "bad", pins: [running.id, "not-assigned"] }), [running.id], viewport);
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].bounds).toEqual({ x: 12, y: 548, width: 1416, height: 260 });
    expect(state.pins).toEqual([running.id]); expect(state.theme).toBe("system");
  });
  it("restores focus without losing window geometry or minimized siblings", () => {
    const first = { id: "first", bounds: { x: 100, y: 100, width: 700, height: 500 }, mode: "normal" as const, minimized: true, page: 2 };
    const second = { ...first, id: "second", minimized: false };
    const focused = focusWindow([first, second], "first");
    expect(focused[1]).toEqual({ ...first, minimized: false });
    expect(focused[0]).toEqual(second);
  });
  it("keeps titlebars and resize bounds inside the usable viewport", () => {
    expect(clampBounds({ x: 9999, y: -100, width: 900, height: 500 }, { width: 390, height: 844 })).toEqual({ x: 12, y: 48, width: 366, height: 500 });
    const frame = { id: "test", bounds: { x: 80, y: 70, width: 600, height: 500 }, minimized: false, page: 0, mode: "right" as const };
    expect(displayedBounds(frame, viewport)).toEqual({ x: 726, y: 48, width: 702, height: 760 });
  });
  it("isolates preferences per user and preserves pinned ordering", () => {
    expect(storageKey("alice")).not.toBe(storageKey("bob"));
    const other = { ...running, id: "example.music", displayName: "Music" };
    expect(dockApps([other, running], { ...defaultWorkspace, pins: [running.id] }).map(app => app.id)).toEqual([running.id, other.id]);
  });
});
