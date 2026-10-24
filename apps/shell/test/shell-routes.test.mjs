import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthorizedShellView,
  getManageAppHref,
  getShellAuthorizationRedirect,
  getSettingsHref,
  getShellViewHref,
  getWorkspaceHref,
  readCanonicalRedirect,
  isHostSettingsTab,
  readHostSettingsTab,
  readShellRoute,
  shellViewRequiresAdmin,
  SHELL_VIEW_LABELS,
  loginContinuation,
} from "../src/app/shell/shell-routes.ts";

const params = (search = "") => new URLSearchParams(search);

test("the three destinations resolve from their own paths", () => {
  assert.equal(readShellRoute("/dashboard", params()).view, "dashboard");
  assert.equal(readShellRoute("/settings", params()).view, "settings");
  assert.equal(readShellRoute("/apps", params()).view, "home");
  assert.equal(readShellRoute("/", params()).view, "home");
});

test("the parser is total — every path yields a route state", () => {
  // Not a user-visible fallback: the app has no catch-all segment and no not-found.tsx, so Next.js
  // answers its own 404 for an unrouted path and ShellClient never renders. What this pins is that
  // the parser cannot throw or return undefined for input it does not recognize — it is called on
  // every render with whatever `usePathname()` reports.
  for (const [path, view] of [["/nothing-here", "dashboard"], ["/settings/extra", "dashboard"], ["//", "home"], ["/%", "dashboard"]]) {
    const route = readShellRoute(path, params());
    assert.equal(route.view, view, `readShellRoute(${path})`);
    assert.equal(route.workspace, null);
    assert.equal(route.settingsTab, "profile");
  }
});

test("only Dashboard and Settings are administrator-only", () => {
  assert.equal(shellViewRequiresAdmin("dashboard"), true);
  assert.equal(shellViewRequiresAdmin("settings"), true);
  assert.equal(shellViewRequiresAdmin("home"), false);
});

test("readHostSettingsTab still collapses anything unknown to Users", () => {
  assert.equal(readHostSettingsTab("core"), "general");
  assert.equal(readHostSettingsTab("ingress"), "ingress");
  assert.equal(readHostSettingsTab("mounts"), "mounts");
  assert.equal(readHostSettingsTab(" users "), "users");
  for (const value of ["nonsense", "", "   ", null, undefined]) {
    assert.equal(readHostSettingsTab(value), "profile", `readHostSettingsTab(${value})`);
  }
});

test("the route keeps a settings tab raw, because it may be an app id", () => {
  // An app-settings tab carries the app id in this parameter. Collapsing anything unfamiliar to the
  // default here would send every app tab to Users — the surface rendered and unreachable. Which of
  // the two a value is gets decided against the installed apps, at render, where that list exists.
  assert.equal(readShellRoute("/settings", params("tab=core")).settingsTab, "general");
  assert.equal(readShellRoute("/settings", params("tab=com.haas.demo-app")).settingsTab, "com.haas.demo-app");
  assert.equal(readShellRoute("/settings", params()).settingsTab, "profile");
  assert.equal(readShellRoute("/settings", params("tab=   ")).settingsTab, "profile");
  assert.equal(isHostSettingsTab("core"), true);
  assert.equal(isHostSettingsTab("com.haas.demo-app"), false);
});

