// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyPanelWorkspace, HostyUiRoot, HostyNavigationBoundary, useHostyUiHost } from "./ui-react";
import { createPresentationRequestId, ui } from "./ui";
import type { UiHost } from "./ui-host";
import type { UiBootstrap, UiPanel } from "./ui-types";
import { HostyAppFrame } from "./ui-frame";
vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
let root: Root, element: HTMLDivElement, host: UiHost | null;
let resize: () => void;
let catalogGate: Promise<void> | null;
let resolutionGate: Promise<void> | null;
let refuseResolution: boolean;
let listedPanels: UiPanel[];
const policy = { microphone: false, popupEscape: false };
const metadata: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "plans", installationId: "plans-1", origins: ["http://localhost:3000"] } };
const catalog: UiPanel[] = ["assistant", "notes"].map(id => ({ panel: { appId: id, installationId: `${id}-1`, panelId: "tool" },
  endpoint: "web", route: "/panel", origin: `https://${id}.test`, label: id, appName: id, icon: null, available: true, state: "running", canStart: false, framePolicy: policy }));
function Document() { host = useHostyUiHost(); return <textarea aria-label="Document draft" defaultValue="Keep this selection" />; }
beforeEach(() => {
  document.documentElement.removeAttribute("data-hosty-chrome-hints");
  catalogGate = null;
  resolutionGate = null;
  refuseResolution = false;
  listedPanels = catalog;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers = new Set<() => void>(); resize = () => { for (const callback of observers) callback(); };
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) {} observe() { observers.add(this.callback); } disconnect() { observers.delete(this.callback); } });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("bootstrap")) return Response.json(metadata);
    if (!path.endsWith("resolve")) { await catalogGate; return Response.json({ panels: listedPanels }); }
    const refused = refuseResolution;
    await resolutionGate;
    if (refused) return Response.json({ code: "access_unavailable" }, { status: 403 });
    const target = JSON.parse(init!.body as string), panel = listedPanels.find(p => p.panel.appId === target.panel.appId
      && p.panel.installationId === target.panel.installationId && p.panel.panelId === target.panel.panelId)!;
    return Response.json({ target: { ...target, route: target.route ?? panel.route }, available: panel.available, state: panel.state, standaloneHref: "https://core.test/open",
      surface: { appId: panel.panel.appId, installationId: panel.panel.installationId, endpoint: panel.endpoint,
        origin: panel.origin, route: target.route ?? panel.route, framePolicy: policy } });
  }));
  host = null; element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
