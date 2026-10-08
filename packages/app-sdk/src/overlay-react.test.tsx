// @vitest-environment jsdom
import { act, Activity, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostyOverlay } from "./react";
import { appFetch, cancelActivityRenewal, forgetAppGrant, APP_SESSION_ENDED, APP_SESSION_RESTORED } from "./browser-auth";

const core = "http://overlay-core.localhost:7070";
const recovery = { appId: "sample", corePublicOrigin: core, appAuthProtocol: 2 };
function active(setup = "ready", userId = "alice", admin = false) {
  return { status: "active", userId, hostRole: admin ? "host.admin" : "host.user", recovery,
    activeUntil: new Date(Date.now() + 3600_000).toISOString(), activityRequired: false,
    hosty: { version: 1, setup, ...(admin ? { notice: { hostRole: "host.admin", appId: "sample", corePublicOrigin: core,
      permissions: { required: ["apps.read"], optional: [], granted: setup === "ready" ? ["apps.read"] : [] } } } : {}) } };
}
let root: Root;
let node: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) {
    if (!this.isConnected) throw new DOMException("The dialog is not connected to a document.", "InvalidStateError");
    this.setAttribute("open", "");
  } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); cancelActivityRenewal(); forgetAppGrant();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear();
});
async function render(children: ReactNode = <input aria-label="Draft" defaultValue="Unsaved work" />) {
  await act(async () => root.render(<StrictMode><HostyOverlay>{children}</HostyOverlay></StrictMode>));
}

