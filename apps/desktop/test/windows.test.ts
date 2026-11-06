import { expect, it } from "vitest";
import { defaultWorkspace, restoreWorkspace, type App } from "../src/lib/model";
import { destinationPage, openAppWindow, resolvedDestination } from "../src/lib/windows";
const app: App = { id: "example.reviewer", installationId: "i1", displayName: "Reviews", runtimeState: "running", entryEndpoint: "web",
  navigation: [{ label: "Reviews", path: "/reviews", endpoint: "web", embeddedUrl: "https://review.example/reviews" }] };
const viewport = { width: 1400, height: 900 };
const destination = { endpoint: "web", route: "/reviews?repo=first&pr=1" };
it("opens new destinations, reuses exact current routes and restores migrated instances", () => {
  let state = openAppWindow(defaultWorkspace, app, viewport, { id: "one", destination });
  state = openAppWindow(state, app, viewport, { id: "two", destination: { ...destination, route: "/reviews?repo=second&pr=1" } });
  state.windows[0].minimized = true;
  state = openAppWindow(state, app, viewport, { id: "unused", destination });
  expect(state.windows.map(w => w.id)).toEqual(["two", "one"]); expect(state.windows[1].minimized).toBe(false);
  state.windows[1].currentRoute = "/reviews?repo=first&pr=3";
  state = openAppWindow(state, app, viewport, { id: "three", destination });
  expect(state.windows).toHaveLength(3);
  const restored = restoreWorkspace(JSON.stringify(state), [app.id], viewport);
  expect(restored.windows).toHaveLength(3); expect(restored.windows[1].destination?.route).toContain("pr=3");
  const legacy = restoreWorkspace(JSON.stringify({ windows: [{ ...state.windows[0], id: app.id, appId: undefined }] }), [app.id], viewport);
  expect(legacy.windows[0].appId).toBe(app.id);
  expect(restoreWorkspace(JSON.stringify(state), [], viewport).windows).toEqual([]);
});
it("rejects stale installations, traversal, unknown endpoints and foreign origins", () => {
  expect(destinationPage(app, destination, "old-install")).toBeNull();
  expect(destinationPage(app, { ...destination, route: "//foreign.example/" }, "i1")).toBeNull();
  expect(destinationPage(app, { ...destination, route: "/reviews/../secret" }, "i1")).toBeNull();
  expect(destinationPage(app, { ...destination, endpoint: "unknown" }, "i1")).toBeNull();
  const surface = { ...destination, appId: app.id, installationId: "i1", origin: "https://review.example", framePolicy: { microphone: false, popupEscape: false } };
  expect(resolvedDestination([app], surface)?.destination).toEqual(destination);
  expect(resolvedDestination([app], { ...surface, origin: "https://foreign.example" })).toBeNull();
});
it("opens fresh instances while ordinary launch focuses the last active app window", () => {
  let state = openAppWindow(defaultWorkspace, app, viewport, { id: "one" });
  state = openAppWindow(state, app, viewport, { id: "two", fresh: true });
  expect(openAppWindow(state, app, viewport, { id: "unused" }).windows.map(w => w.id)).toEqual(["one", "two"]);
});
