
// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { subscribeWorkspaceEvents } from "./workspace-events";
import { orderWorkspaces, useDevelopmentInventory, type DevelopmentWorkspace } from "./development-api";
it("orders external workspace activity independently of observation polling and leaves input unchanged", () => {
  const workspace = (id: string, updatedAt: string | null, observed: string) => ({ id, updatedAt, workflow: { state: "in-progress", revision: 1 },
    owner: { kind: "external", label: id, reference: id }, state: "active", worktrees: [{ observation: { at: observed } }] }) as DevelopmentWorkspace;
  const input = [workspace("z-old", "2026-10-12", "2026-10-20"), workspace("new", "2026-10-18", "2026-10-18"), workspace("a-unknown", null, "2026-10-30")];
  expect(orderWorkspaces(input).map(w => w.id)).toEqual(["new", "z-old", "a-unknown"]);
  expect(input.map(w => w.id)).toEqual(["z-old", "new", "a-unknown"]);
  expect(orderWorkspaces([workspace("z", "bad", ""), workspace("a", null, "")]).map(w => w.id)).toEqual(["a", "z"]);
});

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
vi.mock("./workspace-events", () => ({ subscribeWorkspaceEvents: vi.fn() }));

it("waits for the first inventory read without treating background reads as initial loading", async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let sync!: () => Promise<void | boolean>;
  vi.mocked(subscribeWorkspaceEvents).mockImplementation((_url, callback) => { sync = callback; return vi.fn(); });
  let latest!: ReturnType<typeof useDevelopmentInventory>;
  function Probe({ enabled }: { enabled: boolean }) {
    const inventory = useDevelopmentInventory(enabled);
    useEffect(() => { latest = inventory; }, [inventory]);
    return null;
  }
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Probe, { enabled: false })));
    expect(latest.loading).toBe(false); expect(subscribeWorkspaceEvents).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { enabled: true })));
    expect(latest.loading).toBe(true);
    vi.mocked(appFetch).mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [] })));
    await act(async () => { await sync(); });
    expect(latest.loading).toBe(false); expect(latest.error).toBe("");
    let reject!: (error: Error) => void;
    vi.mocked(appFetch).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    let refreshing!: Promise<void | boolean>;
    await act(async () => { refreshing = sync(); });
    expect(latest.loading).toBe(false);
    await act(async () => { reject(new Error("Offline")); await refreshing; });
    expect(latest.loading).toBe(false); expect(latest.error).toBe("Offline");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("settles initial loading when the workspace stream is unavailable", async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let unavailable!: () => void;
  vi.mocked(subscribeWorkspaceEvents).mockImplementation((_url, _callback, callback) => { unavailable = callback!; return vi.fn(); });
  let latest!: ReturnType<typeof useDevelopmentInventory>;
  function Probe() {
    const inventory = useDevelopmentInventory(true);
    useEffect(() => { latest = inventory; }, [inventory]);
    return null;
  }
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(latest.loading).toBe(true);
    await act(async () => unavailable());
    expect(latest.loading).toBe(false); expect(latest.error).toContain("disconnected");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
