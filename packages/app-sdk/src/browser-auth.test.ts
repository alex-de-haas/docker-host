import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appFetch, configureAppActivity, forgetAppGrant, restoreAppGrant, openAppSignIn, rememberAppGrant, appCodeChallenge, NATIVE_APP_AUTH_RESULT, APP_SESSION_ENDED, APP_GRANT_STORAGE_KEY } from "./browser-auth";

let browser: EventTarget & { location: URL; open: ReturnType<typeof vi.fn>; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
let popup: { close: ReturnType<typeof vi.fn> };
beforeEach(() => {
  popup = { close: vi.fn() };
  browser = Object.assign(new EventTarget(), { location: new URL("http://app.localhost/page"),
    open: vi.fn(() => popup), setTimeout, clearTimeout });
  vi.stubGlobal("window", browser);
  forgetAppGrant();
});
afterEach(() => { forgetAppGrant(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function message(origin: string, source: unknown, state: string) {
  const event = new Event("message");
  Object.assign(event, { origin, source, data: { type: "hosty:app-auth-code", state, code: "one-use-code" } });
  browser.dispatchEvent(event);
}

describe("app-owned popup", () => {
  it("accepts only the exact Core origin, initiation state and opened window, once", async () => {
    const result = openAppSignIn("http://core.localhost/api/apps/example/open?redirectUri=http%3A%2F%2Fapp.localhost%2F", undefined, 1);
    const url = new URL(browser.open.mock.calls[0][0]);
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("responseMode")).toBe("web_message");
    message("http://evil.localhost", popup, state);
    message(url.origin, {}, state);
    message(url.origin, popup, "wrong");
    expect(popup.close).not.toHaveBeenCalled();
    message(url.origin, popup, state);
    expect(await result).toMatchObject({ code: "one-use-code", codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    message(url.origin, popup, state);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("rejects a blocked popup and permits a new attempt", async () => {
    browser.open.mockReturnValueOnce(null);
    await expect(openAppSignIn("http://core.localhost/api/apps/example/open?redirectUri=http%3A%2F%2Fapp.localhost%2F", undefined, 1)).rejects.toThrow("Allow the sign-in popup");
    const controller = new AbortController();
    const next = openAppSignIn("http://core.localhost/api/apps/example/open?redirectUri=http%3A%2F%2Fapp.localhost%2F", controller.signal, 1);
    controller.abort();
    await expect(next).rejects.toThrow("cancelled");
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});

describe("native in-place sign-in", () => {
  const openUrl = "http://native-core.localhost/api/apps/example/open?redirectUri=http%3A%2F%2Fapp.localhost%2Fpage";
  const resultEvent = (detail: unknown) => browser.dispatchEvent(Object.assign(new Event(NATIVE_APP_AUTH_RESULT), { detail }));

  it("keeps proof only in memory and accepts one exact-state public result without a popup", async () => {
    const assign = vi.fn(); Object.assign(browser.location, { assign });
    const getItem = vi.fn(() => { throw new Error("blocked"); });
    Object.assign(browser, { sessionStorage: { getItem, setItem: getItem } });
    const operation = openAppSignIn(openUrl, undefined, 2, true);
    expect(browser.open).not.toHaveBeenCalled(); expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0][0]);
    const state = url.searchParams.get("state")!;
    expect([...url.searchParams.keys()].sort()).toEqual(["codeChallenge", "codeChallengeMethod", "redirectUri", "responseMode", "state"]);
    expect(url.searchParams.get("responseMode")).toBe("web_message");
    expect(new URL(url.searchParams.get("redirectUri")!).searchParams.get("state")).toBe(state);
    let settled = false; void operation.then(() => { settled = true; });
    resultEvent({ state: "wrong", code: "injected" }); resultEvent({ state, code: "x".repeat(4097) });
    await Promise.resolve(); expect(settled).toBe(false);
    resultEvent({ state, code: "public-code", codeVerifier: "attacker" });
    const result = await operation;
    expect(result.code).toBe("public-code"); expect(result.codeVerifier).not.toBe("attacker");
    expect(appCodeChallenge(result.codeVerifier)).toBe(url.searchParams.get("codeChallenge"));
    expect(url.href).not.toContain(result.codeVerifier);
  });

  it.each(["abort", "logout", "refused", "timeout"])("discards memory proof on %s and ignores late delivery", async kind => {
    vi.useFakeTimers();
    Object.assign(browser, { setTimeout, clearTimeout });
    const assign = vi.fn(); Object.assign(browser.location, { assign });
    const controller = new AbortController();
    const operation = openAppSignIn(openUrl, controller.signal, 2, true);
    const refused = expect(operation).rejects.toThrow(kind === "refused" ? "could not authorize" : kind === "timeout" ? "timed out" : "cancelled");
    const state = new URL(assign.mock.calls[0][0]).searchParams.get("state");
    if (kind === "abort") controller.abort();
    if (kind === "logout") forgetAppGrant();
    if (kind === "refused") resultEvent({ state, error: { code: "access_denied", message: "server detail" } });
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(180_000);
    resultEvent({ state, code: "late-code" });
    await refused;
    expect(browser.open).not.toHaveBeenCalled();
  });
});

describe("in-memory app transport", () => {
  it("attaches the grant only to the same origin and refuses redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    rememberAppGrant("app-only-grant");
    await appFetch("/api/data");
    expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe("Bearer app-only-grant");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    await expect(appFetch("http://foreign.localhost/api")).rejects.toThrow("this app's origin");
    await expect(appFetch("http://app.localhost:99/api")).rejects.toThrow("this app's origin");
    expect(fetcher).toHaveBeenCalledTimes(1);
    forgetAppGrant();
    await appFetch("/api/data");
    expect(fetcher.mock.calls[1][1].headers.has("authorization")).toBe(false);
  });
  it("retains the grant during outages and requests recovery after a 401", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    const ended = vi.fn(); browser.addEventListener(APP_SESSION_ENDED, ended);
    rememberAppGrant("grant");
    await appFetch("/api/data"); expect(ended).not.toHaveBeenCalled();
    await appFetch("/api/data"); expect(ended).toHaveBeenCalledTimes(1);
    await appFetch("/api/data"); expect(fetcher.mock.calls[2][1].headers.has("authorization")).toBe(false);
  });
});

describe("embedded per-tab app grants", () => {
  let stored: Map<string, string>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    stored = new Map();
    storage = { getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)), removeItem: vi.fn((key: string) => stored.delete(key)) };
    Object.assign(browser, { self: browser, top: {}, sessionStorage: storage });
  });

  it("persists only while embedded and restores before an app request", async () => {
    rememberAppGrant("embedded-grant");
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("embedded-grant");
    forgetAppGrant();
    expect(stored.has(APP_GRANT_STORAGE_KEY)).toBe(false);
    stored.set(APP_GRANT_STORAGE_KEY, "restored-grant");
    expect(restoreAppGrant()).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal("fetch", fetcher);
    await appFetch("/api/data");
    expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe("Bearer restored-grant");
  });

  it("neither reads nor writes the stored grant in a standalone document", () => {
    Object.assign(browser, { top: browser });
    stored.set(APP_GRANT_STORAGE_KEY, "old-grant");
    expect(restoreAppGrant()).toBe(false);
    rememberAppGrant("standalone-grant");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("old-grant");
  });

  it.each(["token_invalid", "token_revoked", "token_expired", "token_app_mismatch"])("clears %s even when a probe disables recovery", async code => {
    rememberAppGrant("rejected-grant");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code }, { status: code === "token_app_mismatch" ? 403 : 401 }))
      .mockResolvedValue(Response.json({})); vi.stubGlobal("fetch", fetcher);
    await appFetch("/api/auth/identity", {}, false);
    expect(stored.has(APP_GRANT_STORAGE_KEY)).toBe(false);
    await appFetch("/api/data");
    expect(fetcher.mock.calls[1][1].headers.has("authorization")).toBe(false);
  });

  it("retains the grant for activity expiry and replaces it after renewal", async () => {
    rememberAppGrant("identity-grant");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: "reauth_required" }, { status: 401 }))
      .mockResolvedValue(Response.json({})); vi.stubGlobal("fetch", fetcher);
    await appFetch("/api/protected");
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("identity-grant");
    await appFetch("/api/data");
    expect(fetcher.mock.calls[1][1].headers.get("authorization")).toBe("Bearer identity-grant");
    rememberAppGrant("renewed-grant");
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("renewed-grant");
  });

  it("retains identity after an ordinary permission denial", async () => {
    rememberAppGrant("identity-grant");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "permission_denied" }, { status: 403 })));
    await appFetch("/api/protected");
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("identity-grant");
  });

  it("clears a mismatched grant but keeps 403 terminal even during an active user gesture", async () => {
    rememberAppGrant("mismatched-grant");
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    browser.open.mockReturnValue(null);
    const exchangeCode = vi.fn();
    const cleanup = configureAppActivity({ appAuthProtocol: 1, openUrl: "http://core.localhost/open", exchangeCode });
    const ended = vi.fn(); browser.addEventListener(APP_SESSION_ENDED, ended);
    const denied = Response.json({ code: "token_app_mismatch" }, { status: 403 });
    const fetcher = vi.fn().mockResolvedValue(denied); vi.stubGlobal("fetch", fetcher);
    try {
      expect(await appFetch("/api/protected")).toBe(denied);
      expect(stored.has(APP_GRANT_STORAGE_KEY)).toBe(false);
      expect(restoreAppGrant()).toBe(false);
      expect(ended).not.toHaveBeenCalled();
      expect(browser.open).not.toHaveBeenCalled();
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      browser.removeEventListener(APP_SESSION_ENDED, ended);
    }
  });

  it("keeps a renewed grant if an older rejection body finishes parsing later", async () => {
    rememberAppGrant("old-grant");
    let resolve!: (body: unknown) => void;
    const body = new Promise(done => { resolve = done; });
    const rejected = Response.json({}, { status: 401 });
    const clone = vi.spyOn(rejected, "clone").mockReturnValue({ json: () => body } as Response);
    const fetcher = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    const request = appFetch("/api/data", {}, false);
    await vi.waitFor(() => expect(clone).toHaveBeenCalled());
    rememberAppGrant("new-grant");
    resolve({ code: "token_revoked" });
    await request;
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("new-grant");
    await appFetch("/api/data");
    expect(fetcher.mock.calls[1][1].headers.get("authorization")).toBe("Bearer new-grant");
  });

  it("keeps the in-memory transport working when storage throws", async () => {
    for (const method of Object.values(storage)) method.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(restoreAppGrant()).toBe(false);
    expect(() => rememberAppGrant("memory-grant")).not.toThrow();
    const fetcher = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal("fetch", fetcher);
    await appFetch("/api/data");
    expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe("Bearer memory-grant");
    expect(() => forgetAppGrant()).not.toThrow();
    await appFetch("/api/data");
    expect(fetcher.mock.calls[1][1].headers.has("authorization")).toBe(false);
  });
});
