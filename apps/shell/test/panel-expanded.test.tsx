import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyPanelWorkspace, HostyUiRoot, useHostyUiHost } from "@hosty-sdk/app/ui/react";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import type { UiBootstrap, UiPanel } from "@hosty-sdk/app/ui/types";
import { usePanelExpanded } from "../src/app/shell/chrome/use-panel-expanded";
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
let catalogGate: Promise<void> | null, refused: boolean;
const persisted = vi.fn();
function Shell({ initialOpen, link }: { initialOpen: boolean | null; link: boolean }) {
  const panelHost = useHostyUiHost();
  useEffect(() => { host = panelHost; }, [panelHost]);
  const expanded = usePanelExpanded(panelHost, initialOpen, link);
  useAssistantSessionLink({ host: panelHost, appId: "assistant", sessionId: link ? "existing" : null, userId: "alice", onOpened: () => {} });
  return <>
    <ShellTopStrip title="Plans" navigationWidth={60} leftRailExpanded={false} onToggleLeftRail={() => {}}
      rightRailExpanded={expanded} onToggleRightRail={() => panelHost?.setExpanded(!expanded)} showNotifications={false} onBrandClick={() => {}} />
    <HostyPanelWorkspace railMode="catalog" onExpandedChange={persisted}><div>Document</div></HostyPanelWorkspace>
  </>;
}
async function render(initialOpen: boolean | null, link = false) {
  await act(async () => root.render(<HostyUiRoot panelLayout="slot"><Shell initialOpen={initialOpen} link={link} /></HostyUiRoot>));
}
const toggle = (open: boolean) => container.querySelector<HTMLButtonElement>(`button[aria-label="${open ? "Hide" : "Show"} the panel"]`)!;
beforeEach(() => {
  host = null; catalogGate = null; refused = false; persisted.mockReset(); localStorage.clear();
  document.cookie = `${RIGHT_PANEL_OPEN_PREF_KEY}=; max-age=0; path=/`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.endsWith("panels")) { await catalogGate; return Response.json({ panels }); }
    if (url.endsWith("resolve")) {
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
