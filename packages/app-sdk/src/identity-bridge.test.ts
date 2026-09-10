import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effect: null as (() => (() => void)) | null, state: { kind: "recovering" } as { kind: string } }));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void)) => { hooks.effect = effect; },
  useRef: () => ({ current: null }),
  useState: () => [hooks.state, (state: { kind: string }) => { hooks.state = state; }],
}));
import { AppIdentityBridge } from "./react";

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
    const location = { href: "http://app.local/?code=one-time-code", reload };
    vi.stubGlobal("window", {
      location,
      history: { replaceState: (_state: unknown, _title: string, path: string) => {
        location.href = new URL(path, location.href).href;
      } },
      sessionStorage: { removeItem: vi.fn(), getItem: () => null },
      setTimeout, clearTimeout,
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("finishes one code exchange across the development effect replay before probing", async () => {
    const exchange = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(exchange.promise);
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
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
