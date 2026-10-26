import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiPanel } from "@hosty-sdk/app/ui";
import type { App } from "../src/lib/model";
const mutation = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ desktopMutation: mutation }));
import { prepareWindowDiscussion, createWindowPlacement } from "../src/lib/window-tools";
const panel = { panel: { appId: "helper", installationId: "i1", panelId: "chat" } } as UiPanel;
const context = { id: "notes", installationId: "notes-1" } as App;
const app = { id: "helper", installationId: "i1", confirmedRoles: ["assistant"], interfaces: { assistant: [{ key: "default", version: 1, capabilities: [] }] } } as unknown as App;
beforeEach(() => { sessionStorage.clear(); mutation.mockReset(); });
afterEach(() => vi.restoreAllMocks());
it("reuses uncertain handoffs only for the same actor, context and provider installation", async () => {
  mutation.mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValue({ target: { panel: panel.panel, route: "/chat/one" } });
  await expect(prepareWindowDiscussion("alice", context, panel, [app])).rejects.toThrow("connection lost");
  const recovered = await prepareWindowDiscussion("alice", context, panel, [app]);
  expect(mutation.mock.calls[1][1].requestId).toBe(mutation.mock.calls[0][1].requestId);
  await prepareWindowDiscussion("bob", context, panel, [app]);
  await prepareWindowDiscussion("alice", { ...context, id: "music" }, panel, [app]);
  expect(new Set(mutation.mock.calls.map(call => call[1].requestId)).size).toBe(3);
  recovered.complete(); await prepareWindowDiscussion("alice", context, panel, [app]);
  expect(mutation.mock.calls.at(-1)![1].requestId).not.toBe(mutation.mock.calls[0][1].requestId);
});
it("keeps embedded tool requests in their source window and removes completed placement bindings", async () => {
  const placement = createWindowPlacement(), target = { panel: panel.panel, route: "/chat/one" };
  const decide = (workspaceId: string) => placement.resolve({ source: { viewId: "view", workspaceId }, target, presentations: [] });
  const host = { openSurface: async () => {
    expect(decide("default").workspaceId).toBe("desktop-notes");
    expect(decide("desktop-music").workspaceId).toBe("desktop-music");
    return { status: "opened" };
  } };
  await placement.open(host as never, "desktop-notes", target);
  expect(decide("default").workspaceId).toBe("default");
});