it("retains iframe identity across same-panel instances and movement to another workspace", async () => {
  await act(async () => root.render(<HostyUiRoot panelLayout="slot">
    <HostyPanelWorkspace><Document /></HostyPanelWorkspace>
    <HostyPanelWorkspace workspaceId="floating" layout="dock"><span>Window</span></HostyPanelWorkspace>
  </HostyUiRoot>));
  await act(async () => host!.refresh());
  const target = { panel: catalog[0]!.panel, route: "/panel?session=one" };
  await act(async () => { await host!.openSurface(target, { placement: "side", requestId: createPresentationRequestId() }); });
  const first = host!.getSnapshot().tools[0]!, frame = element.querySelector("iframe")!, context = frame.contentWindow;
  const parent = frame.parentElement;
  await act(async () => { await host!.openSurface({ ...target, route: "/panel?session=two" }, { placement: "side", requestId: createPresentationRequestId() }); });
  expect(element.querySelectorAll("iframe")).toHaveLength(2);
  expect(element.querySelector('select[aria-label="Tool instance"]')?.children).toHaveLength(2);
  await act(async () => { expect(await host!.movePresentation(first.presentationId, "floating")).toBe(true); });
  expect(frame.parentElement).toBe(parent); expect(frame.contentWindow).toBe(context); expect(frame.isConnected).toBe(true);
  await act(async () => host!.setViewChrome("root", { tools: { enabled: false } }));
  expect(host!.getSnapshot().workspaces?.every(w => !w.expanded)).toBe(true); expect(element.querySelectorAll("iframe")).toHaveLength(2);
  await act(async () => host!.setViewChrome("root", {}));
  expect(host!.getSnapshot().workspaces?.every(w => !w.expanded)).toBe(true);
  await act(async () => host!.closePresentation(first.presentationId));
  expect(frame.isConnected).toBe(false); expect(element.querySelectorAll("iframe")).toHaveLength(1);
});
it("hides custom navigation without losing its component state or retaining keyboard focus", async () => {
  await act(async () => root.render(<HostyUiRoot navigation={{ renderer: "custom" }}>
    <HostyNavigationBoundary><input aria-label="Navigation state" defaultValue="Keep this" /></HostyNavigationBoundary><Document />
  </HostyUiRoot>));
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Navigation state"]')!;
  input.focus(); expect(document.activeElement).toBe(input);
  await act(async () => host!.setViewChrome("root", { navigation: "hide" }));
  expect(input.closest("[data-hosty-navigation-boundary]")?.hasAttribute("hidden")).toBe(true);
  expect(document.activeElement).toBe(element.querySelector("[data-hosty-content]"));
  await act(async () => host!.setViewChrome("root", {}));
  expect(element.querySelector("input")).toBe(input); expect(input.value).toBe("Keep this");
});
it("preserves view overrides through remounting and still applies explicit prop policy changes", async () => {
  const panel = catalog[0]!, surface = { ...panel.panel, endpoint: panel.endpoint, origin: panel.origin!, route: panel.route, framePolicy: policy };
  const show = (key: string, chrome = {}) => root.render(<HostyUiRoot panelLayout="none"><Document />
    <HostyAppFrame key={key} surface={surface} title="App" view={{ viewId: "stable-app", workspaceId: "default", chrome }} />
  </HostyUiRoot>);
  await act(async () => show("first"));
  const override = { navigation: "show" as const, tools: { enabled: false } };
  await act(async () => host!.setViewChrome("stable-app", override));
  await act(async () => show("replacement"));
  expect(host!.getViewChrome("stable-app")).toEqual(override);
  const url = new URL(element.querySelector("iframe")!.src);
  expect(url.searchParams.get("hosty_navigation")).toBe("show");
  expect(url.searchParams.get("hosty_tools")).toBe("disabled");
  await act(async () => show("replacement", { navigation: "hide" }));
  expect(host!.getViewChrome("stable-app")).toEqual({ navigation: "hide" });
});
it("acknowledges a visible chooser and does not reopen it when the request is replayed", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  await render(); const requestId = createPresentationRequestId();
  await act(async () => { expect(await ui.openToolPicker({ requestId })).toMatchObject({ status: "accepted" }); });
  const dialog = element.querySelector<HTMLDialogElement>("dialog.hosty-tool-chooser")!; expect(dialog.open).toBe(true);
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close tool chooser"]')!.click());
  expect(dialog.open).toBe(false);
  await act(async () => { expect(await ui.openToolPicker({ requestId })).toMatchObject({ status: "accepted" }); });
  expect(dialog.open).toBe(false);
});
it.each([600, 1200].flatMap(width => ["collapse", "policy"].map(reason => ({ width, reason }))))(
  "closes the picker on $reason at width $width and allows a fresh opening", async ({ width, reason }) => {
    vi.stubGlobal("innerWidth", width);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
    await render();
    await act(async () => { expect(await ui.openToolPicker({ requestId: createPresentationRequestId() })).toMatchObject({ status: "accepted" }); });
    const dialog = element.querySelector<HTMLDialogElement>("dialog.hosty-tool-chooser")!;
    expect(dialog.open).toBe(true);
    await act(async () => {
      if (reason === "policy") host!.setViewChrome("root", { tools: { enabled: false } });
      else host!.collapseWorkspace("default");
    });
    expect(dialog.open).toBe(false);
    await act(async () => host!.setViewChrome("root", {}));
    expect(dialog.open).toBe(false);
    await act(async () => { expect(await ui.openToolPicker({ requestId: createPresentationRequestId() })).toMatchObject({ status: "accepted" }); });
    expect(dialog.open).toBe(true);
  });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(layout: "auto" | "slot" | "none" = "auto") {
  await act(async () => root.render(<HostyUiRoot panelLayout={layout}>{layout === "slot" ? <HostyPanelWorkspace><Document /></HostyPanelWorkspace> : <Document />}</HostyUiRoot>));
  await act(async () => host!.refresh());
}
async function connectTool(frame: HTMLIFrameElement, post: ReturnType<typeof vi.spyOn>, userId = metadata.userId) {
  const origin = new URL(frame.src).origin;
  const tool = host!.getSnapshot().tools.find(t => t.resolved.surface?.origin === origin)!;
  const send = (data: object, eventOrigin = origin) => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: eventOrigin, data }));
  await act(async () => send({ type: "hosty:ui:probe", version: 1, versions: [1], childNonce: crypto.randomUUID() }));
  const offer = post.mock.calls.filter(([message]) => message.type === "hosty:ui:offer").at(-1)![0];
  const accept = { ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId,
    appId: tool.target.panel.appId, installationId: tool.target.panel.installationId };
  await act(async () => send(accept));
  return { offer, accept, send };
}
it.each([false, true])("keeps frame integrations on the resolved origin after navigation (retained tool: %s)", async retained => {
  const panel = catalog[0]!, authRequired = vi.fn(), open = vi.spyOn(window, "open").mockReturnValue(null);
  const initial = { ...panel.panel, endpoint: panel.endpoint, origin: panel.origin!, route: panel.route, framePolicy: policy };
  const next = { ...initial, origin: "https://other-endpoint.test", endpoint: "backend", route: "/people", framePolicy: { ...policy, microphone: true } };
  await render("slot");
  if (retained) await act(async () => { await host!.selectPanel(panel.panel); });
  const presentationId = host!.getSnapshot().tools[0]?.presentationId;
  const command = { type: "test:command" };
  const show = () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace onAuthRequired={authRequired}
    outbound={retained ? { target: { panel: panel.panel }, presentationId, message: command, nonce: 1 } : null}>
    <Document />{!retained && <HostyAppFrame surface={{ ...initial }} title="App view" view={{ viewId: "app", workspaceId: "default" }}
      onAuthRequired={authRequired} outbound={{ message: command, nonce: 1 }} />}
  </HostyPanelWorkspace></HostyUiRoot>);
  await act(async () => show());
  const frame = element.querySelector("iframe")!, parent = frame.parentElement;
  const send = (data: object, origin: string) => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin, data }));
  const connect = async (origin: string, post: ReturnType<typeof vi.spyOn>) => {
    await act(async () => send({ type: "hosty:ui:probe", version: 1, versions: [1], childNonce: crypto.randomUUID(), capabilities: ["ui.composition.v1"] }, origin));
    const offer = post.mock.calls.filter(([message]) => message.type === "hosty:ui:offer").at(-1)![0];
    await act(async () => send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId,
      appId: panel.panel.appId, installationId: panel.panel.installationId }, origin));
    return offer;
  };
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const offer = await connect(initial.origin, post);
  const viewId = retained ? `tool-${presentationId}` : "app";
  const chrome = { navigation: "show" as const, tools: { enabled: false, launcher: "show" as const } };
  await act(async () => host!.setViewChrome(viewId, chrome));
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => String(args[0]).endsWith("navigation/resolve")
    ? Response.json({ available: true, surface: next, state: "running" }) : originalFetch(...args));
  await act(async () => send({ ...offer, type: "hosty:ui:navigate", requestId: createPresentationRequestId(), entryKey: "other" }, initial.origin));
  await act(async () => show()); // An unrelated parent render must keep the new document and handlers.
  expect(element.querySelector("iframe")).toBe(frame); expect(frame.parentElement).toBe(parent);
  expect(new URL(frame.src).origin).toBe(next.origin);
  expect(new URL(frame.src).searchParams.get("hosty_navigation")).toBe("show");
  expect(new URL(frame.src).searchParams.get("hosty_tools")).toBe("disabled");
  expect(new URL(frame.src).searchParams.get("hosty_tool_launcher")).toBe("show");
  expect(frame.getAttribute("allow")).toContain("microphone");
  if (retained) expect(host!.getSnapshot().tools[0]).toMatchObject({ presentationId, currentRoute: next.route,
    readiness: "loading", resolved: { surface: next } });
  const nextPost = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await act(async () => frame.dispatchEvent(new Event("load")));
  const nextOffer = await connect(next.origin, nextPost);
  expect(nextPost.mock.calls.filter(([message]) => message.type === "hosty:ui:connected").at(-1)![0].chrome).toEqual(chrome);
  expect(nextPost).toHaveBeenCalledWith(command, next.origin);
  expect(nextPost.mock.calls.some(([message, origin]) => message.type === "hosty:shell-theme" && origin === next.origin)).toBe(true);
  await act(async () => {
    send({ type: "hosty:request-permission-review" }, initial.origin);
    send({ type: "hosty:auth-required", appId: panel.panel.appId }, initial.origin);
  });
  expect(open).not.toHaveBeenCalled(); expect(authRequired).not.toHaveBeenCalled();
  await act(async () => {
    send({ type: "hosty:request-permission-review" }, next.origin);
    send({ type: "hosty:auth-required", appId: panel.panel.appId }, next.origin);
    send({ ...nextOffer, type: "hosty:ui:route", route: next.route }, next.origin);
    send({ ...nextOffer, type: "hosty:ui:surface-state", route: next.route, state: "ready" }, next.origin);
  });
  expect(open).toHaveBeenCalledWith(`https://core.test/install/permissions/${panel.panel.appId}`, "_blank", "noopener,noreferrer");
  expect(authRequired).toHaveBeenCalledWith(panel.panel.appId);
  if (retained) {
    expect(host!.getSnapshot().tools[0]).toMatchObject({ currentRoute: next.route, readiness: "ready" });
    const dismiss = vi.fn(); window.addEventListener("hosty:ui:drawer-dismiss", dismiss);
    try {
      await act(async () => send({ ...nextOffer, type: "hosty:ui:dismiss" }, next.origin));
      expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ detail: "default" }));
    } finally { window.removeEventListener("hosty:ui:drawer-dismiss", dismiss); }
    const nextSrc = frame.src, nextContext = frame.contentWindow;
    await act(async () => host!.setExpanded(false));
    await act(async () => { expect(await host!.selectPanel(panel.panel)).toMatchObject({ status: "opened", presentationId }); });
    const resolutions = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("panels/resolve"));
    expect(JSON.parse(resolutions.at(-1)![1]!.body as string).route).toBe(initial.route);
    await act(async () => host!.refresh());
    expect(host!.getSnapshot().tools[0]!.resolved.surface).toEqual(next);
    expect(element.querySelector("iframe")).toBe(frame); expect(frame.src).toBe(nextSrc); expect(frame.contentWindow).toBe(nextContext);
    const refreshedOffer = await connect(next.origin, nextPost);
    await act(async () => {
      send({ ...refreshedOffer, type: "hosty:ui:route", route: "/outside" }, next.origin);
      send({ ...refreshedOffer, type: "hosty:ui:surface-state", route: "/outside", state: "ready" }, next.origin);
    });
    expect(host!.getSnapshot().tools[0]).toMatchObject({ currentRoute: null, readiness: "unreported" });
    await act(async () => {
      send({ ...refreshedOffer, type: "hosty:ui:route", route: "/people/detail" }, next.origin);
      send({ ...refreshedOffer, type: "hosty:ui:surface-state", route: "/people/detail", state: "ready" }, next.origin);
    });
    expect(host!.getSnapshot().tools[0]).toMatchObject({ currentRoute: "/people/detail", readiness: "ready" });
    listedPanels = [{ ...panel, origin: "https://replacement.test" }];
    await act(async () => host!.refresh());
    expect(host!.getSnapshot().tools[0]!.resolved).toMatchObject({ surface: null, state: "destination_changed" });
  }
});
it("retains the document and each opened tool across switching, collapse, replay and the drawer breakpoint", async () => {
  await render(); expect(element.querySelectorAll("iframe")).toHaveLength(0);
  const documentDraft = element.querySelector("textarea")!; documentDraft.setSelectionRange(2, 6);
  const target = { panel: catalog[0]!.panel, route: "/panel?session=existing" }, requestId = createPresentationRequestId();
  await act(async () => { await host!.openSurface(target, { placement: "side", requestId }); });
  const frame = element.querySelector("iframe")!;
  await act(async () => host!.setExpanded(false)); expect(frame.isConnected).toBe(true);
  await act(async () => { await host!.selectPanel(catalog[1]!.panel); });
  expect(element.querySelectorAll("iframe")).toHaveLength(2);
  await act(async () => { await host!.openSurface(target, { placement: "side", requestId }); });
  expect(element.querySelector("iframe")).toBe(frame); expect(documentDraft.selectionStart).toBe(2);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 899 } as DOMRect);
  await act(async () => resize());
  expect(element.querySelector('[data-hosty-panel-layout="drawer"]')).not.toBeNull();
  expect(element.querySelector('.hosty-panel-document')!.hasAttribute('inert')).toBe(true);
  expect(element.querySelector("iframe")).toBe(frame);
  await act(async () => host!.setExpanded(false));
  expect(element.querySelector('.hosty-panel-document')!.hasAttribute('inert')).toBe(false);
  expect(element.querySelector("textarea")).toBe(documentDraft);
});
it.each(["slot", "none"] as const)("supports %s composition without adding a second workspace", async layout => {
  await render(layout);
  expect(element.querySelectorAll(".hosty-panel-workspace")).toHaveLength(layout === "slot" ? 1 : 0);
  expect(host).not.toBeNull();
  if (layout === "slot") expect(() => host!.claimWorkspace({})).toThrow("Exactly one");
});
it("creates an initially inactive standalone host without metadata traffic", async () => {
  await act(async () => root.render(<HostyUiRoot active={false}><Document /></HostyUiRoot>));
  expect(fetch).not.toHaveBeenCalled();
  expect(ui.getEnvironment()).toMatchObject({ connection: "blocked", code: "activity_required" });
  expect(await ui.openSurface({ panel: catalog[0]!.panel }, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ status: "blocked", code: "activity_required" });
  expect(fetch).not.toHaveBeenCalled();
});
it("suspends the bound standalone facade and preserves mounted drafts while renewal revalidates", async () => {
  await render();
  await act(async () => { await host!.selectPanel(catalog[0]!.panel); });
  const documentDraft = element.querySelector("textarea"), frame = element.querySelector("iframe");
  await act(async () => root.render(<HostyUiRoot active={false}><Document /></HostyUiRoot>));
  const calls = vi.mocked(fetch).mock.calls.length;
  expect(await ui.openSurface({ panel: catalog[1]!.panel }, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ status: "blocked", code: "activity_required" });
  expect(fetch).toHaveBeenCalledTimes(calls);
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => { release = resolve; });
  await act(async () => root.render(<HostyUiRoot active><Document /></HostyUiRoot>));
  expect(ui.getEnvironment().connection).toBe("connecting");
  expect(await ui.getPresentation(createPresentationRequestId())).toMatchObject({ status: "blocked", code: "activity_required" });
  expect(element.querySelector("textarea")).toBe(documentDraft);
  expect(element.querySelector("iframe")).toBe(frame);
  await act(async () => { release(); await host!.refresh(); });
  expect(ui.getEnvironment().connection).toBe("connected");
  expect(element.querySelector("iframe")).toBe(frame);
});
it("removes panel chrome for an older app adapter without remounting the protected document", async () => {
  await render(); const documentDraft = element.querySelector("textarea");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 404 })));
  await act(async () => host!.refresh());
  expect(element.querySelector("textarea")).toBe(documentDraft);
  expect((element.querySelector(".hosty-panel-rail") as HTMLElement).style.display).toBe("none");
  expect((element.querySelector(".hosty-panel-workspace") as HTMLElement).style.display).toBe("contents");
});
it("delivers commands only to the exact panel among retained frames from the same app", async () => {
  listedPanels = [catalog[0]!, { ...catalog[0]!, panel: { ...catalog[0]!.panel, panelId: "second" }, route: "/second" }];
  await render("slot");
  await act(async () => { for (const panel of listedPanels) await host!.selectPanel(panel.panel); });
  const frames = [...element.querySelectorAll("iframe")];
  const posts = frames.map(frame => vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {}));
  await act(async () => frames.forEach(frame => frame.dispatchEvent(new Event("load"))));
  for (let i = 0; i < frames.length; i++) await connectTool(frames[i]!, posts[i]!);
  const target = host!.getSnapshot().tools[1]!.target;
  const command = { type: "hosty:open-assistant-session", sessionId: "selected-session" };
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace outbound={{ target, message: command, nonce: 1 }}><Document /></HostyPanelWorkspace></HostyUiRoot>));
  const commands = (index: number) => posts[index]!.mock.calls.filter(([value]) => value.type === command.type);
  expect(commands(0)).toHaveLength(0);
  expect(commands(1).map(([value]) => value)).toEqual([command]);
  const replaced = { ...target, panel: { ...target.panel, installationId: "reinstalled" } };
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace outbound={{ target: replaced, message: command, nonce: 2 }}><Document /></HostyPanelWorkspace></HostyUiRoot>));
  expect(commands(0)).toHaveLength(0); expect(commands(1)).toHaveLength(1);
});
it("does not replay a session command after the same panel navigates to another discussion route", async () => {
  await render("slot");
  await act(async () => { await host!.selectPanel(catalog[0]!.panel); });
  const target = host!.getSnapshot().tools[0]!.target;
  const command = { type: "hosty:open-assistant-session", sessionId: "previous-session" };
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace outbound={{ target, message: command, nonce: 1 }}><Document /></HostyPanelWorkspace></HostyUiRoot>));
  await act(async () => { await host!.openSurface({ ...target, route: "/panel?session=new-discussion" }, { placement: "side", requestId: crypto.randomUUID() }); });
  const frame = element.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await act(async () => frame.dispatchEvent(new Event("load")));
  expect(post.mock.calls.filter(([value]) => value.type === command.type)).toHaveLength(0);
});
it("holds commands until verified sign-in and redelivers after renewal without an iframe load", async () => {
  await render("slot");
  await act(async () => { await host!.selectPanel(catalog[0]!.panel); });
  const frame = element.querySelector("iframe")!, post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const target = host!.getSnapshot().tools[0]!.target;
  const command = { type: "hosty:open-assistant-session", sessionId: "notification-session" };
  const show = (nonce: number) => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace outbound={{ target, message: command, nonce }}><Document /></HostyPanelWorkspace></HostyUiRoot>);
  await act(async () => { show(1); frame.dispatchEvent(new Event("load")); });
  const commands = () => post.mock.calls.filter(([message]) => message.type === command.type);
  expect(commands()).toHaveLength(0);
  const mismatch = await connectTool(frame, post, "another-user");
  expect(commands()).toHaveLength(0);
  await act(async () => mismatch.send({ ...mismatch.accept, userId: metadata.userId }, "https://foreign.test"));
  expect(commands()).toHaveLength(0);
  const connected = await connectTool(frame, post);
  expect(commands().map(([message]) => message)).toEqual([command]);
  await act(async () => connected.send(connected.accept));
  expect(commands()).toHaveLength(1);
  await act(async () => connected.send({ ...connected.offer, type: "hosty:ui:auth-required" }));
  await act(async () => show(2));
  expect(commands()).toHaveLength(1);
  await connectTool(frame, post);
  expect(commands().map(([message]) => message)).toEqual([command, command]);
  await act(async () => host!.setActive(false));
  await act(async () => show(3));
  expect(commands()).toHaveLength(2);
  await act(async () => { host!.setActive(true); await host!.refresh(); });
  expect(commands()).toHaveLength(2);
  await connectTool(frame, post);
  expect(commands().map(([message]) => message)).toEqual([command, command, command]);
  expect(element.querySelector("iframe")).toBe(frame);
});

