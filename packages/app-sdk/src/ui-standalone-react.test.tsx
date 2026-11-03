// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyUiRoot, useHostyUiHost } from "./ui-react";
import type { UiHost } from "./ui-host";
import type { UiBootstrap, UiPanel } from "./ui-types";
vi.mock("./browser-auth", () => ({ APP_SESSION_RESTORED: "hosty:app-session-restored", appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
let root: Root, element: HTMLDivElement, host: UiHost | null, bootstrap: UiBootstrap;
const policy = { microphone: false, popupEscape: false };
const panel: UiPanel = { panel: { appId: "provider", installationId: "provider-1", panelId: "notes" }, label: "Notes", appName: "Notebook", icon: null,
  endpoint: "web", route: "/notes", origin: "https://notes.test", available: true, state: "running", canStart: false, framePolicy: policy };
function Document() { host = useHostyUiHost(); return <textarea aria-label="Document draft" defaultValue="Keep this draft" />; }
beforeEach(() => {
  bootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
    app: { appId: "editor", installationId: "editor-1", origins: [location.origin], displayName: "Document Editor", iconUrl: "https://core.test/icon.svg" } };
  localStorage.clear(); document.documentElement.removeAttribute("data-hosty-chrome-hints");
  vi.stubGlobal("innerWidth", 1200); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("bootstrap")) return Response.json(bootstrap);
    if (path.endsWith("navigation")) return Response.json({ appId: "editor", installationId: "editor-1", revision: "1", entries: [
      { key: "home", label: "Home", icon: null, endpoint: "web", origin: location.origin, route: "/", available: true, state: "running", standaloneHref: "/" }] });
    if (path.endsWith("resolve")) { const target = JSON.parse(init!.body as string); return Response.json({target,available:true,state:"running",standaloneHref:"https://core.test/open",
      surface: {...panel.panel,endpoint:panel.endpoint,origin:panel.origin,route:panel.route,framePolicy:policy} }); }
    return Response.json({panels:[panel]});
  }));
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (label: string) => element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const render = async () => { await act(async () => root.render(<HostyUiRoot><Document /></HostyUiRoot>)); await act(async () => host!.refresh()); };
const click = async (label: string) => { expect(button(label)).not.toBeNull(); await act(async () => button(label).click()); };
it("pins without opening, retains a selected tool when unpinned, and restores choices across reload", async () => {
  await render(); expect(element.querySelector('.hosty-panel-rail')).toBeNull();
  expect(element.querySelector('.hosty-standalone-identity')?.textContent).toBe('Document Editor');
  expect(element.querySelector('.hosty-standalone-identity img')?.getAttribute('src')).toBe(bootstrap.app.iconUrl);
  await click('Tools'); await click('Pin Notebook — Notes to top bar');
  expect(element.querySelector('iframe')).toBeNull(); expect(button('Pin Notebook — Notes to top bar').getAttribute('aria-pressed')).toBe('true');
  await click('Close tool chooser'); await click('Open Notebook — Notes');
  const frame = element.querySelector('iframe'), draft = element.querySelector('textarea'); expect(frame).not.toBeNull();
  await click('Tools'); await click('Pin Notebook — Notes to top bar'); await click('Close tool chooser');
  expect(button('Open Notebook — Notes')).toBeNull(); expect(element.querySelector('iframe')).toBe(frame); expect(element.querySelector('textarea')).toBe(draft);
  await click('Tools'); await click('Pin Notebook — Notes to top bar'); await click('Close tool chooser');
  await act(async () => root.unmount()); root = createRoot(element); await render();
  expect(button('Open Notebook — Notes')).not.toBeNull(); expect(element.querySelector('iframe')).toBeNull();
});
it("hides navigation without replacing the document, restores it and honors host policy", async () => {
  await render(); const draft = element.querySelector('textarea');
  await act(async () => element.querySelector<HTMLElement>('nav[aria-label="App pages"] a')!.focus());
  await click('Hide navigation');
  expect(element.querySelector('[data-hosty-navigation-boundary]')?.hasAttribute('hidden')).toBe(true);
  expect(document.activeElement?.hasAttribute('data-hosty-content')).toBe(true); expect(element.querySelector('textarea')).toBe(draft);
  await click('Show navigation'); expect(element.querySelector('[data-hosty-navigation-boundary]')?.hasAttribute('hidden')).toBe(false);
  await act(async () => host!.setViewChrome('root',{navigation:'hide',tools:{launcher:'hide'}}));
  expect(element.querySelector('.hosty-standalone-header')).toBeNull(); expect(element.querySelector('textarea')).toBe(draft);
});
it("uses the header navigation control on narrow screens and returns focus on dismissal", async () => {
  vi.stubGlobal('innerWidth',600); await render();
  expect(button('Page navigation')).toBeNull(); await click('Show navigation');
  const dialog = element.querySelector<HTMLDialogElement>('.hosty-navigation-dialog')!; expect(dialog.open).toBe(true);
  await act(async () => dialog.dispatchEvent(new Event('cancel'))); expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(button('Show navigation'));
  await click('Show navigation'); await act(async () => host!.openToolPicker({requestId:crypto.randomUUID()}));
  expect(dialog.open).toBe(false); expect(element.querySelector<HTMLDialogElement>('.hosty-tool-menu')!.open).toBe(true);
});
it("does not carry pins or navigation visibility to another actor", async () => {
  await render(); await click('Tools'); await click('Pin Notebook — Notes to top bar'); await click('Close tool chooser'); await click('Hide navigation');
  bootstrap = {...bootstrap,userId:'bob'}; await act(async () => host!.refresh());
  expect(button('Open Notebook — Notes')).toBeNull(); expect(button('Hide navigation')).not.toBeNull();
});
