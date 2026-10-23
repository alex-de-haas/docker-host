import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyUiRoot, useHostyUiHost } from "@hosty-sdk/app/ui/react";
import { ui, createPresentationRequestId } from "@hosty-sdk/app/ui";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import type { UiBootstrap, UiPanel } from "@hosty-sdk/app/ui/types";
import { ShellPanelWorkspace } from "../src/app/shell/chrome/shell-panel-workspace";
import { usePanelExpanded } from "../src/app/shell/chrome/use-panel-expanded";
import { ShellMobileTabs } from "../src/app/shell/chrome/shell-mobile-tabs";
import { ShellTopStrip } from "../src/app/shell/chrome/shell-top-strip";
import { useAssistantSessionLink } from "../src/app/shell/assistant/use-assistant-session-link";
import { RIGHT_PANEL_OPEN_PREF_KEY } from "../src/app/shell/shell-routes";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const policy = { microphone: false, popupEscape: false };
const bootstrap: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "shell", installationId: "shell-1", origins: ["http://localhost:3000"] } };
const panels: UiPanel[] = ["notes", "assistant"].map(appId => ({ panel: { appId, installationId: `${appId}-1`, panelId: "tool" },
  endpoint: "web", route: "/panel", origin: `https://${appId}.test`, label: appId, appName: appId, icon: null,
  available: true, state: "running", canStart: false, framePolicy: policy }));
