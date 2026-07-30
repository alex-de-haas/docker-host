import assert from "node:assert/strict";
import test from "node:test";
import {
  getSettingsHref,
  getShellViewHref,
  getWorkspaceHref,
  readCanonicalRedirect,
  readHostSettingsTab,
  readShellRoute,
  shellViewRequiresAdmin,
} from "../src/app/shell/shell-routes.ts";

const params = (search = "") => new URLSearchParams(search);

test("the three destinations resolve from their own paths", () => {
  assert.equal(readShellRoute("/dashboard", params()).view, "dashboard");
  assert.equal(readShellRoute("/settings", params()).view, "settings");
  assert.equal(readShellRoute("/apps", params()).view, "available-apps");
  // An unrecognized path falls through to Dashboard rather than blanking the screen.
  assert.equal(readShellRoute("/nothing-here", params()).view, "dashboard");
  assert.equal(readShellRoute("/", params()).view, "dashboard");
});

test("only Dashboard and Settings are administrator-only", () => {
  assert.equal(shellViewRequiresAdmin("dashboard"), true);
  assert.equal(shellViewRequiresAdmin("settings"), true);
  assert.equal(shellViewRequiresAdmin("available-apps"), false);
});

test("an unknown or missing settings tab resolves to Users", () => {
  assert.equal(readHostSettingsTab("core"), "core");
  assert.equal(readHostSettingsTab("mounts"), "mounts");
  assert.equal(readHostSettingsTab(" users "), "users");
  for (const value of ["nonsense", "", "   ", null, undefined]) {
    assert.equal(readHostSettingsTab(value), "users", `readHostSettingsTab(${value})`);
  }

  assert.equal(readShellRoute("/settings", params("tab=core")).settingsTab, "core");
  assert.equal(readShellRoute("/settings", params("tab=nonsense")).settingsTab, "users");
  assert.equal(readShellRoute("/settings", params()).settingsTab, "users");
});

test("a workspace route carries the app id and path", () => {
  const route = readShellRoute("/workspace", params("app=com.haas.demo-app&path=/reports"));
  assert.deepEqual(route.workspace, { appId: "com.haas.demo-app", path: "/reports" });
  assert.equal(route.view, "available-apps");

  // No app id is not a workspace; the client sends it back to the apps overview.
  assert.equal(readShellRoute("/workspace", params()).workspace, null);
});

test("a system-app deep link resolves to the same workspace, path intact", () => {
  const route = readShellRoute("/system-apps/com.haas.telemetry-ui", params("path=/logs"));
  assert.deepEqual(route.workspace, { appId: "com.haas.telemetry-ui", path: "/logs" });

  // The gate the separate route expressed is Core's — a launch code for a system app requires
  // host.admin — so the client route carries no system flag of its own any more.
  assert.equal("system" in route.workspace, false);
});

test("legacy paths render their new surface", () => {
  assert.equal(readShellRoute("/installed-apps", params()).view, "dashboard");
  assert.equal(readShellRoute("/users", params()).view, "settings");
});

test("legacy paths canonicalize, and a deep link keeps its path", () => {
  assert.equal(readCanonicalRedirect("/installed-apps", params()), "/dashboard");
  assert.equal(readCanonicalRedirect("/users", params()), "/settings?tab=users");
  assert.equal(
    readCanonicalRedirect("/system-apps/com.haas.telemetry-ui", params("path=/logs")),
    "/workspace?app=com.haas.telemetry-ui&path=%2Flogs",
  );
  // A deep link with no path still lands on the app's entry page.
  assert.equal(
    readCanonicalRedirect("/system-apps/com.haas.marketplace", params()),
    "/workspace?app=com.haas.marketplace&path=%2F",
  );
});

test("a canonical path is not redirected, so nothing can loop", () => {
  for (const path of ["/", "/dashboard", "/settings", "/apps", "/workspace"]) {
    assert.equal(readCanonicalRedirect(path, params()), null, `readCanonicalRedirect(${path})`);
  }

  // Each redirect target is itself canonical — the property that makes the effect terminate.
  assert.equal(readCanonicalRedirect(readCanonicalRedirect("/installed-apps", params()), params()), null);
  assert.equal(readCanonicalRedirect("/settings", params("tab=users")), null);
});

test("percent-encoded app ids survive the deep link", () => {
  const route = readShellRoute("/system-apps/com.haas.demo%2Dapp", params());
  assert.equal(route.workspace.appId, "com.haas.demo-app");
});

test("builders and the parser agree", () => {
  assert.equal(readShellRoute(new URL(getShellViewHref("settings"), "http://x").pathname, params()).view, "settings");

  const settingsHref = getSettingsHref("mounts");
  const settingsUrl = new URL(settingsHref, "http://x");
  assert.equal(readShellRoute(settingsUrl.pathname, settingsUrl.searchParams).settingsTab, "mounts");

  const workspaceUrl = new URL(getWorkspaceHref("com.haas.demo-app", "/reports"), "http://x");
  assert.deepEqual(readShellRoute(workspaceUrl.pathname, workspaceUrl.searchParams).workspace, {
    appId: "com.haas.demo-app",
    path: "/reports",
  });
});
