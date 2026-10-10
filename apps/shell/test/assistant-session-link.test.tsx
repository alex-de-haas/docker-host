import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUiHost, type UiHost } from "@hosty-sdk/app/ui/host";
import type { UiBootstrap, UiPanel } from "@hosty-sdk/app/ui/types";
import { useAssistantSessionLink } from "../src/app/shell/assistant/use-assistant-session-link";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const policy = { microphone: false, popupEscape: false };
const bootstrap: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "shell", installationId: "shell-1", origins: ["http://localhost:3000"] } };
const panels: UiPanel[] = ["notes", "assistant"].map(appId => ({ panel: { appId, installationId: `${appId}-1`, panelId: "tool" },
  endpoint: "web", route: "/panel", origin: `https://${appId}.test`, label: appId, appName: appId, icon: null,
  available: true, state: "running", canStart: false, framePolicy: policy }));
let root: Root, container: HTMLDivElement, host: UiHost;
let catalogGate: Promise<void> | null, placementGate: Promise<void> | null, refused: boolean;
const opened = vi.fn();
function Link({ sessionId = "existing", userId = "alice" }: { sessionId?: string | null; userId?: string }) {
  useAssistantSessionLink({ host, appId: "assistant", sessionId, userId, onOpened: opened });
  return null;
}
beforeEach(() => {
  catalogGate = null; placementGate = null; refused = false; opened.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.endsWith("panels")) { await catalogGate; return Response.json({ panels }); }
    if (url.endsWith("resolve")) {
      await placementGate;
      if (refused) return Response.json({ code: "access_unavailable" }, { status: 403 });
      const target = JSON.parse(init!.body as string), panel = panels.find(item => item.panel.appId === target.panel.appId)!;
      return Response.json({ target: { ...target, route: panel.route }, available: true, state: "running", standaloneHref: "https://core.test/open",
        surface: { ...panel.panel, endpoint: panel.endpoint, origin: panel.origin, route: panel.route, framePolicy: policy } });
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
