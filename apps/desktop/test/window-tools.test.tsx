import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUiHost, type UiHost } from "@hosty-sdk/app/ui/host";
import type { PanelTarget, UiPanel } from "@hosty-sdk/app/ui";
import type { App } from "../src/lib/model";
const mocks = vi.hoisted(() => ({ host: null as UiHost | null, prepare: vi.fn() }));
vi.mock("@hosty-sdk/app/ui/react", () => ({
  useHostyUiHost: () => mocks.host,
  HostyAppFrame: ({ title, surface }: { title: string; surface: { route: string } }) => <iframe title={title} data-route={surface.route} />,
}));
vi.mock("../src/lib/window-tools", async original => ({ ...await original<object>(), prepareWindowDiscussion: mocks.prepare }));
import { DesktopTools, WindowTools } from "../src/components/window-tools";
const panel: UiPanel = { panel: { appId: "assistant", installationId: "install-a", panelId: "chat" }, label: "Assistant", appName: "Helper", icon: "bot", endpoint: "web", route: "/chat", origin: "https://helper.example", available: true, state: "running", canStart: true, framePolicy: { microphone: false, popupEscape: false } };
const other = { ...panel, panel: { ...panel.panel, appId: "inspector", panelId: "inspect" }, label: "Inspector", appName: "Inspector", route: "/inspect" };
const provider: App = { id: "assistant", installationId: "install-a", displayName: "Helper", runtimeState: "running", confirmedRoles: ["assistant"], interfaces: { assistant: [{ key: "default", version: 1, capabilities: [] }] } };
const notes: App = { id: "notes", installationId: "notes-1", displayName: "Notes", runtimeState: "running" };
const music: App = { ...notes, id: "music", displayName: "Music" };
let root: Root, element: HTMLDivElement, host: UiHost;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("bootstrap")) return Response.json({ version: 1, canHost: true, userId: "alice", coreOrigin: "https://core.example", app: { appId: "desktop", installationId: "d1" } });
    if (url.endsWith("panels")) return Response.json({ panels: [panel, other] });
    if (url.endsWith("resolve")) {
      const target = JSON.parse(init?.body as string) as PanelTarget;
      return Response.json({ target, available: true, state: "running", surface: { ...panel, appId: target.panel.appId, installationId: target.panel.installationId, route: target.route || "/inspect" }, standaloneHref: "https://core.example/open" });
    }
    return Response.json({});
  }));
  host = createUiHost(); mocks.host = host; await host.refresh();
  mocks.prepare.mockReset().mockImplementation(async (_user, app: App) => ({ target: { panel: panel.panel, route: `/chat/${app.id}` }, complete: vi.fn() }));
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); host.dispose(); mocks.host = null; element.remove(); vi.unstubAllGlobals(); });
async function render(apps = [notes, music], hidden = false) {
  await act(async () => root.render(<DesktopTools>{apps.map(app => <WindowTools key={app.id} app={app} apps={[provider]} userId="alice">{(toolbar, wrap) => <section data-app={app.id} hidden={hidden}><header>{toolbar}</header>{wrap(<div>Document {app.displayName}</div>)}</section>}</WindowTools>)}</DesktopTools>));
}
async function click(app: string, text: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>(`[data-app="${app}"] button`)].find(item => item.getAttribute("aria-label")?.includes(text));
  expect(button).toBeDefined(); await act(async () => button!.click());
}
it("creates separate app-context discussions in the owning windows and retains them when hidden", async () => {
  await render(); await click("notes", "discuss Notes"); await click("music", "discuss Music");
  expect(mocks.prepare.mock.calls.map(call => [call[0], call[1].id])).toEqual([["alice", "notes"], ["alice", "music"]]);
  const frame = element.querySelector('[data-app="notes"] iframe'); expect(frame?.getAttribute("data-route")).toBe("/chat/notes");
  expect(element.querySelector('[data-app="music"] iframe')?.getAttribute("data-route")).toBe("/chat/music");
  expect(host.getSnapshot().tools.map(tool => tool.workspaceId).sort()).toEqual(["desktop-music", "desktop-notes"]);
  await click("notes", "discuss Notes"); expect(element.querySelector('[data-app="notes"] aside')?.hasAttribute("hidden")).toBe(true);
  await click("notes", "discuss Notes"); expect(element.querySelector('[data-app="notes"] iframe')).toBe(frame);
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  await render([notes, music], true); await render(); expect(element.querySelector('[data-app="notes"] iframe')).toBe(frame);
  await render([music]); expect(host.getSnapshot().tools).toHaveLength(1); expect(host.getSnapshot().tools[0].workspaceId).toBe("desktop-music");
  expect(element.querySelector('a[target="_blank"]')).toBeNull();
});
it("opens declared non-assistant tools without creating a conversation and switches without remounting", async () => {
  await render(); await click("notes", "Inspector"); const frame = element.querySelector('[data-app="notes"] iframe');
  expect(mocks.prepare).not.toHaveBeenCalled(); await click("notes", "discuss Notes"); await click("notes", "Inspector");
  expect(element.querySelector('[data-app="notes"] iframe')).toBe(frame); expect(host.getSnapshot().tools).toHaveLength(2);
});
it("coalesces clicks and reports a provider refusal without opening another window", async () => {
  let reject!: (error: Error) => void; mocks.prepare.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  await render(); await click("notes", "discuss Notes"); await click("notes", "discuss Notes");
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Assistant permission required")));
  expect(element.querySelector('[data-app="notes"] [role="alert"]')?.textContent).toContain("Assistant permission required");
  expect(host.getSnapshot().tools).toHaveLength(0);
});

it("refreshes the panel host before opening a prepared discussion after reconnection", async () => {
  await render();
  await act(async () => host.setActive(false));
  await act(async () => host.setActive(true));
  await click("notes", "discuss Notes");
  expect(element.querySelector('[data-app="notes"] iframe')?.getAttribute("data-route")).toBe("/chat/notes");
  expect(element.querySelector('[role="alert"]')).toBeNull();
});