test("a workspace route carries the app id and path", () => {
  const route = readShellRoute("/workspace", params("app=com.haas.demo-app&path=/reports"));
  assert.deepEqual(route.workspace, { appId: "com.haas.demo-app", path: "/reports" });
  assert.equal(route.view, "home");

  // No app id is not a workspace; the client sends it back to neutral home.
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
  assert.equal(readCanonicalRedirect("/users", params()), "/settings?tab=security&section=users");
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
  for (const path of ["/", "/dashboard", "/settings", "/workspace"]) {
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

  for (const tab of ["profile", "users", "tokens", "general", "hosty.harness", "shell", "connections", "policies", "ingress", "mounts"]) {
    const settingsUrl = new URL(getSettingsHref(tab), "http://x");
    assert.equal(readShellRoute(settingsUrl.pathname, settingsUrl.searchParams).settingsTab, tab);
  }

  const workspaceUrl = new URL(getWorkspaceHref("com.haas.demo-app", "/reports"), "http://x");
  assert.deepEqual(readShellRoute(workspaceUrl.pathname, workspaceUrl.searchParams).workspace, {
    appId: "com.haas.demo-app",
    path: "/reports",
  });
});

// Settings also exposes personal profile and access tokens to ordinary users. Access tokens are per-user in Core — a
// host.user creates, lists and revokes their own — so bouncing them to host administration would leave a
// supported role with no way to manage its own credentials.
test("an ordinary user reaches personal profile and access tokens", () => {
  assert.equal(getAuthorizedShellView("settings", false, "tokens"), "settings");
  assert.equal(getAuthorizedShellView("settings", false, "profile"), "settings");
  assert.equal(getAuthorizedShellView("settings", false, "users"), "home");
  assert.equal(getAuthorizedShellView("settings", false, "core"), "home");
  assert.equal(getAuthorizedShellView("settings", false, undefined), "home");

  // An administrator is unaffected, and a non-admin view never depended on the tab at all.
  assert.equal(getAuthorizedShellView("settings", true, "core"), "settings");
  assert.equal(getAuthorizedShellView("home", false, undefined), "home");
});


test("authorization redirects preserve personal tokens and react to settings tab changes", () => {
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/settings", params("tab=profile")), true, false), null);
  const tokens = readShellRoute("/settings", params("tab=tokens"));
  assert.equal(getShellAuthorizationRedirect(tokens, true, false), null);
  for (const tab of ["users", "core", "hosty.harness", "unknown"]) {
    const route = readShellRoute("/settings", params(`tab=${tab}`));
    assert.equal(getShellAuthorizationRedirect(route, true, false), "/");
    assert.equal(getShellAuthorizationRedirect(route, true, true), null);
    assert.equal(getShellAuthorizationRedirect(route, false, false), null);
  }
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/dashboard", params()), true, false), "/");
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/apps", params()), true, false), null);
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/workspace", params("app=demo")), true, false), null);
});


test("grouped settings links preserve inner tabs and old bookmarks", () => {
  for (const [group, child] of [["security", "users"], ["profile", "tokens"], ["profile", "connections"], ["security", "policies"], ["host", "general"], ["host", "source"]]) {
    assert.equal(getSettingsHref(child), `/settings?tab=${group}&section=${child}`);
    assert.equal(readShellRoute("/settings", params(`tab=${group}&section=${child}`)).settingsTab, child);
  }
  assert.equal(getSettingsHref("core"), "/settings?tab=host&section=general");
  assert.equal(readShellRoute("/settings", params("tab=security&section=unknown")).settingsTab, "users");
  assert.equal(readShellRoute("/settings", params("tab=security&section=tokens")).settingsTab, "tokens");
  assert.equal(readShellRoute("/settings", params("tab=harness&section=agents")).settingsTab, "hosty.harness");
  assert.equal(readShellRoute("/settings", params("tab=harness&section=shell")).settingsTab, "shell");
});

test("grouped settings URLs keep personal credentials accessible without opening host controls", () => {
  const tokens = readShellRoute("/settings", params("tab=security&section=tokens"));
  assert.equal(getShellAuthorizationRedirect(tokens, true, false), null);
  for (const section of ["users", "connections", "policies", "unknown"]) {
    const route = readShellRoute("/settings", params(`tab=security&section=${section}`));
    assert.equal(getShellAuthorizationRedirect(route, true, false), "/");
  }
});


test("app details have a dedicated canonical route with every supported section", () => {
  for (const section of ["app", "parameters", "permissions", "publicOrigins", "mounts", "source", "backups", "logs"]) {
    const url = new URL(getManageAppHref("com.haas.demo-app", section), "http://x");
    assert.equal(url.pathname, "/apps/com.haas.demo-app");
    assert.equal(url.searchParams.get("section"), section);
    const route = readShellRoute(url.pathname, url.searchParams);
    assert.equal(route.view, "dashboard");
    assert.equal(route.workspace, null);
    assert.deepEqual(route.appDetails, { appId: "com.haas.demo-app", section });
    assert.equal(readCanonicalRedirect(url.pathname, url.searchParams), null);
  }
  assert.equal(getManageAppHref("com.haas.demo-app"), "/apps/com.haas.demo-app?section=app");
});

test("old management bookmarks render app details immediately and preserve their section", () => {
  for (const section of ["app", "parameters", "permissions", "publicOrigins", "mounts", "source", "backups", "logs"]) {
    const search = params(`tab=manage%3Acom.haas.demo-app&section=${section}`);
    const legacy = readShellRoute("/settings", search);
    assert.equal(legacy.view, "dashboard");
    assert.equal(legacy.workspace, null);
    assert.deepEqual(legacy.appDetails, { appId: "com.haas.demo-app", section });
    const canonical = new URL(readCanonicalRedirect("/settings", search), "http://x");
    assert.deepEqual(readShellRoute(canonical.pathname, canonical.searchParams).appDetails, legacy.appDetails);
    assert.equal(readCanonicalRedirect(canonical.pathname, canonical.searchParams), null);
  }
});

test("the retired Settings installed-app catalog resolves and canonicalizes to Dashboard", () => {
  assert.equal(readShellRoute("/settings", params("tab=apps")).view, "dashboard");
  assert.equal(readShellRoute("/settings", params("tab=apps")).appDetails, undefined);
  assert.equal(readCanonicalRedirect("/settings", params("tab=apps")), "/dashboard");
  assert.equal(readCanonicalRedirect("/settings", params("tab=hosty.harness")), null);
});

test("app details preserve encoded identifiers and tolerate malformed percent encoding", () => {
  const url = new URL(getManageAppHref("com.example.app%name", "logs"), "http://x");
  assert.equal(url.pathname, "/apps/com.example.app%25name");
  assert.deepEqual(readShellRoute(url.pathname, url.searchParams).appDetails, { appId: "com.example.app%name", section: "logs" });
  assert.deepEqual(readShellRoute("/apps/com.haas.demo%2Dapp/", params()).appDetails, { appId: "com.haas.demo-app", section: "app" });
  assert.deepEqual(readShellRoute("/apps/%not-encoded", params("section=logs")).appDetails, { appId: "%not-encoded", section: "logs" });
  const legacy = params("tab=manage%3Acom.example.app%25name&section=logs");
  assert.equal(readCanonicalRedirect("/settings", legacy), getManageAppHref("com.example.app%name", "logs"));
  assert.equal(readShellRoute("/settings", params("tab=manage%3A")).appDetails, undefined);
});

test("missing or unsupported app-detail sections fall back to Launch", () => {
  for (const section of [null, "", "unknown", "host", "../../settings"]) {
    const search = new URLSearchParams();
    if (section !== null) search.set("section", section);
    assert.deepEqual(readShellRoute("/apps/com.haas.demo-app", search).appDetails, { appId: "com.haas.demo-app", section: "app" });
    search.set("tab", "manage:com.haas.demo-app");
    assert.equal(readShellRoute("/settings", search).appDetails.section, "app");
    assert.equal(readCanonicalRedirect("/settings", search), "/apps/com.haas.demo-app?section=app");
  }
  assert.equal(getManageAppHref("com.haas.demo-app", "unknown"), "/apps/com.haas.demo-app?section=app");
});

test("app-detail routes retain administrator authorization outside the client logs exception", () => {
  for (const [path, search] of [["/apps/com.haas.demo-app", "section=logs"], ["/settings", "tab=manage%3Acom.haas.demo-app&section=permissions"]]) {
    const route = readShellRoute(path, params(search));
    assert.equal(getShellAuthorizationRedirect(route, true, false), "/");
    assert.equal(getShellAuthorizationRedirect(route, true, true), null);
    assert.equal(getShellAuthorizationRedirect(route, false, false), null);
  }
});


test("neutral home resolves by role without exposing an app catalog", () => {
  assert.equal(getShellViewHref("home"), "/");
  assert.equal(SHELL_VIEW_LABELS.home, "Hosty");
  assert.equal(getAuthorizedShellView("home", true), "dashboard");
  assert.equal(getAuthorizedShellView("home", false), "home");
  const home = readShellRoute("/", params());
  assert.equal(getShellAuthorizationRedirect(home, true, true), "/dashboard");
  assert.equal(getShellAuthorizationRedirect(home, true, false), null);
  assert.equal(getShellAuthorizationRedirect(home, false, false), null);
});

test("the retired Apps URL reaches a stable role-specific destination without loops", () => {
  for (const path of ["/apps", "/apps/"]) {
    const canonical = readCanonicalRedirect(path, params());
    assert.equal(canonical, "/");
    assert.equal(readShellRoute(path, params()).view, "home");
    assert.equal(readCanonicalRedirect(canonical, params()), null);
    for (const canManageApps of [false, true]) {
      const home = readShellRoute(canonical, params());
      const authorized = getShellAuthorizationRedirect(home, true, canManageApps);
      assert.equal(authorized, canManageApps ? "/dashboard" : null);
      const finalPath = authorized ?? canonical;
      assert.equal(readCanonicalRedirect(finalPath, params()), null);
      assert.equal(getShellAuthorizationRedirect(readShellRoute(finalPath, params()), true, canManageApps), null);
    }
  }
});


test("home and authorization redirects preserve an assistant handoff without forwarding unrelated settings", () => {
  const search = params("assistantSession=session_123&assistantApp=third.party&assistantPanel=discussions&tab=users&unrelated=ignore");
  const continuation = "assistantSession=session_123&assistantApp=third.party&assistantPanel=discussions";
  assert.equal(readCanonicalRedirect("/apps", search), `/?${continuation}`);
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/", search), true, true, search), `/dashboard?${continuation}`);
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/settings", search), true, false, search), `/?${continuation}`);
  assert.equal(getShellAuthorizationRedirect(readShellRoute("/", search), true, false, search), null);
  const target = new URL(getShellAuthorizationRedirect(readShellRoute("/", search), true, true, search), "https://shell.test");
  assert.equal(readCanonicalRedirect(target.pathname, target.searchParams), null);
  assert.equal(getShellAuthorizationRedirect(readShellRoute(target.pathname, target.searchParams), true, true, target.searchParams), null);
});

test("assistant handoff values are encoded inside a same-origin redirect", () => {
  const search = params();
  search.set("assistantSession", "session_123");
  search.set("assistantApp", "third.party&tab=users");
  search.set("assistantPanel", "https://external.test/?query=#fragment");
  const target = new URL(getShellAuthorizationRedirect(readShellRoute("/", search), true, true, search), "https://shell.test");
  assert.equal(target.origin, "https://shell.test");
  assert.equal(target.pathname, "/dashboard");
  assert.equal(target.hash, "");
  assert.equal(target.searchParams.get("tab"), null);
  for (const key of ["assistantSession", "assistantApp", "assistantPanel"]) assert.equal(target.searchParams.get(key), search.get(key));
});

test("an assistant handoff at neutral home survives sign-in while clean home keeps its empty continuation", () => {
  const search = "?assistantSession=session_123&assistantApp=third.party&assistantPanel=discussions";
  const continuation = loginContinuation("/", search);
  assert.equal(new URLSearchParams(continuation.slice(1)).get("returnTo"), `/${search}`);
  assert.equal(loginContinuation("/", ""), "");
  assert.equal(loginContinuation("/", "?"), "");
  assert.equal(loginContinuation("/", "//external.test"), "");
  assert.equal(loginContinuation("//external.test", search), "");
  assert.equal(loginContinuation("https://external.test/", search), "");
});
