import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUiHost, type UiHost } from "@hosty-sdk/app/ui/host";
import type { UiBootstrap, UiPanel } from "@hosty-sdk/app/ui/types";
import { useAssistantSessionLink } from "../src/app/shell/assistant/use-assistant-session-link";
import { toggleAssistantPanel } from "../src/app/shell/assistant/assistant-client";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const policy = { microphone: false, popupEscape: false };
const bootstrap: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "shell", installationId: "shell-1", origins: ["http://localhost:3000"] } };
const panels: UiPanel[] = ["notes", "assistant"].map(appId => ({ panel: { appId, installationId: `${appId}-1`, panelId: "tool" },
  endpoint: "web", route: "/panel", origin: `https://${appId}.test`, label: appId, appName: appId, icon: null,
  available: true, state: "running", canStart: false, framePolicy: policy }));
let root: Root, container: HTMLDivElement, host: UiHost;
let catalogGate: Promise<void> | null, placementGate: Promise<void> | null, refused: boolean;
let listedPanels: UiPanel[];
const opened = vi.fn();
function Link({ sessionId = "existing", userId = "alice", appId = "assistant", assistantIds = ["assistant"], panelId = null }: { sessionId?: string | null; userId?: string; appId?: string; assistantIds?: string[]; panelId?: string | null }) {
  useAssistantSessionLink({ host, appId, assistantIds, panelId, sessionId, userId, onOpened: opened });
  return null;
}
beforeEach(() => {
  catalogGate = null; placementGate = null; refused = false; opened.mockReset(); listedPanels = panels;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.endsWith("panels")) { await catalogGate; return Response.json({ panels: listedPanels }); }
    if (url.endsWith("resolve")) {
      await placementGate;
      if (refused) return Response.json({ code: "access_unavailable" }, { status: 403 });
      const target = JSON.parse(init!.body as string), panel = listedPanels.find(item => item.panel.appId === target.panel.appId && item.panel.panelId === target.panel.panelId)!;
      return Response.json({ target: { ...target, route: target.route ?? panel.route }, available: true, state: "running", standaloneHref: "https://core.test/open",
        surface: { ...panel.panel, endpoint: panel.endpoint, origin: panel.origin, route: target.route ?? panel.route, framePolicy: policy } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); host.dispose(); container.remove(); vi.unstubAllGlobals(); });
const placements = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("resolve"));
async function mount(userId = "alice") {
  host = createUiHost();
  await act(async () => root.render(<Link userId={userId} />));
}

