// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeNavigationKey, captureChromeHints, chromeBootstrapScript, parseChromeHints, resolveChrome, UiCompositionModel, validChromeOverrides, withChromeHints } from "./ui-composition";
import type { UiNavigationEntry } from "./ui-types";
vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
afterEach(() => { document.documentElement.removeAttribute("data-hosty-chrome-hints"); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); });
describe("document chrome policy", () => {
  it("resolves leaves independently and removes sparse host overrides", () => {
    const hints = parseChromeHints("?hosty_navigation=hide&hosty_tools=enabled");
    const defaults = { tools: { enabled: false, launcher: "hide" as const } };
    expect(resolveChrome(defaults, hints, { tools: { enabled: false } })).toEqual({ navigation: "hide", enabled: false, launcher: "hide", sources: { navigation: "url", enabled: "host", launcher: "app" } });
    expect(resolveChrome(defaults, hints)).toMatchObject({ navigation: "hide", enabled: true, launcher: "hide" });
  });
  it.each(["hosty_navigation=hide&hosty_navigation=show", "hosty_navigation=HIDE", "hosty_navigation=bad"])("ignores invalid hints: %s", search => {
    expect(resolveChrome({ navigation: "show" }, parseChromeHints(search))).toMatchObject({ navigation: "show", sources: { navigation: "app" } });
  });
  it("never uses copied launch storage or framing to hide standalone navigation", () => {
    sessionStorage.setItem("hosty.launch.mode", "embedded");
    expect(parseChromeHints(captureChromeHints()).legacy).toBeUndefined();
    const model = new UiCompositionModel("/api/hosty/ui", "standalone");
    expect(model.getChrome()).toMatchObject({ navigation: "show", tools: { enabled: true, launcher: "show", owner: "local" } });
    model.dispose(); sessionStorage.clear();
  });
  it("captures launch hints once across routing and keeps app defaults above legacy", () => {
    window.history.replaceState({ app: "preserved" }, "", "/?hosty_navigation=hide&hosty_launch=native");
    const captured = captureChromeHints(); window.history.replaceState(null, "", "/people");
    expect(captureChromeHints()).toBe(captured);
    expect(resolveChrome({ navigation: "show" }, parseChromeHints("hosty_launch=native")).navigation).toBe("show");
  });
  it("rejects malformed policy and ignores stale revisions while retaining disconnected policy", () => {
    for (const value of [null, [], { tools: [] }, { tools: { owner: "host" } }, { navigation: "gone" }]) expect(validChromeOverrides(value)).toBe(false);
    const model = new UiCompositionModel("/api/hosty/ui", "embedded");
    model.setEnvironment({ mode: "embedded", connection: "connected" });
    model.setHostPolicy("generation-a", 2, { navigation: "hide" }, true);
    model.setHostPolicy("generation-a", 1, { navigation: "show" }, false);
    expect(model.getChrome()).toMatchObject({ navigation: "hide", tools: { enabled: false, owner: "host" } });
    model.setEnvironment({ mode: "embedded", connection: "blocked" });
    expect(model.getChrome()).toMatchObject({ navigation: "hide", stale: true, tools: { owner: "unavailable" } });
    model.setHostPolicy("generation-b", 0, { navigation: "show" }, false);
    expect(model.getChrome()).toMatchObject({ navigation: "show", tools: { enabled: true } }); model.dispose();
  });
  it("bootstrap and runtime agree before paint; links carry only explicit composition fields", () => {
    window.history.replaceState(null, "", "/?hosty_navigation=hide&hosty_tools=disabled");
    window.eval(chromeBootstrapScript({ navigation: "show" }));
    expect(document.documentElement.getAttribute("data-hosty-navigation")).toBe("hide");
    const url = new URL(withChromeHints("https://app.test/people?q=1#name", { navigation: "show", tools: { launcher: "hide" } }));
    expect(url.searchParams.get("q")).toBe("1"); expect(url.hash).toBe("#name");
    expect(url.searchParams.get("hosty_navigation")).toBe("show");
    expect(url.searchParams.has("hosty_tools")).toBe(false);
  });
});
const entry = (key: string, route: string, endpoint = "web"): UiNavigationEntry => ({ key, route, endpoint, origin: "http://localhost:3000", label: key, icon: null, available: true, state: "running", standaloneHref: "https://core.test/open" });
describe("manifest navigation", () => {
  const entries = [entry("home", "/"), entry("people", "/people"), entry("filtered", "/people?sort=name"), entry("detail", "/people/person"), entry("other", "/people/person", "admin")];
  it.each([["/", "home"], ["/people/17?tab=info", "people"], ["/people?sort=name", "filtered"], ["/people/person", "detail"], ["/people-other", null], ["/unknown", null]])("matches route %s", (route, key) => {
    expect(activeNavigationKey(entries, "web", route!)).toBe(key);
  });
  it("strips only SDK hints and selects the current endpoint", () => {
    expect(activeNavigationKey(entries, "admin", "/people/person?hosty_navigation=hide")).toBe("other");
    expect(activeNavigationKey(entries, "web", "/people?sort=other")).toBe("people");
  });
  it("retains immutable metadata and local routing during an outage, then clears it for another actor", async () => {
    const fetcher = vi.fn(async () => Response.json({ appId: "app", installationId: "one", revision: "r1", entries }));
    vi.stubGlobal("fetch", fetcher);
    const model = new UiCompositionModel("/ui", "standalone"), navigate = vi.fn();
    let route = "/", listener = () => {};
    model.attachRouter({ endpoint: "web", getRoute: () => route, navigate, subscribe: callback => { listener = callback; return () => {}; } });
    await model.refreshNavigation();
    expect(Object.isFrozen(model.getNavigation().catalog?.entries)).toBe(true);
    expect(Object.isFrozen(model.getNavigation().entries[0])).toBe(true);
    fetcher.mockRejectedValue(new Error("offline")); await model.refreshNavigation();
    expect(model.getNavigation()).toMatchObject({ status: "unavailable", entries });
    const requests = fetcher.mock.calls.length;
    expect(await model.navigateLocal(entries[1]!)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/people"); expect(fetcher).toHaveBeenCalledTimes(requests);
    route = "/people/17"; listener(); expect(model.getNavigation().activeKey).toBe("people");
    model.resetNavigation(); expect(model.getNavigation().entries).toEqual([]); model.dispose(); vi.unstubAllGlobals();
  });
});