let root: Root, container: HTMLDivElement, host: UiHost | null;
let resizeWorkspace: () => void;
let catalog: UiPanel[];
let catalogGate: Promise<void> | null, resolutionGate: Promise<void> | null, refused: boolean;
const persisted = vi.fn();
function Shell({ initialOpen, link }: { initialOpen: boolean | null; link: boolean }) {
  const panelHost = useHostyUiHost();
  useEffect(() => { host = panelHost; }, [panelHost]);
  const expanded = usePanelExpanded(panelHost, initialOpen, link);
  useAssistantSessionLink({ host: panelHost, appId: "assistant", assistantIds: ["assistant"], sessionId: link ? "existing" : null, userId: "alice", onOpened: () => {} });
  return <>
    <ShellTopStrip title="Plans" navigationWidth={60} leftRailExpanded={false} onToggleLeftRail={() => {}}
      rightRailExpanded={expanded} onToggleRightRail={() => panelHost?.setExpanded(!expanded)} showNotifications={false} onBrandClick={() => {}} />
    <ShellMobileTabs active="dashboard" canManage onNavigate={() => {}} />
    <ShellPanelWorkspace onExpandedChange={persisted}><div>Document<input aria-label="Document draft" defaultValue="" /></div></ShellPanelWorkspace>
  </>;
}
async function render(initialOpen: boolean | null, link = false) {
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><Shell initialOpen={initialOpen} link={link} /></HostyUiRoot>));
}
const toggle = (open: boolean) => container.querySelector<HTMLButtonElement>(`button[aria-label="${open ? "Hide" : "Show"} the panel"]`)!;
beforeEach(() => {
  catalog = panels; host = null; catalogGate = null; resolutionGate = null; refused = false; persisted.mockReset(); localStorage.clear();
  document.cookie = `${RIGHT_PANEL_OPEN_PREF_KEY}=; max-age=0; path=/`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resizeWorkspace = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe(element: HTMLElement) { if (element.hasAttribute("data-shell-panel-layout")) resizeWorkspace = this.callback; }
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.endsWith("panels")) { await catalogGate; return Response.json({ panels: catalog }); }
    if (url.endsWith("resolve")) {
      await resolutionGate;
      if (refused) return Response.json({ code: "access_unavailable" }, { status: 403 });
      const target = JSON.parse(init!.body as string), panel = panels.find(item => item.panel.appId === target.panel.appId)!;
      return Response.json({ target: { ...target, route: panel.route }, available: true, state: "running", standaloneHref: "https://core.test/open",
        surface: { ...panel.panel, endpoint: panel.endpoint, origin: panel.origin, route: panel.route, framePolicy: policy } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows the real collapsed state during a delayed/refused session link and opens on the first toggle", async () => {
  let release!: () => void;
  catalogGate = new Promise(resolve => { release = resolve; }); refused = true;
  await render(true, true);
  expect(toggle(false)?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => { release(); await host!.refresh(); });
  expect(host!.getSnapshot().selected).toBeNull();
  expect(persisted).not.toHaveBeenCalled();
  expect(toggle(false)?.getAttribute("aria-pressed")).toBe("false");
  refused = false;
  await act(async () => toggle(false).click());
  expect(toggle(true)?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("aside")?.hidden).toBe(false);
});
it("applies a legacy open preference to the workspace and collapses on the first toggle", async () => {
  localStorage.setItem(RIGHT_PANEL_OPEN_PREF_KEY, "true");
  await render(null);
  expect(toggle(true)?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("aside")?.hidden).toBe(false);
  expect(document.cookie).toContain(`${RIGHT_PANEL_OPEN_PREF_KEY}=true`);
  await act(async () => toggle(true).click());
  expect(host!.getSnapshot().expanded).toBe(false);
  expect(toggle(false)).not.toBeNull();
  expect(container.querySelector("aside")?.hidden).toBe(true);
});
it("defers a legacy open preference to the explicit session link instead of selecting the first tool", async () => {
  localStorage.setItem(RIGHT_PANEL_OPEN_PREF_KEY, "true"); refused = true;
  await render(null, true);
  expect(toggle(false)).not.toBeNull();
  expect(host!.getSnapshot().selected).toBeNull();
  refused = false;
  await act(async () => host!.refresh());
  expect(host!.getSnapshot().selected?.appId).toBe("assistant");
  expect(toggle(true)).not.toBeNull();
});
it("honors the cookie over legacy storage and follows SDK changes without reapplying initial state", async () => {
  localStorage.setItem(RIGHT_PANEL_OPEN_PREF_KEY, "true");
  await render(false);
  expect(toggle(false)).not.toBeNull();
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  expect(toggle(true)).not.toBeNull();
  await render(false, true);
  expect(toggle(true)).not.toBeNull();
  await act(async () => host!.setExpanded(false));
  expect(toggle(false)).not.toBeNull();
});
it("performs one resolution for the first top-strip opening after catalog discovery", async () => {
  await render(false);
  await act(async () => host!.refresh());
  let release!: () => void;
  resolutionGate = new Promise(resolve => { release = resolve; });
  const select = vi.spyOn(host!, "selectPanel");
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"));
  await act(async () => toggle(false).click());
  expect(select).toHaveBeenCalledTimes(1);
  expect(requests()).toHaveLength(1);
  await act(async () => release());
  expect(select).toHaveBeenCalledTimes(1);
  expect(requests()).toHaveLength(1);
  expect(host!.getSnapshot().selected).toEqual(panels[0].panel);
  expect(container.querySelector("aside")?.hidden).toBe(false);
});

it("retains tool frames across rail toggles, switching and the drawer breakpoint", async () => {
  const originalWidth = window.innerWidth;
  await render(false);
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  const assistant = container.querySelector<HTMLIFrameElement>('iframe[title="assistant"]')!;
  expect(assistant).not.toBeNull();
  expect(container.querySelector(".hosty-panel-workspace")).toBeNull();
  expect(container.querySelector('#workspace')?.firstElementChild?.className).toContain("border");
  expect(container.querySelector('[aria-label="Open separately"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Minimize panel"]')).toBeNull();
  expect(container.querySelector('[aria-label="Close tool"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Hide tool"]')!.click());
  expect(host!.getSnapshot().expanded).toBe(false);
  expect(container.querySelector('iframe[title="assistant"]')).toBe(assistant);
  await act(async () => { await host!.selectPanel(panels[0].panel); });
  expect(container.querySelector('iframe[title="assistant"]')).toBe(assistant);
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    await act(async () => resizeWorkspace());
    expect(container.querySelector('[data-shell-panel-layout="drawer"]')).not.toBeNull();
    expect(container.querySelector('aside[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector('nav[aria-label="Tools"]')).toBeNull();
    expect(container.querySelector('iframe[title="assistant"]')).toBe(assistant);
    await act(async () => container.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host!.getSnapshot().expanded).toBe(false);
    expect(container.querySelector('iframe[title="assistant"]')).toBe(assistant);
  } finally { Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth }); }
});
it("serves SDK picker requests with the Shell dialog and releases SDK-closed presentations", async () => {
  await render(false);
  await act(async () => { expect(await ui.openToolPicker({ requestId: createPresentationRequestId() })).toMatchObject({ status: "accepted" }); });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Open a tool and keep its current conversation or draft");
  await act(async () => { await host!.selectPanel(panels[0].panel); });
  const id = host!.getSnapshot().tools[0].presentationId;
  await act(async () => host!.closePresentation(id));
  expect(container.querySelector('iframe[title="notes"]')).toBeNull();
});


it("focuses a newly opened tool after its frame mounts", async () => {
  await render(false);
  const opener = toggle(false);
  opener.focus();
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  const assistant = container.querySelector<HTMLIFrameElement>('iframe[title="assistant"]');
  expect(assistant).not.toBeNull();
  expect(document.activeElement).toBe(assistant);
  await act(async () => host!.collapseWorkspace("default"));
  expect(document.activeElement).toBe(opener);
});

it.each(["access", "policy", "origin", "stopped"])("explains a retained panel invalidated by %s", async reason => {
  await render(false);
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  const id = host!.getSnapshot().tools[0].presentationId;
  catalog = reason === "access" ? [panels[0]] : panels.map(panel => panel === panels[1] ? {
    ...panel,
    ...(reason === "policy" ? { framePolicy: { ...policy, microphone: true } } : {}),
    ...(reason === "origin" ? { origin: "https://replacement.test" } : {}),
    ...(reason === "stopped" ? { state: "stopped", available: false } : {}),
  } : panel);
  await act(async () => host!.refresh());
  expect(host!.getSnapshot().tools[0]).toMatchObject({ presentationId: id, resolved: { surface: null } });
  expect(container.querySelector('iframe[title="assistant"]')).toBeNull();
  expect(container.querySelector('aside [role="status"]')?.textContent).toContain("This tool is no longer available");
  await act(async () => container.querySelector<HTMLButtonElement>('aside button[aria-label="Choose another tool"]')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("All tools");
});


it.each(["disabled", "hidden"])("honors %s tool chrome and restores the rail when enabled", async mode => {
  await render(false);
  await act(async () => { expect(await ui.openToolPicker({ requestId: createPresentationRequestId() })).toMatchObject({ status: "accepted" }); });
  await act(async () => host!.setViewChrome("root", { tools: mode === "disabled" ? { enabled: false } : { launcher: "hide" } }));
  expect(toggle(false)).toBeNull();
  expect(toggle(true)).toBeNull();
  expect(container.querySelector('nav[aria-label="Tools"]')).toBeNull();
  expect(container.querySelector('#right-panel')?.hasAttribute("hidden")).toBe(true);
  if (mode === "disabled") {
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { expect((await ui.openToolPicker({ requestId: createPresentationRequestId() })).status).not.toBe("accepted"); });
  }
  await act(async () => host!.setViewChrome("root", {}));
  expect(container.querySelector('[aria-label="Tools"]')).not.toBeNull();
  expect(container.querySelector('#right-panel')?.hasAttribute("hidden")).toBe(true);
});


it("keeps frame access-review links out of document flow without SDK workspace styles", async () => {
  vi.stubGlobal("open", vi.fn());
  await render(false);
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  const frame = container.querySelector<HTMLIFrameElement>('iframe[title="assistant"]')!;
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: panels[1].origin!,
    data: { type: "hosty:request-permission-review" },
  })));
  const link = container.querySelector<HTMLAnchorElement>('a.hosty-panel-review')!;
  expect(link).not.toBeNull();
  expect(link.href).toContain("https://core.test/");
  expect(getComputedStyle(link).position).toBe("absolute");
  expect(getComputedStyle(frame.parentElement!).position).toBe("relative");
  expect(getComputedStyle(frame).display).toBe("block");
  expect(container.querySelector('iframe[title="assistant"]')).toBe(frame);
});

