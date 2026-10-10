// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyPanelWorkspace, HostyUiRoot, useHostyUiHost } from "./ui-react";
import { createPresentationRequestId } from "./ui";
import type { UiHost } from "./ui-host";
import type { UiBootstrap, UiPanel } from "./ui-types";
vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
let root: Root, element: HTMLDivElement, host: UiHost | null;
let resize: () => void;
let catalogGate: Promise<void> | null;
let listedPanels: UiPanel[];
const policy = { microphone: false, popupEscape: false };
const metadata: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "plans", installationId: "plans-1", origins: ["http://localhost:3000"] } };
const catalog: UiPanel[] = ["assistant", "notes"].map(id => ({ panel: { appId: id, installationId: `${id}-1`, panelId: "tool" },
  endpoint: "web", route: "/panel", origin: `https://${id}.test`, label: id, appName: id, icon: null, available: true, state: "running", canStart: false, framePolicy: policy }));
function Document() { host = useHostyUiHost(); return <textarea aria-label="Document draft" defaultValue="Keep this selection" />; }
beforeEach(() => {
  catalogGate = null;
  listedPanels = catalog;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("bootstrap")) return Response.json(metadata);
    if (!path.endsWith("resolve")) { await catalogGate; return Response.json({ panels: listedPanels }); }
    const target = JSON.parse(init!.body as string), panel = listedPanels.find(p => p.panel.appId === target.panel.appId)!;
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
it("removes panel chrome for an older app adapter without remounting the protected document", async () => {
  await render(); const documentDraft = element.querySelector("textarea");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 404 })));
  await act(async () => host!.refresh());
  expect(element.querySelector("textarea")).toBe(documentDraft);
  expect((element.querySelector("nav") as HTMLElement).style.display).toBe("none");
  expect((element.querySelector(".hosty-panel-workspace") as HTMLElement).style.display).toBe("contents");
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
