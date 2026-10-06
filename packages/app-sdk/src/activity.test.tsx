// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIdentityBridge } from "./react";
import { appFetch, forgetAppGrant, appActivityNeedsRenewal, configureAppActivity, cancelActivityRenewal, appCodeChallenge, renewAppActivity, NATIVE_APP_AUTH_RESULT } from "./browser-auth";

afterEach(() => { cancelActivityRenewal(); forgetAppGrant(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-hosty-launch"); });

describe("activity renewal", () => {
  it("keeps a native draft mounted while the host returns a memory-bound renewal result", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const actualWindow = window;
    const assign = vi.fn();
    const browser = Object.assign(new EventTarget(), { location: Object.assign(new URL(actualWindow.location.origin + "/draft"), { assign }),
      sessionStorage: actualWindow.sessionStorage, setTimeout: actualWindow.setTimeout.bind(actualWindow), clearTimeout: actualWindow.clearTimeout.bind(actualWindow), open: vi.fn() });
    Object.assign(browser, { self: browser, top: browser }); vi.stubGlobal("window", browser);
    document.documentElement.setAttribute("data-hosty-launch", "native");
    let mounts = 0;
    function Draft() { useEffect(() => { mounts++; }, []); return <input aria-label="Native draft" defaultValue="" />; }
    const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
    let renewed = false;
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      if (input === "/api/auth/identity") return Response.json({ status: "active", activityRequired: true, activeUntil: new Date(Date.now() - 1000).toISOString(),
        recovery: { appId: "native-sample", corePublicOrigin: "http://native-renewal.localhost:7070", appAuthProtocol: 2 } });
      if (input === "/api/auth/app-code") { renewed = true; return Response.json({ accessToken: "renewed-native-grant", activeUntil: new Date(Date.now() + 3600_000).toISOString() }); }
      return renewed ? Response.json({ ok: true }) : Response.json({ code: "reauth_required" }, { status: 401 });
    }); vi.stubGlobal("fetch", fetchMock);
    await act(async () => { root.render(<AppIdentityBridge><Draft /></AppIdentityBridge>); });
    const draft = node.querySelector("input")!; draft.value = "Unsaved native draft";
    let result!: Promise<Response>;
    await act(async () => { result = appFetch("/api/native-protected"); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { [...node.querySelectorAll("button")].find(button => button.textContent === "Renew access")!.click(); });
    expect(browser.open).not.toHaveBeenCalled(); expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0][0]);
    await act(async () => {
      browser.dispatchEvent(new CustomEvent(NATIVE_APP_AUTH_RESULT, { detail: { state: url.searchParams.get("state"), code: "native-code" } }));
      expect((await result).status).toBe(200);
    });
    const exchange = fetchMock.mock.calls.find(call => call[0] === "/api/auth/app-code")!;
    const proof = JSON.parse((exchange[1] as RequestInit).body as string);
    expect(proof.code).toBe("native-code"); expect(appCodeChallenge(proof.codeVerifier)).toBe(url.searchParams.get("codeChallenge"));
    expect(node.querySelector("input")).toBe(draft); expect(draft.value).toBe("Unsaved native draft"); expect(mounts).toBe(1);
    await act(async () => root.unmount()); node.remove();
  });
  it.each(["reauth_required", "token_expired"])("preserves the mounted draft for %s and retries once after a click popup", async code => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let mounts = 0;
    function Draft() { useEffect(() => { mounts++; }, []); return <input aria-label="Draft" defaultValue="" />; }
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const popup = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const fetchMock = vi.fn(async (input: unknown) => {
      if (input === "/api/auth/identity") return Response.json({ status: "active", activeUntil: new Date(Date.now() - 1000).toISOString(), activityRequired: true,
        recovery: { appId: "sample", corePublicOrigin: "http://core.localhost:7070", appAuthProtocol: 1 } });
      if (input === "/api/auth/app-code") return Response.json({ accessToken: "hostyg_renewed", activeUntil: new Date(Date.now() + 3600_000).toISOString() });
      return Response.json({ code }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => { root.render(<AppIdentityBridge><Draft /></AppIdentityBridge>); });
    const draft = node.querySelector("input")!; draft.value = "Unsaved conversation";
    let result!: Promise<Response>;
    await act(async () => { result = appFetch("/api/protected"); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(open).not.toHaveBeenCalled();
    expect(node.textContent).toContain("Renew access");
    expect(node.querySelector("input")).toBe(draft);
    await act(async () => { [...node.querySelectorAll("button")].find(b => b.textContent === "Renew access")!.click(); });
    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(String(open.mock.calls[0]![0]));
    fetchMock.mockImplementation(async input => input === "/api/auth/app-code"
      ? Response.json({ accessToken: "hostyg_renewed", activeUntil: new Date(Date.now() + 3600_000).toISOString() }) : Response.json({ ok: true }));
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: url.origin, source: popup as unknown as Window,
        data: { type: "hosty:app-auth-code", state: url.searchParams.get("state"), code: "fresh-code" } }));
      expect((await result).status).toBe(200);
    });
    expect(node.querySelector("input")).toBe(draft); expect(draft.value).toBe("Unsaved conversation"); expect(mounts).toBe(1);
    const calls = fetchMock.mock.calls.filter(c => c[0] === "/api/protected"); expect(calls).toHaveLength(2);
    await act(async () => root.unmount()); node.remove();
  });
  it("upgrades a pending legacy renewal in the same popup without unmounting the draft", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const coreOrigin = "https://mounted-upgrade.test";
    const popupLocation = { href: coreOrigin + "/old" };
    const popupDocument = document.implementation.createHTMLDocument();
    const popup = { location: popupLocation, closed: false, close: vi.fn(), get document() {
      if (popupLocation.href !== "about:blank") throw new DOMException("Cross-origin", "SecurityError");
      return popupDocument;
    } };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const forms: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function(this: HTMLFormElement) { forms.push(this); });
    let mounts = 0, metadataCalls = 0, renewed = false;
    function Draft() { useEffect(() => { mounts++; }, []); return <input aria-label="Upgrade draft" />; }
    const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
    const fetcher = vi.fn(async (input: unknown, _init?: RequestInit) => {
      if (input === "/api/auth/identity") return Response.json({ status: "active", activityRequired: true, activeUntil: new Date(Date.now() - 1000).toISOString(),
        recovery: { appId: "mounted-sample", corePublicOrigin: coreOrigin, appAuthProtocol: ++metadataCalls === 1 ? 1 : 2 } });
      if (input === "/api/auth/app-code") { renewed = true; return Response.json({ accessToken: "fresh-upgraded-grant", activeUntil: new Date(Date.now() + 3600_000).toISOString() }); }
      return renewed ? Response.json({ ok: true }) : Response.json({ code: "reauth_required" }, { status: 401 });
    }); vi.stubGlobal("fetch", fetcher);
    await act(async () => { root.render(<AppIdentityBridge><Draft /></AppIdentityBridge>); });
    const draft = node.querySelector("input")!; draft.value = "Keep this draft through upgrade";
    let request!: Promise<Response>;
    await act(async () => { request = appFetch("/api/protected-upgrade"); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { [...node.querySelectorAll("button")].find(button => button.textContent === "Renew access")!.click(); });
    const old = new URL(String(open.mock.calls[0][0]));
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: coreOrigin, source: popup as unknown as Window,
        data: { type: "hosty:app-auth-code", state: old.searchParams.get("state"), error: "protocol_required" } }));
      await vi.waitFor(() => expect(forms).toHaveLength(1));
    });
    expect(open).toHaveBeenCalledOnce(); expect(metadataCalls).toBe(2);
    const newState = forms[0].querySelector<HTMLInputElement>('input[name="state"]')!.value;
    const newChallenge = forms[0].querySelector<HTMLInputElement>('input[name="codeChallenge"]')!.value;
    expect(newState).not.toBe(old.searchParams.get("state")); expect(newChallenge).not.toBe(old.searchParams.get("codeChallenge"));
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: coreOrigin, source: popup as unknown as Window,
        data: { type: "hosty:app-auth-code", state: newState, code: "fresh-upgraded-code" } }));
      expect((await request).status).toBe(200);
    });
    const exchange = fetcher.mock.calls.find(call => call[0] === "/api/auth/app-code")!;
    const proof = JSON.parse((exchange[1] as RequestInit).body as string);
    expect(appCodeChallenge(proof.codeVerifier)).toBe(newChallenge);
    expect(node.querySelector("input")).toBe(draft); expect(draft.value).toBe("Keep this draft through upgrade"); expect(mounts).toBe(1);
    let next!: Promise<void>;
    await act(async () => { next = renewAppActivity(); });
    const cancelled = expect(next).rejects.toThrow("cancelled");
    expect(open.mock.calls[1][0]).toBe("about:blank"); expect(forms).toHaveLength(2);
    cancelActivityRenewal(); await cancelled;
    await act(async () => root.unmount()); node.remove();
  });

  it("renews near expiry only for apps that need activity", () => {
    const cleanup = configureAppActivity({ appAuthProtocol: 1, openUrl: "http://core.localhost/open", activeUntil: new Date(1000).toISOString(), activityRequired: false, exchangeCode: async () => ({}) });
    expect(appActivityNeedsRenewal(0)).toBe(false); cleanup();
    const cleanup2 = configureAppActivity({ appAuthProtocol: 1, openUrl: "http://core.localhost/open", activeUntil: new Date(1000).toISOString(), activityRequired: true, exchangeCode: async () => ({}) });
    expect(appActivityNeedsRenewal(0)).toBe(true); expect(appActivityNeedsRenewal(-3600_000)).toBe(false); cleanup2();
  });
});