describe("HostyOverlay", () => {
  it("opens only the connected portal after layout effects resume with retained state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(active("missing"))));
    const renderMode = (mode: "visible" | "hidden") => act(async () => root.render(
      <StrictMode><Activity mode={mode}><HostyOverlay><input /></HostyOverlay></Activity></StrictMode>));
    await renderMode("visible");
    expect(document.querySelector("dialog[open]")?.isConnected).toBe(true);
    await renderMode("hidden");
    expect(document.querySelector("[data-hosty-overlay-portal]")).toBeNull();
    await renderMode("visible");
    expect(document.querySelectorAll("[data-hosty-overlay-portal]")).toHaveLength(1);
    expect(document.querySelector("dialog[open]")?.isConnected).toBe(true);
  });
  it("never mounts protected content before the combined identity and setup result", async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let mounts = 0;
    function App() { useEffect(() => { mounts++; }, []); return <input />; }
    await render(<App />);
    expect(mounts).toBe(0); expect(node.querySelector("input")).toBeNull();
    await act(async () => resolve(Response.json(active("missing"))));
    expect(mounts).toBe(0); expect(document.body.textContent).toContain("configuration by an administrator");
    expect(document.querySelector("dialog button")).toBeNull();
  });
  it.each(["missing", "unsupported", "incompatible", "unavailable"])("blocks %s setup without revealing app content", async setup => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(active(setup)))); await render();
    expect(node.querySelector("input")).toBeNull(); expect(document.querySelector("dialog[open]")).not.toBeNull();
  });
  it("keeps the administrator review in Core and refreshes on return", async () => {
    let setup = "missing";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(active(setup, "alice", true))));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render();
    await act(async () => document.querySelector<HTMLButtonElement>("dialog button")!.click());
    expect(open).toHaveBeenCalledWith(`${core}/install/permissions/sample`, "_blank", "noopener,noreferrer");
    expect(document.querySelector("dialog a")?.getAttribute("href")).toContain("/install/permissions/sample");
    setup = "ready";
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(node.querySelector("input")?.value).toBe("Unsaved work");
    expect(document.querySelector("dialog")).toBeNull();
  });
  it.each([new Date(0).toISOString(), "invalid"])("does not mount content with an expired or unknown privileged deadline (%s)", async activeUntil => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(), activityRequired: true, activeUntil })));
    await render();
    expect(node.querySelector("input")).toBeNull();
    expect(document.body.textContent).toContain("Renew access to continue");
  });
  it.each(["future", "expired", "invalid"])("blocks activity-gated content without a renewal protocol (%s deadline)", async deadline => {
    const activeUntil = deadline === "future" ? new Date(Date.now() + 3600000).toISOString()
      : deadline === "expired" ? new Date(0).toISOString() : "invalid";
    let protocol: number | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(), activityRequired: true, activeUntil,
      recovery: { ...recovery, appAuthProtocol: protocol } })));
    await render();
    expect(node.querySelector("input")).toBeNull();
    expect(document.body.textContent).toContain("Cannot verify access renewal");
    expect(document.querySelector("dialog button")?.textContent).toBe("Retry");
    await act(async () => window.dispatchEvent(new Event(APP_SESSION_ENDED)));
    expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
    protocol = 2;
    await act(async () => document.querySelector<HTMLButtonElement>("dialog button")!.click());
    if (deadline === "future") {
      expect(node.querySelector("input")?.value).toBe("Unsaved work");
      expect(document.querySelector("dialog")).toBeNull();
    } else {
      expect(node.querySelector("input")).toBeNull();
      expect(document.body.textContent).toContain("Renew access to continue");
    }
  });
  it("does not require renewal metadata for an activity-ungated session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(),
      recovery: { ...recovery, appAuthProtocol: null } })));
    await render();
    expect(node.querySelector("input")?.value).toBe("Unsaved work");
    expect(document.querySelector("dialog")).toBeNull();
  });
  it("tracks the privileged deadline while renewal discovery is unavailable", async () => {
    const activeUntil = new Date(Date.now() + 100).toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(), activityRequired: true, activeUntil,
      recovery: { ...recovery, appAuthProtocol: null } })));
    const ended = vi.fn(); window.addEventListener(APP_SESSION_ENDED, ended);
    try {
      await render();
      await act(async () => { await new Promise(done => setTimeout(done, 130)); });
      expect(ended).toHaveBeenCalledTimes(1);
      expect(node.querySelector("input")).toBeNull();
    } finally { window.removeEventListener(APP_SESSION_ENDED, ended); }
  });
  it.each([null, 1, 3])("hides retained content when a fresh probe loses compatible renewal metadata (%s)", async missingProtocol => {
    let protocol: number | null = 2;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(), activityRequired: true,
      recovery: { ...recovery, appAuthProtocol: protocol } })));
    await render(); const draft = node.querySelector("input"); expect(draft).not.toBeNull();
    protocol = missingProtocol;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(node.querySelector("input")).toBe(draft);
    expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
    expect(document.body.textContent).toContain("Cannot verify access renewal");
    protocol = 2;
    await act(async () => document.querySelector<HTMLButtonElement>("dialog button")!.click());
    expect(document.querySelector("dialog")).toBeNull(); expect(node.querySelector("input")).toBe(draft);
  });
  it("blocks a known activity deadline even without a failed app request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...active(), activityRequired: true, activeUntil: new Date(Date.now() + 100).toISOString() })));
    await render(); const draft = node.querySelector("input"); expect(draft).not.toBeNull();
    await act(async () => { await new Promise(done => setTimeout(done, 130)); });
    expect(node.querySelector("input")).toBe(draft);
    expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
    expect(document.body.textContent).toContain("Renew access to continue");
  });
  it("retains the mounted tree through a Core outage and restores it after retry", async () => {
    let offline = false;
    vi.stubGlobal("fetch", vi.fn(async () => { if (offline) throw new Error("offline"); return Response.json(active()); }));
    await render(); const draft = node.querySelector("input");
    offline = true; await act(async () => window.dispatchEvent(new Event("focus")));
    expect(document.body.textContent).toContain("Cannot reach Hosty");
    expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
    offline = false; await act(async () => document.querySelector<HTMLButtonElement>("dialog button")!.click());
    expect(document.querySelector("dialog")).toBeNull(); expect(node.querySelector("input")).toBe(draft);
  });
  it("hides app portals, restores existing inert state and never drops the mounted input on expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(active()))); await render();
    const input = node.querySelector("input")!;
    const portal = document.createElement("div"); portal.textContent = "App dialog"; document.body.append(portal);
    await act(async () => window.dispatchEvent(new Event(APP_SESSION_ENDED)));
    expect(node.querySelector("input")).toBe(input);
    expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
    expect(portal.inert).toBe(true);
    expect(document.documentElement.hasAttribute("data-hosty-overlay-blocked")).toBe(true);
    await act(async () => root.unmount());
    expect(portal.inert).toBeFalsy(); portal.remove();
  });
  it.each([
    { changed: false, cookieOnly: false, awaitingSetup: false, awaitingRecovery: false },
    { changed: true, cookieOnly: false, awaitingSetup: false, awaitingRecovery: false },
    { changed: false, cookieOnly: true, awaitingSetup: false, awaitingRecovery: false },
    { changed: false, cookieOnly: false, awaitingSetup: true, awaitingRecovery: false },
    { changed: false, cookieOnly: false, awaitingSetup: false, awaitingRecovery: true },
  ])("validates actor, setup and renewal metadata before retrying mutations ($changed, cookieOnly=$cookieOnly, awaitingSetup=$awaitingSetup, awaitingRecovery=$awaitingRecovery)", async ({ changed, cookieOnly, awaitingSetup, awaitingRecovery }) => {
    const actualWindow = window;
    const reload = vi.fn();
    const location = Object.assign(new URL(actualWindow.location.href), { reload });
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) {
      if (key === "location") return location;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }));
    const popup = { closed: false, close: vi.fn(), document: document.implementation.createHTMLDocument("Core popup") };
    vi.spyOn(actualWindow, "open").mockReturnValue(popup as unknown as Window);
    const forms: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function () { forms.push(this.cloneNode(true) as HTMLFormElement); });
    let renewed = false; let writes = 0; let setupReady = !awaitingSetup; let recoveryReady = !awaitingRecovery;
    const fetcher = vi.fn(async (input: unknown) => {
      if (input === "/api/hosty/session") return Response.json({
        ...active(renewed && !setupReady ? "missing" : "ready", renewed && changed ? "bob" : "alice"),
        activityRequired: true, recovery: { ...recovery, appAuthProtocol: renewed && !recoveryReady ? null : 2 },
      });
      if (input === "/api/auth/app-code") { renewed = true; return Response.json({ ...(!cookieOnly ? { accessToken: "hostyg_renewed" } : {}), activeUntil: new Date(Date.now() + 3600000).toISOString() }); }
      if (input === "/api/write") { writes++; return renewed ? Response.json({ ok: true }) : Response.json({ code: "reauth_required" }, { status: 401 }); }
      throw new Error(String(input));
    }); vi.stubGlobal("fetch", fetcher);
    const restored = vi.fn(); actualWindow.addEventListener(APP_SESSION_RESTORED, restored);
    await render();
    const draft = node.querySelector("input")!;
    let response!: Promise<Response>;
    await act(async () => { response = appFetch("/api/write", { method: "POST", body: "old-user-work" }); await new Promise(done => setTimeout(done, 0)); });
    await act(async () => document.querySelector<HTMLButtonElement>("dialog button")!.click());
    const backgroundWrite = appFetch("/api/write", { method: "POST", body: "retained-effect" });
    expect(writes).toBe(1);
    const state = forms[0].querySelector<HTMLInputElement>('input[name="state"]')!.value;
    await act(async () => {
      actualWindow.dispatchEvent(new MessageEvent("message", { origin: core, source: popup as unknown as Window,
        data: { type: "hosty:app-auth-code", state, code: "renewed" } }));
      expect((await response).status).toBe(changed || awaitingSetup || awaitingRecovery ? 401 : 200);
      expect((await backgroundWrite).status).toBe(changed || awaitingSetup || awaitingRecovery ? 401 : 200);
    });
    expect(writes).toBe(changed || awaitingSetup || awaitingRecovery ? 1 : 3);
    expect(reload).toHaveBeenCalledTimes(changed ? 1 : 0);
    expect(restored).toHaveBeenCalledTimes(changed || awaitingSetup || awaitingRecovery ? 0 : 1);
    if (awaitingSetup || awaitingRecovery) {
      expect(document.body.textContent).toContain(awaitingRecovery ? "Cannot verify access renewal" : "configuration by an administrator");
      expect(node.querySelector("[data-hosty-content]")?.hasAttribute("hidden")).toBe(true);
      setupReady = true; recoveryReady = true;
      await act(async () => actualWindow.dispatchEvent(new Event("focus")));
      expect(restored).toHaveBeenCalledTimes(1);
      expect(writes).toBe(1); // Failed mutations are not silently replayed by a later readiness refresh.
    }
    if (!changed) { expect(draft.isConnected).toBe(true); expect(node.querySelector("input")).toBe(draft); expect(draft.value).toBe("Unsaved work"); expect(document.querySelector("dialog")).toBeNull(); }
    actualWindow.removeEventListener(APP_SESSION_RESTORED, restored);
  });
});
