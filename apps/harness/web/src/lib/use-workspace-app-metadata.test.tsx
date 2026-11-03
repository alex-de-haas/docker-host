// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
import { selectedContextApps, type ContextApp } from "./assistant-api";
import { useWorkspaceAppMetadata } from "./use-workspace-app-metadata";
import type { Worktree } from "./development-api";
vi.mock("./assistant-api", () => ({ selectedContextApps: vi.fn() }));
let root: Root, container: HTMLDivElement;
function Probe({ ids, workspace = "one", refresh = 0 }: { ids: string[]; workspace?: string; refresh?: number }) {
  const apps = useWorkspaceAppMetadata(workspace, [{ apps: ids.map(appId => ({ appId, name: appId })) } as Worktree], [], refresh);
  return <div>{apps.map(app => app.displayName).join(",")}</div>;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("deduplicates and batches workspace bindings without periodic reads", async () => {
  vi.mocked(selectedContextApps).mockImplementation(async ids => ids.map(id => ({ id, displayName: id, available: true })));
  const ids = Array.from({ length: 18 }, (_, i) => `app${i}`);
  await act(async () => root.render(<Probe ids={[...ids, ids[0]]} />));
  expect(vi.mocked(selectedContextApps).mock.calls.map(([batch]) => batch.length)).toEqual([16, 2]);
  await act(async () => root.render(<Probe ids={[...ids]} />));
  expect(selectedContextApps).toHaveBeenCalledTimes(2);
});
it("discards a late result after workspace selection changes", async () => {
  let resolve!: (apps: ContextApp[]) => void;
  vi.mocked(selectedContextApps).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue([{ id: "new", displayName: "New", available: true }]);
  await act(async () => root.render(<Probe ids={["old"]} />));
  const signal = vi.mocked(selectedContextApps).mock.calls[0][1]!;
  await act(async () => root.render(<Probe workspace="two" ids={["new"]} />));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve([{ id: "old", displayName: "Old", available: true }]));
  expect(container.textContent).toBe("New");
});
it("recovers failed metadata after access restoration and clears a failed refresh", async () => {
  vi.mocked(selectedContextApps).mockRejectedValueOnce(new Error("Expired access")).mockResolvedValueOnce([{ id: "media", displayName: "Media", available: true }]).mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => root.render(<Probe ids={["media"]} />));
  expect(container.textContent).toBe("");
  await act(async () => window.dispatchEvent(new Event(APP_SESSION_RESTORED)));
  expect(container.textContent).toBe("Media");
  await act(async () => root.render(<Probe ids={["media"]} refresh={1} />));
  expect(container.textContent).toBe("");
});
