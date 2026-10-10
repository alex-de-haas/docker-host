// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyPanelWorkspace, HostyUiRoot, useHostyUiHost } from "./ui-react";
import { createPresentationRequestId, ui } from "./ui";
import type { UiHost } from "./ui-host";
import type { UiBootstrap, UiPanel } from "./ui-types";
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
  catalogGate = null;
  resolutionGate = null;
  refuseResolution = false;
  listedPanels = catalog;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
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
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(layout: "auto" | "slot" | "none" = "auto") {
  await act(async () => root.render(<HostyUiRoot panelLayout={layout}>{layout === "slot" ? <HostyPanelWorkspace><Document /></HostyPanelWorkspace> : <Document />}</HostyUiRoot>));
  await act(async () => host!.refresh());
}
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
  expect((element.querySelector("nav") as HTMLElement).style.display).toBe("none");
  expect((element.querySelector(".hosty-panel-workspace") as HTMLElement).style.display).toBe("contents");
});
it("delivers commands only to the exact panel among retained frames from the same app", async () => {
  listedPanels = [catalog[0]!, { ...catalog[0]!, panel: { ...catalog[0]!.panel, panelId: "second" }, route: "/second" }];
  await render("slot");
  await act(async () => { for (const panel of listedPanels) await host!.selectPanel(panel.panel); });
  const frames = [...element.querySelectorAll("iframe")];
  const posts = frames.map(frame => vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {}));
  await act(async () => frames.forEach(frame => frame.dispatchEvent(new Event("load"))));
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

async function mountRestoration() {
  const changed = vi.fn();
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace railMode="catalog"
    initialExpanded initialWidth={420} onExpandedChange={changed}><Document /></HostyPanelWorkspace></HostyUiRoot>));
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
