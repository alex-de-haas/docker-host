import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appFetch, forgetAppGrant, openAppSignIn, rememberAppGrant, APP_SESSION_ENDED } from "./browser-auth";

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
    const result = openAppSignIn("http://core.localhost/api/apps/example/open?redirectUri=http%3A%2F%2Fapp.localhost%2F");
    const url = new URL(browser.open.mock.calls[0][0]);
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("responseMode")).toBe("web_message");
    message("http://evil.localhost", popup, state);
    message(url.origin, {}, state);
    message(url.origin, popup, "wrong");
    expect(popup.close).not.toHaveBeenCalled();
    message(url.origin, popup, state);
    expect(await result).toBe("one-use-code");
    message(url.origin, popup, state);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("rejects a blocked popup and permits a new attempt", async () => {
    browser.open.mockReturnValueOnce(null);
    await expect(openAppSignIn("http://core.localhost/open")).rejects.toThrow("Allow the sign-in popup");
    const controller = new AbortController();
    const next = openAppSignIn("http://core.localhost/open", controller.signal);
    controller.abort();
    await expect(next).rejects.toThrow("cancelled");
    expect(popup.close).toHaveBeenCalledTimes(1);
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
