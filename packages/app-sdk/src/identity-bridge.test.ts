import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effect: null as (() => (() => void)) | null, state: { kind: "recovering" } as { kind: string } }));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void)) => { hooks.effect = effect; },
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: { kind?: string }) => [initial?.kind ? hooks.state : null, (state: { kind: string }) => { if (state.kind) hooks.state = state; }],
}));
import { AppIdentityBridge } from "./react";
import { APP_GRANT_STORAGE_KEY, APP_SESSION_ENDED, appFetch, forgetAppGrant, rememberAppGrant } from "./browser-auth";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Replay the exact setup → cleanup → setup sequence React Strict Mode uses in development.
// Run the real bridge effect with browser I/O stubbed, keeping refs across effect setups.
describe("AppIdentityBridge launch exchange", () => {
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    hooks.state = { kind: "recovering" };
    reload = vi.fn();
    const location = { origin: "http://app.local", href: "http://app.local/?code=one-time-code", reload };
    vi.stubGlobal("window", {
      location,
      history: { replaceState: (_state: unknown, _title: string, path: string) => {
        location.href = new URL(path, location.href).href;
      } },
      sessionStorage: { removeItem: vi.fn(), getItem: () => null },
      setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("finishes one code exchange across the development effect replay before probing", async () => {
    const exchange = deferredResponse();
    const fetchMock = vi.fn().mockReturnValueOnce(exchange.promise).mockResolvedValue(new Response(JSON.stringify({ status: "active" })));
    vi.stubGlobal("fetch", fetchMock);
    AppIdentityBridge();
    const cleanup = hooks.effect!();
    cleanup();
    const cleanupReplay = hooks.effect!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/app-code");
    expect(init.body).toBe(JSON.stringify({ code: "one-time-code" }));
    expect(init.signal?.aborted ?? false).toBe(false);
    expect(window.location.href).not.toContain("code=");

    exchange.resolve(new Response("{}", { status: 200 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(reload).not.toHaveBeenCalled();
    cleanupReplay();
  });

  it.each(["rejected", "network"])("recovers once after a %s exchange across replay", async (failure) => {
    const exchange = deferredResponse();
    const fetchMock = vi.fn().mockReturnValueOnce(exchange.promise).mockResolvedValue(
      new Response(JSON.stringify({ status: "active", recovery: { appId: "hosty.marketplace" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    AppIdentityBridge();
    hooks.effect!()();
    const cleanupReplay = hooks.effect!();
    if (failure === "network") exchange.reject(new TypeError("Network error"));
    else exchange.resolve(new Response("{}", { status: 401 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/identity");
    expect(reload).not.toHaveBeenCalled();
    cleanupReplay();
  });

  it("does not reload after the bridge has actually unmounted", async () => {
    const exchange = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(exchange.promise));
    AppIdentityBridge();
    hooks.effect!()();
    exchange.resolve(new Response("{}", { status: 200 }));
    await exchange.promise;
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });
  it("keeps app-owned content in recovery until an active session is verified", async () => {
    window.location.href = "http://app.local/";
    const probe = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(probe.promise));
    const renderState = vi.fn(() => null);
    AppIdentityBridge({ renderState });
    expect(renderState).toHaveBeenLastCalledWith({ kind: "recovering" });
    const cleanup = hooks.effect!();
    probe.resolve(new Response(JSON.stringify({ status: "active", recovery: { appId: "hosty.marketplace" } })));
    await vi.waitFor(() => expect(hooks.state.kind).toBe("active"));
    AppIdentityBridge({ renderState });
    expect(renderState).toHaveBeenLastCalledWith({ kind: "active" });
    cleanup();
  });

  it.each(["forbidden", "unavailable", "misconfigured"])("never exposes active content after a %s probe", async (status) => {
    window.location.href = "http://app.local/";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status, recovery: { appId: "hosty.marketplace" } }))));
    AppIdentityBridge({ renderState: () => null });
    const cleanup = hooks.effect!();
    await vi.waitFor(() => expect(hooks.state.kind).not.toBe("recovering"));
    expect(hooks.state.kind).not.toBe("active");
    cleanup();
  });

});

describe("AppIdentityBridge embedded sign-in", () => {
  const state = "a".repeat(64);
  const appId = "sample";
  const recovery = { appId, corePublicOrigin: "http://core.localhost" };
  let stored: Map<string, string>;
  let browser: EventTarget & { location: URL & { replace: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn> } };
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    hooks.state = { kind: "recovering" };
    stored = new Map();
    const location = Object.assign(new URL("http://app.localhost/draft?topic=one#draft"), { replace: vi.fn(), assign: vi.fn() });
    browser = Object.assign(new EventTarget(), { location,
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key) },
      history: { replaceState: (_state: unknown, _title: string, path: string) => { location.href = new URL(path, location.href).href; } },
      setTimeout, clearTimeout,
    });
    Object.assign(browser, { self: browser, top: {} });
    vi.stubGlobal("window", browser);
    forgetAppGrant();
  });
  afterEach(() => { cleanup?.(); cleanup = undefined; forgetAppGrant(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function mount() { AppIdentityBridge({ renderState: () => null }); cleanup = hooks.effect!(); }
  function probe(status: string, extra = {}) {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ status, recovery, ...extra }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it.each(["not-present", "expired"])("silently replaces the frame on its initial %s probe once per tab", async status => {
    probe(status); mount();
    await vi.waitFor(() => expect(browser.location.replace).toHaveBeenCalledTimes(1));
    const url = new URL(browser.location.replace.mock.calls[0][0]);
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("redirectUri")).toBe("http://app.localhost/draft?topic=one");
    expect(stored.get("hosty.auth.silent-state")).toBe(url.searchParams.get("state"));
    expect(stored.get(`hosty.auth.silent-attempted:${appId}`)).toBe("1");
    cleanup!(); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(browser.location.replace).toHaveBeenCalledTimes(1);
  });

  it("restores a stored grant before probing and never silently navigates with it", async () => {
    stored.set(APP_GRANT_STORAGE_KEY, "restored-grant");
    const fetcher = probe("expired"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe("Bearer restored-grant");
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it.each(["active", "forbidden", "unavailable", "misconfigured"])("does not silently navigate on %s", async status => {
    probe(status); mount();
    await vi.waitFor(() => expect(hooks.state.kind).not.toBe("recovering"));
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it("keeps standalone recovery on its existing navigation path", async () => {
    Object.assign(browser, { top: browser });
    probe("not-present"); mount();
    await vi.waitFor(() => expect(browser.location.assign).toHaveBeenCalledTimes(1));
    expect(browser.location.replace).not.toHaveBeenCalled();
    expect(new URL(browser.location.assign.mock.calls[0][0]).searchParams.has("prompt")).toBe(false);
  });

  it("uses the button if Core cannot be reached from this app origin", async () => {
    probe("not-present", { recovery: { appId, corePublicOrigin: null } }); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it("does not navigate when storage is blocked", async () => {
    Object.assign(browser, { sessionStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    probe("not-present"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it("exchanges a silent code only with the pending state and persists its grant", async () => {
    browser.location.href = `http://app.localhost/draft?code=app-code&state=${state}`;
    stored.set("hosty.auth.silent-state", state);
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    const fetcher = vi.fn().mockImplementation(async path => path === "/api/auth/app-code"
      ? Response.json({ accessToken: "embedded-grant" }) : Response.json({ status: "active", recovery }));
    vi.stubGlobal("fetch", fetcher); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("active"));
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth/app-code");
    expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify({ code: "app-code" }));
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("embedded-grant");
    expect(stored.has("hosty.auth.silent-state")).toBe(false);
    expect(browser.location.search).toBe("");
  });

  it.each([null, "wrong-state"])("ignores a code with %s state", async returnedState => {
    browser.location.href = `http://app.localhost/?code=injected${returnedState ? `&state=${returnedState}` : ""}`;
    stored.set("hosty.auth.silent-state", state);
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    const fetcher = probe("not-present"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth/identity");
    expect(browser.location.replace).not.toHaveBeenCalled();
    expect(browser.location.search).toBe("");
  });

  it.each([["login_required", "signin"], ["access_denied", "denied"]])("renders the %s fallback without another navigation", async (error, kind) => {
    browser.location.href = `http://app.localhost/?error=${error}&state=${state}`;
    stored.set("hosty.auth.silent-state", state);
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    probe("not-present"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe(kind));
    if (kind === "signin") expect((hooks.state as { signIn?: unknown }).signIn).toBeTypeOf("function");
    expect(browser.location.replace).not.toHaveBeenCalled();
    expect(browser.location.search).toBe("");
  });

  it("allows a popup sign-in after login_required and then activates the verified session", async () => {
    browser.location.href = `http://app.localhost/?error=login_required&state=${state}`;
    stored.set("hosty.auth.silent-state", state);
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    const popup = { closed: false, close: vi.fn() };
    const open = vi.fn(() => popup); Object.assign(browser, { open });
    const fetcher = vi.fn().mockImplementation(async path => path === "/api/auth/app-code"
      ? Response.json({ accessToken: "popup-grant" }) : Response.json({ status: "active", recovery }));
    vi.stubGlobal("fetch", fetcher); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    (hooks.state as { signIn?: () => void }).signIn!();
    const popupUrl = new URL(open.mock.calls[0][0]);
    const message = new Event("message");
    Object.assign(message, { source: popup, origin: popupUrl.origin, data: { type: "hosty:app-auth-code", state: popupUrl.searchParams.get("state"), code: "popup-code" } });
    browser.dispatchEvent(message);
    await vi.waitFor(() => expect(hooks.state.kind).toBe("active"));
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("popup-grant");
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it.each([null, "wrong-state"])("ignores a denied response with %s state", async returnedState => {
    browser.location.href = `http://app.localhost/?error=access_denied${returnedState ? `&state=${returnedState}` : ""}`;
    stored.set("hosty.auth.silent-state", state);
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    probe("not-present"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
  });

  it.each(["top-level", "nested"])("clears a rejected grant from a %s identity response even with HTTP 200", async shape => {
    stored.set(APP_GRANT_STORAGE_KEY, "rejected-grant");
    const error = { code: "token_revoked" };
    probe("expired", shape === "nested" ? { status: undefined, appSession: { status: "expired", error } } : { error }); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(stored.has(APP_GRANT_STORAGE_KEY)).toBe(false);
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a newer grant when an old rejection returns (cancelled=%s)", async cancelled => {
    stored.set(APP_GRANT_STORAGE_KEY, "old-grant");
    const oldProbe = deferredResponse();
    const fetcher = vi.fn().mockReturnValueOnce(oldProbe.promise).mockImplementation(path => Promise.resolve(
      path === "/api/auth/identity" ? Response.json({ status: "active", recovery }) : Response.json({})));
    vi.stubGlobal("fetch", fetcher); mount();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    if (cancelled) cleanup!();
    rememberAppGrant("new-grant");
    oldProbe.resolve(Response.json({ status: "expired", error: { code: "token_revoked" }, recovery }));
    await oldProbe.promise;
    if (!cancelled) await vi.waitFor(() => expect(hooks.state.kind).toBe("active"));
    else await Promise.resolve();
    expect(stored.get(APP_GRANT_STORAGE_KEY)).toBe("new-grant");
    await appFetch("/api/data");
    expect(fetcher.mock.calls.at(-1)![1].headers.get("authorization")).toBe("Bearer new-grant");
  });

  it("does not loop while probing a rejected cookie without a current app grant", async () => {
    stored.set(`hosty.auth.silent-attempted:${appId}`, "1");
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ status: "expired", code: "token_invalid", recovery }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not silently redirect after the initial probe completes or after a mounted session ends", async () => {
    const fetcher = probe("unavailable"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("unavailable"));
    fetcher.mockImplementation(async () => Response.json({ status: "not-present", recovery }));
    browser.dispatchEvent(new Event(APP_SESSION_ENDED));
    await vi.waitFor(() => expect(hooks.state.kind).toBe("signin"));
    expect(browser.location.replace).not.toHaveBeenCalled();
    cleanup!();
    probe("active"); mount();
    await vi.waitFor(() => expect(hooks.state.kind).toBe("active"));
    browser.dispatchEvent(new Event(APP_SESSION_ENDED));
    expect(browser.location.replace).not.toHaveBeenCalled();
    expect(hooks.state.kind).toBe("active");
  });
});
