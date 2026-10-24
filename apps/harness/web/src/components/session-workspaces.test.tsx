// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionWorkspaces } from "./session-workspaces";
import { workspaceAction, type AssistantSession, type Workspace, type Publication } from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn() }));
vi.mock("@/lib/workspace-events", () => ({ subscribeWorkspaceEvents: (_url: string, sync: () => Promise<void>) => { void sync(); return () => {}; } }));
let root: Root; let container: HTMLDivElement;
const session = { id: "one", appIds: ["notes"] } as AssistantSession;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => action === "pr-list" ? { publications: [] } : { workspaces: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = (running = false, record = session) => act(async () => root.render(<SessionWorkspaces session={record} running={running} />));
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
const open = async () => act(async () => { const details = container.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
const select = async (label: string, option: string) => {
  await act(async () => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === option)!;
  expect(item).toBeDefined();
  await act(async () => item.click());
};
it("allocates only on request and reuses the request identity after a lost response", async () => {
  await render(); await open();
  expect(vi.mocked(workspaceAction).mock.calls.every(call => ["list", "pr-list"].includes(call[1]))).toBe(true);
  await select("Source app", "notes");
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("Lost response"));
  await act(async () => button("Prepare worktree").click());
  const first = vi.mocked(workspaceAction).mock.calls.find(call => call[1] === "prepare")!;
  expect(first[2]).toMatchObject({ appId: "notes", requestId: expect.any(String) });
  vi.mocked(workspaceAction).mockResolvedValueOnce({ operations: [] }).mockImplementation(async (_id, action) => action === "pr-list" ? { publications: [] } : { workspaces: [] });
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(workspaceAction).mock.calls.filter(call => call[1] === "prepare")).toEqual([first, first]);
  await render(true);
  expect(button("Prepare worktree").disabled).toBe(true);
});

it("shows a closed draft publication as Closed", async () => {
  const publication: Publication = { workspaceId: "tree", repository: "owner/repo", branch: "work", targetBranch: "main",
    cleanupRequested: false, dependencies: [], history: [], operations: [],
    observation: { at: new Date().toISOString(), state: "closed", draft: true, unresolvedThreads: 0, complete: false } };
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => action === "pr-list" ? { publications: [publication] } : { workspaces: [] });
  await render(); await open();
  const card = container.querySelector('[aria-label="Publication owner/repo"]');
  expect(card?.querySelector("p")?.textContent).toBe("owner/repo · Closed");
  expect(card?.textContent).not.toContain("Draft PR");
  expect(vi.mocked(workspaceAction).mock.calls.every(([, action]) => ["list", "pr-list"].includes(action))).toBe(true);
});

it("shows non-Error failures during initial load and manual refresh", async () => {
  vi.mocked(workspaceAction).mockRejectedValue("List unavailable");
  await render(); await open();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("List unavailable");
  vi.mocked(workspaceAction).mockRejectedValue(null);
  await act(async () => button("Refresh").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("null");
});

it("keeps empty and detached source selections explicit without preparing another app", async () => {
  await render(); await open();
  expect(button("Prepare worktree").disabled).toBe(true);
  await select("Source app", "notes");
  expect(button("Prepare worktree").disabled).toBe(false);
  await render(false, { ...session, appIds: ["other"] });
  expect(workspaceAction).not.toHaveBeenCalledWith("one", "prepare", expect.anything());
  expect(container.querySelector('[aria-label="Source app"]')?.textContent).not.toContain("other");
  await select("Source app", "Choose an attached app");
  expect(button("Prepare worktree").disabled).toBe(true);
});

it("switches diff views without applying a late response from the previous view", async () => {
  const workspace: Workspace = { id: "tree", path: "/work/tree", repository: "owner/repo", branch: "work", state: "active", originalBase: "base", targetBranch: "main", leases: [], apps: [{ appId: "notes" }], pullRequests: [], operations: [], observation: { state: "ok", at: new Date().toISOString(), head: "head", sessionFiles: ["committed.txt"], local: { files: [{ path: "local.txt", status: "modified" }] } } };
  let completeOld!: (value: unknown) => void;
  vi.mocked(workspaceAction).mockImplementation(async (_id, action, input) => {
    if (action === "pr-list") return { publications: [] };
    if (action === "viewer") return {};
    if (action === "diff") return input?.view === "session" ? new Promise(resolve => { completeOld = resolve; }) : { path: "local.txt", combined: "current local diff" };
    return { workspaces: [workspace] };
  });
  await render(); await open();
  await act(async () => button("committed.txt").click());
  expect(workspaceAction).toHaveBeenCalledWith("one", "diff", { workspaceId: "tree", path: "committed.txt", view: "session" });
  await select("Workspace diff view", "Uncommitted changes");
  expect(container.textContent).not.toContain("committed.txt");
  await act(async () => button("local.txt").click());
  expect(workspaceAction).toHaveBeenCalledWith("one", "diff", { workspaceId: "tree", path: "local.txt", view: "local" });
  await act(async () => completeOld({ path: "committed.txt", combined: "stale session diff" }));
  expect(container.querySelector('[aria-label="Changes in local.txt"]')?.textContent).toBe("current local diff");
  expect(container.textContent).not.toContain("stale session diff");
});

it.each(["empty", "failure"])("does not claim an empty inventory before the initial %s read completes", async outcome => {
  let resolveList!: (value: unknown) => void;
  let rejectList!: (cause: Error) => void;
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => action === "pr-list" ? { publications: [] } : new Promise((resolve, reject) => { resolveList = resolve; rejectList = reject; }));
  await render(); await open();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading source workspaces…");
  expect(container.textContent).not.toContain("No worktrees for this session.");
  expect(vi.mocked(workspaceAction).mock.calls.every(([, action]) => ["list", "pr-list"].includes(action))).toBe(true);
  await act(async () => { if (outcome === "empty") resolveList({ workspaces: [] }); else rejectList(new Error("Inventory unavailable")); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  if (outcome === "empty") expect(container.textContent).toContain("No worktrees for this session.");
  else {
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Inventory unavailable");
    expect(container.textContent).not.toContain("No worktrees for this session.");
  }
});