it("phone Tools hides and restores the last presentation without replacing its iframe", async () => {
  await render(false);
  await act(async () => { await host!.selectPanel(panels[1].panel); });
  const frame = container.querySelector('iframe[title="assistant"]');
  const tools = container.querySelector<HTMLButtonElement>('nav[aria-label="Phone navigation"] button[aria-label="Tools"]')!;
  await act(async () => tools.click());
  expect(host!.getSnapshot().expanded).toBe(false);
  expect(container.querySelector('iframe[title="assistant"]')).toBe(frame);
  await act(async () => tools.click());
  expect(host!.getSnapshot().expanded).toBe(true);
  expect(container.querySelector('iframe[title="assistant"]')).toBe(frame);
  expect(host!.getSnapshot().tools).toHaveLength(1);
});

it("groups tools by owning app and recovers a no-results search without resolving or replacing tools", async () => {
  catalog = [...panels, { ...panels[0], panel: { ...panels[0].panel, panelId: "drafts" }, label: "Drafts" }];
  await render(false);
  await act(async () => { await ui.openToolPicker({ requestId: createPresentationRequestId() }); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('section[aria-label="notes tools"]')?.querySelectorAll('button[aria-pressed]')).toHaveLength(2);
  expect(dialog.querySelector('section[aria-label="assistant tools"]')).not.toBeNull();
  const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search tools"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "nothing matches this");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain("No tools match your search");
  expect(dialog.querySelectorAll('section[aria-label$=" tools"]')).toHaveLength(0);
  await act(async () => [...dialog.querySelectorAll("button")].find(button => button.textContent === "Clear search")!.click());
  expect(search.value).toBe(""); expect(dialog.querySelectorAll('section[aria-label$=" tools"]')).toHaveLength(2);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"))).toHaveLength(0);
});
it("distinguishes a loaded empty tool list from a filtered list and preserves explicit refresh", async () => {
  catalog = []; await render(false);
  await act(async () => { await ui.openToolPicker({ requestId: createPresentationRequestId() }); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain("No tools are available for your account.");
  expect(dialog.textContent).not.toContain("No tools match your search");
  catalog = panels;
  await act(async () => [...dialog.querySelectorAll("button")].find(button => button.textContent === "Refresh tools")!.click());
  expect(dialog.querySelector('section[aria-label="assistant tools"]')).not.toBeNull();
  expect(host!.getSnapshot().tools).toHaveLength(0);
});
it("retains page drafts and the same selected tool through the 599/600 phone boundary and back to dock", async () => {
  const originalWidth = window.innerWidth;
  try {
    await render(false);
    const draft = container.querySelector<HTMLInputElement>('[aria-label="Document draft"]')!;
    draft.value = "Unsaved document text";
    await act(async () => { await host!.selectPanel(panels[1].panel); });
    const frame = container.querySelector('iframe[title="assistant"]')!;
    for (const width of [599, 600, 599, 1280]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      await act(async () => resizeWorkspace());
      expect(container.querySelector('iframe[title="assistant"]')).toBe(frame);
      expect(container.querySelector('[aria-label="Document draft"]')).toBe(draft); expect(draft.value).toBe("Unsaved document text");
      expect(container.querySelector('[data-shell-panel-layout]')?.getAttribute("data-shell-panel-layout")).toBe(width < 904 ? "drawer" : "dock");
    }
    await act(async () => host!.collapseWorkspace("default"));
    expect(container.querySelector('iframe[title="assistant"]')).toBe(frame); expect(draft.value).toBe("Unsaved document text");
  } finally { Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth }); }
});