it("waits for the independent catalog and successful placement before consuming a session link", async () => {
  let catalogReady!: () => void, placementReady!: () => void;
  catalogGate = new Promise<void>(resolve => { catalogReady = resolve; });
  placementGate = new Promise<void>(resolve => { placementReady = resolve; });
  await mount();
  expect(opened).not.toHaveBeenCalled(); expect(placements()).toHaveLength(0);
  await act(async () => { catalogReady(); await host.refresh(); });
  expect(opened).not.toHaveBeenCalled(); expect(placements()).toHaveLength(1);
  await act(async () => placementReady());
  expect(host.getSnapshot().selected?.appId).toBe("assistant");
  expect(opened).toHaveBeenCalledTimes(1);
  await act(async () => host.refresh());
  expect(placements()).toHaveLength(1); expect(opened).toHaveBeenCalledTimes(1);
});
it("retains the link after a refusal and retries on refreshed catalog metadata", async () => {
  refused = true;
  await mount();
  expect(opened).not.toHaveBeenCalled(); expect(placements()).toHaveLength(1);
  await act(async () => { host.setWidth(420); host.setExpanded(false); });
  expect(placements()).toHaveLength(1);
  refused = false;
  await act(async () => host.refresh());
  expect(opened).toHaveBeenCalledTimes(1); expect(placements()).toHaveLength(2);
});
it("does not consume a departed link when an older placement completes", async () => {
  let release!: () => void;
  placementGate = new Promise<void>(resolve => { release = resolve; });
  await mount();
  expect(placements()).toHaveLength(1);
  await act(async () => root.render(<Link sessionId={null} />));
  await act(async () => release());
  expect(opened).not.toHaveBeenCalled();
});
it("does not open a link with another account's host metadata", async () => {
  await mount("bob");
  expect(opened).not.toHaveBeenCalled(); expect(placements()).toHaveLength(0);
});
it("selects the notification's explicit panel even when the same app's other tool is first", async () => {
  listedPanels = [{ ...panels[1], panel: { ...panels[1].panel, panelId: "other" }, route: "/other" }, panels[1]];
  host = createUiHost();
  await act(async () => root.render(<Link panelId="tool" />));
  expect(host.getSnapshot().selected).toEqual(panels[1].panel);
  expect(placements()).toHaveLength(1);
  expect(opened).toHaveBeenCalledWith({ panel: panels[1].panel, route: "/panel" });
});
it.each([null, "missing", "tool"])("retains an ambiguous or unavailable explicit panel link (%s)", async panelId => {
  listedPanels = [{ ...panels[1], panel: { ...panels[1].panel, panelId: "other" }, route: "/other" }, { ...panels[1], available: false }];
  host = createUiHost();
  await act(async () => root.render(<Link panelId={panelId} />));
  await act(async () => host.refresh());
  expect(placements()).toHaveLength(0); expect(opened).not.toHaveBeenCalled();
});
it("uses the declared panel route instead of reusing another discussion's route for a session command", async () => {
  host = createUiHost(); await host.refresh();
  await host.openSurface({ panel: panels[1].panel, route: "/panel?session=previous" }, { placement: "side", requestId: crypto.randomUUID() });
  await act(async () => root.render(<Link panelId="tool" />));
  expect(host.getSnapshot().tools[0].target.route).toBe("/panel");
  expect(opened).toHaveBeenCalledWith({ panel: panels[1].panel, route: "/panel" });
});
it.each(["notes", "former-assistant"])("does not place or consume a session link for non-assistant %s", async appId => {
  host = createUiHost();
  await act(async () => root.render(<Link appId={appId} />));
  await act(async () => host.refresh());
  expect(placements()).toHaveLength(0);
  expect(opened).not.toHaveBeenCalled();
  expect(host.getSnapshot().selected).toBeNull();
});
it("retains the link until assistant discovery confirms the requested app", async () => {
  host = createUiHost();
  await act(async () => root.render(<Link assistantIds={[]} />));
  await act(async () => host.refresh());
  expect(placements()).toHaveLength(0); expect(opened).not.toHaveBeenCalled();
  await act(async () => root.render(<Link />));
  expect(placements()).toHaveLength(1); expect(opened).toHaveBeenCalledTimes(1);
});
it("does not consume a pending link after the destination loses its assistant role", async () => {
  let release!: () => void;
  placementGate = new Promise<void>(resolve => { release = resolve; });
  await mount();
  await act(async () => root.render(<Link assistantIds={[]} />));
  await act(async () => release());
  expect(opened).not.toHaveBeenCalled();
});
it("opens only the requested assistant when another tool is first in the catalog", async () => {
  host = createUiHost(); await host.refresh();
  await toggleAssistantPanel(host, "assistant");
  expect(host.getSnapshot().selected?.appId).toBe("assistant");
  expect(host.getSnapshot().expanded).toBe(true);
  expect(placements().map(([, init]) => JSON.parse(init!.body as string).panel.appId)).toEqual(["assistant"]);
});
it("collapses an already selected assistant without opening another tool", async () => {
  host = createUiHost(); await host.refresh();
  await toggleAssistantPanel(host, "assistant");
  await toggleAssistantPanel(host, "assistant");
  expect(host.getSnapshot().expanded).toBe(false);
  expect(placements()).toHaveLength(1);
});
it("waits for shortcut catalog metadata before selecting and expanding the assistant", async () => {
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => { release = resolve; });
  host = createUiHost();
  const opening = toggleAssistantPanel(host, "assistant");
  expect(host.getSnapshot().expanded).toBe(false);
  expect(placements()).toHaveLength(0);
  release(); await opening;
  expect(host.getSnapshot().selected?.appId).toBe("assistant");
  expect(placements()).toHaveLength(1);
});
