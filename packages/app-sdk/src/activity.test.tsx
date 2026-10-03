// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIdentityBridge } from "./react";
import { appFetch, forgetAppGrant, appActivityNeedsRenewal, configureAppActivity, cancelActivityRenewal } from "./browser-auth";

afterEach(() => { cancelActivityRenewal(); forgetAppGrant(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("activity renewal", () => {
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
        recovery: { appId: "sample", corePublicOrigin: "http://core.localhost:7070" } });
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
  it("renews near expiry only for apps that need activity", () => {
    const cleanup = configureAppActivity({ openUrl: "http://core.localhost/open", activeUntil: new Date(1000).toISOString(), activityRequired: false, exchangeCode: async () => ({}) });
    expect(appActivityNeedsRenewal(0)).toBe(false); cleanup();
    const cleanup2 = configureAppActivity({ openUrl: "http://core.localhost/open", activeUntil: new Date(1000).toISOString(), activityRequired: true, exchangeCode: async () => ({}) });
    expect(appActivityNeedsRenewal(0)).toBe(true); expect(appActivityNeedsRenewal(-3600_000)).toBe(false); cleanup2();
  });
});