async function mountRestoration(minimizeControl: "always" | "drawer" = "always") {
  const changed = vi.fn();
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace railMode="catalog"
    minimizeControl={minimizeControl} initialExpanded initialWidth={420} onExpandedChange={changed}><Document /></HostyPanelWorkspace></HostyUiRoot>));
  return changed;
}
it("restores the open preference once the delayed catalog supplies a tool", async () => {
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => { release = resolve; });
  const changed = await mountRestoration();
  expect(element.querySelectorAll("iframe")).toHaveLength(0);
  expect(changed).not.toHaveBeenCalledWith(false);
  await act(async () => { release(); await host!.refresh(); });
  expect(host!.getSnapshot().selected).toEqual(catalog[0]!.panel);
  expect(element.querySelector("aside")!.hidden).toBe(false);
  expect(host!.getSnapshot().width).toBe(420);
  const frame = element.querySelector("iframe");
  await act(async () => host!.refresh());
  expect(element.querySelector("iframe")).toBe(frame);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(1);
});
it("retries refused restoration only after fresh catalog metadata", async () => {
  refuseResolution = true;
  await mountRestoration();
  expect(host!.getSnapshot()).toMatchObject({ expanded: true, selected: null });
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"));
  expect(requests()).toHaveLength(1);
  await act(async () => host!.setWidth(500));
  expect(requests()).toHaveLength(1);
  refuseResolution = false;
  await act(async () => host!.refresh());
  expect(host!.getSnapshot().selected).toEqual(catalog[0]!.panel);
  expect(requests()).toHaveLength(2);
  expect(element.querySelector("aside")!.hidden).toBe(false);
});
it.each(["close", "collapse", "rail"])("reopens a catalog workspace after repeated %s actions", async action => {
  await mountRestoration(action === "rail" ? "drawer" : "always");
  for (let cycle = 0; cycle < 2; cycle++) {
    const frame = element.querySelector("iframe")!, id = host!.getSnapshot().selectedPresentationId;
    expect(frame).not.toBeNull();
    await act(async () => {
      expect(element.querySelector("button.hosty-panel-state")).toBeNull();
      expect(element.querySelector('header button[aria-label="Close tool view"]')).toBeNull();
      if (action === "close") host!.closePresentation(id!);
      else if (action === "rail") {
        expect(element.querySelector('header button[aria-label="Minimize panel"]')).toBeNull();
        expect(element.querySelector('header a[aria-label="Open separately"]')).not.toBeNull();
        element.querySelector<HTMLButtonElement>('.hosty-panel-rail button[aria-label="assistant"]')!.click();
      }
      else element.querySelector<HTMLButtonElement>('header button[aria-label="Minimize panel"]')!.click();
    });
    expect(element.querySelector("aside")!.hidden).toBe(true);
    expect(host!.getSnapshot().expanded).toBe(false);
    if (action === "close") expect(host!.getSnapshot().tools).toHaveLength(0);
    await act(async () => {
      if (action === "rail") element.querySelector<HTMLButtonElement>('.hosty-panel-rail button[aria-label="assistant"]')!.click();
      else host!.setExpanded(true);
    });
    expect(element.querySelector("aside")!.hidden).toBe(false);
    expect(host!.getSnapshot().selected).toEqual(catalog[0]!.panel);
    expect(host!.getSnapshot().tools).toHaveLength(1);
    if (action === "close") {
      expect(element.querySelector("iframe")).not.toBe(frame);
      expect(host!.getSnapshot().selectedPresentationId).not.toBe(id);
    } else {
      expect(element.querySelector("iframe")).toBe(frame);
      expect(host!.getSnapshot().selectedPresentationId).toBe(id);
    }
  }
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(action === "collapse" ? 1 : 3);
  if (action === "rail") {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 899 } as DOMRect);
    await act(async () => resize());
    const minimize = element.querySelector<HTMLButtonElement>('header button[aria-label="Minimize panel"]')!;
    expect(document.activeElement).toBe(minimize);
    await act(async () => minimize.click());
    expect(element.querySelector("aside")!.hidden).toBe(true);
  }
});
it("does not retry refused restoration after the operator collapses", async () => {
  refuseResolution = true; await mountRestoration();
  await act(async () => host!.setExpanded(false));
  refuseResolution = false;
  await act(async () => host!.refresh());
  expect(host!.getSnapshot()).toMatchObject({ expanded: false, selected: null, tools: [] });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(1);
});
it("retries with catalog metadata received while a refused restoration was still pending", async () => {
  let release!: () => void;
  resolutionGate = new Promise(resolve => { release = resolve; }); refuseResolution = true;
  await mountRestoration();
  await act(async () => host!.refresh());
  refuseResolution = false;
  await act(async () => release());
  expect(host!.getSnapshot().selected).toEqual(catalog[0]!.panel);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(2);
});
it("does not reopen when the operator collapses during delayed default-tool restoration", async () => {
  let release!: () => void;
  resolutionGate = new Promise(resolve => { release = resolve; });
  await mountRestoration();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(1);
  await act(async () => host!.setExpanded(false));
  await act(async () => release());
  expect(host!.getSnapshot()).toMatchObject({ expanded: false, selected: null, tools: [] });
  expect(element.querySelectorAll("iframe")).toHaveLength(0);
});
it("does not restore over a selection made before the catalog arrives", async () => {
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => { release = resolve; });
  await mountRestoration();
  await act(async () => { await host!.selectPanel(catalog[1]!.panel); });
  const frame = element.querySelector("iframe");
  await act(async () => { release(); await host!.refresh(); });
  expect(host!.getSnapshot().selected).toEqual(catalog[1]!.panel);
  expect(element.querySelector("iframe")).toBe(frame);
  expect(element.querySelectorAll("iframe")).toHaveLength(1);
});
it("does not reopen when the user collapses before metadata arrives", async () => {
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => { release = resolve; });
  await mountRestoration();
  await act(async () => host!.setExpanded(false));
  await act(async () => { release(); await host!.refresh(); });
  expect(host!.getSnapshot().expanded).toBe(false);
  expect(element.querySelectorAll("iframe")).toHaveLength(0);
});
it("keeps the same iframe and unsent content through runtime transitions, removing it on actual stop", async () => {
  await render();
  await act(async () => { await host!.selectPanel(catalog[0]!.panel); });
  const frame = element.querySelector("iframe")!;
  // jsdom does not load the remote app; supply its document without navigating the frame.
  frame.contentDocument!.append(frame.contentDocument!.createElement("html"));
  frame.contentDocument!.documentElement.append(frame.contentDocument!.createElement("body"));
  const draft = frame.contentDocument!.createElement("textarea");
  draft.value = "Keep this unsent draft"; frame.contentDocument!.body.append(draft);
  for (const state of ["stopping", "starting", "unavailable", "running"]) {
    listedPanels = [{ ...catalog[0]!, state, available: state === "running" }, catalog[1]!];
    await act(async () => host!.refresh());
    expect(element.querySelector("iframe")).toBe(frame);
    expect(frame.contentDocument!.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("Keep this unsent draft");
  }
  listedPanels = [{ ...catalog[0]!, state: "stopped", available: false }];
  await act(async () => host!.refresh());
  expect(element.querySelector("iframe")).toBeNull();
  expect(element.textContent).toContain("This tool is unavailable (stopped).");
});
it.each(["running", "degraded"])("updates degradation warnings without replacing a frame opened while %s", async initial => {
  listedPanels = [{ ...catalog[0]!, state: initial }];
  await render();
  await act(async () => { await host!.selectPanel(catalog[0]!.panel); });
  const frame = element.querySelector("iframe");
  for (const state of [initial, "degraded", "running", "unavailable", "starting", "stopping", "running"]) {
    listedPanels = [{ ...catalog[0]!, state, available: state === "running" || state === "degraded" }];
    await act(async () => host!.refresh());
    expect(element.querySelector("iframe")).toBe(frame);
    expect(element.textContent!.includes("This app’s health check is failing.")).toBe(state === "degraded");
    expect(host!.getSnapshot().tools[0]!.resolved).toMatchObject({ state, available: listedPanels[0]!.available });
  }
});
