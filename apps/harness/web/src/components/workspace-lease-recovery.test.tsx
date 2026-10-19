// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceLeaseRecovery } from "./workspace-lease-recovery";
import { DevelopmentRequestError, developmentRequest, type Worktree } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
const closed = vi.fn(), changed = vi.fn();
beforeEach(() => { localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const tree: Worktree = { id: "tree", workspaceId: "workspace", repository: "https://example.test/repo.git", branch: "work", state: "active", path: "/retained/source", apps: [], leases: ["lease", "second"], pullRequests: [], observation: { at: "now", state: "ok", head: "head" } };
const close = { kind: "close", requestId: "original-close", expectedRevision: 3 };
const render = async (closure = "closing", trees = [tree], request: typeof close | null = close) => act(async () => root.render(<WorkspaceLeaseRecovery workspaceId="workspace" trees={trees} closure={closure} closeRequest={request} disabled={false} refresh={() => {}} onClosed={closed} onBusyChange={changed} />));
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
const confirm = async () => { await act(async () => button("Confirm work has stopped…").click()); await act(async () => button("Work has stopped — pause workspace").click()); };
it("requires closed admission and one explicit confirmation, then recovers every reviewed lease and the original Close", async () => {
  await render("open"); expect(container.textContent).toBe(""); expect(developmentRequest).not.toHaveBeenCalled();
  await render(); await act(async () => button("Confirm work has stopped…").click());
  expect(developmentRequest).not.toHaveBeenCalled();
  vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/workflow/") ? { closure: "closed" } as never : {} as never);
  await act(async () => button("Work has stopped — pause workspace").click());
  expect(developmentRequest).toHaveBeenNthCalledWith(1, "/workspace/worktrees/tree/recover-lease", expect.objectContaining({ leaseId: "lease", expectedHead: "head", consumerExitConfirmed: true }));
  expect(developmentRequest).toHaveBeenNthCalledWith(2, "/workspace/worktrees/tree/recover-lease", expect.objectContaining({ leaseId: "second" }));
  expect(developmentRequest).toHaveBeenNthCalledWith(3, "/workspace/workflow/close", { requestId: "original-close", expectedRevision: 3 });
  expect(closed).toHaveBeenCalledWith({ closure: "closed" });
});
it.each(["pause", "close", "defer"])("replays partial %s recovery without changing the action or releasing newly observed leases", async kind => {
  const request = { ...close, kind };
  localStorage.setItem("hosty.workspace.action.workspace", JSON.stringify(close));
  vi.mocked(developmentRequest).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Response lost"));
  await render("closing", [tree], request); await confirm();
  const original = vi.mocked(developmentRequest).mock.calls.slice();
  await act(async () => root.unmount()); root = createRoot(container);
  await render("closing", [{ ...tree, leases: ["second", "unreviewed"] }], request);
  vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/workflow/") ? { closure: "closed" } as never : {} as never);
  await act(async () => button("Retry pausing").click());
  expect(vi.mocked(developmentRequest).mock.calls.slice(2, 4)).toEqual(original);
  expect(developmentRequest).toHaveBeenLastCalledWith(`/workspace/workflow/${kind}`, { requestId: close.requestId, expectedRevision: close.expectedRevision });
  expect(vi.mocked(developmentRequest).mock.calls.some(([, body]) => body?.leaseId === "unreviewed")).toBe(false);
  expect(localStorage.getItem("hosty.workspace.action.workspace")).toBe(JSON.stringify(close));
  expect(localStorage.getItem("hosty.workspace.close-recovery.workspace")).toBeNull();
});
it("retries lost Close acknowledgement even when all leases are already gone", async () => {
  await render(); vi.mocked(developmentRequest).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Close response lost")); await confirm();
  await act(async () => root.unmount()); root = createRoot(container); await render("closing", [{ ...tree, leases: [] }]);
  vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/workflow/") ? { closure: "closed" } as never : {} as never);
  await act(async () => button("Retry pausing").click()); expect(closed).toHaveBeenCalled();
  expect(vi.mocked(developmentRequest).mock.calls[5]).toEqual(["/workspace/workflow/close", { requestId: "original-close", expectedRevision: 3 }]);
});
it("requires a fresh confirmation after stale HEAD and blocks known runtime consumers", async () => {
  await render(); vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Review current source", "workspace_stale_head")); await confirm();
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(localStorage.getItem("hosty.workspace.close-recovery.workspace")).toBeNull();
  expect(container.textContent).toContain("Review current source");
  await render("closing", [{ ...tree, consumers: [{ kind: "local-service", reference: "hosty.harness/api" }] }]);
  expect(button("Confirm work has stopped…").disabled).toBe(true);
});
it("keeps the legacy single-lease request identity when starting the new close flow", async () => {
  localStorage.setItem("hosty.workspace.lease-recovery.workspace", JSON.stringify({ treeId: "tree", leaseId: "lease", expectedHead: "head", requestId: "legacy", consumerExitConfirmed: true }));
  await render(); vi.mocked(developmentRequest).mockRejectedValue(new Error("Offline")); await confirm();
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/worktrees/tree/recover-lease", expect.objectContaining({ requestId: "legacy" }));
});

it("explains the sandbox source protection before asking for external-exit confirmation", async () => {
  await render("closing", [{ ...tree, hasSandboxConsumers: true }]);
  expect(button("Confirm work has stopped…").disabled).toBe(true);
  expect(container.textContent).toContain("Delete the sandboxes using these sources");
  expect(developmentRequest).not.toHaveBeenCalled();
});

it.each([false, true])("retires lost Close acknowledgements before a new cycle (remount: %s)", async remount => {
  await render();
  vi.mocked(developmentRequest).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Close response lost"));
  await confirm();
  const oldRequests = vi.mocked(developmentRequest).mock.calls.slice(0, 2).map(([, body]) => body?.requestId);
  if (remount) { await act(async () => root.unmount()); root = createRoot(container); }
  // The server receipt arrives independently of the lost HTTP response.
  await render("closed", [{ ...tree, leases: [] }], null);
  expect(localStorage.getItem("hosty.workspace.close-recovery.workspace")).toBeNull();
  await render("open", [tree], null);
  const next = { ...close, requestId: "next-close", expectedRevision: 7 };
  await render("closing", [tree], next);
  expect(button("Retry pausing")).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/workflow/") ? { closure: "closed" } as never : {} as never);
  await confirm();
  expect(vi.mocked(developmentRequest).mock.calls.slice(3, 5).every(([, body]) => !oldRequests.includes(body?.requestId))).toBe(true);
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/workflow/close", { requestId: "next-close", expectedRevision: 7 });
});
it("ignores an older persisted batch when a new Close is already in progress", async () => {
  await render(); vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Offline")); await confirm();
  await act(async () => root.unmount()); root = createRoot(container);
  await render("closing", [tree], { ...close, requestId: "new-close", expectedRevision: 8 });
  expect(button("Retry pausing")).toBeUndefined();
  expect(button("Confirm work has stopped…").disabled).toBe(false);
  expect(localStorage.getItem("hosty.workspace.close-recovery.workspace")).toBeNull();
});
it("preserves an uncertain batch while the parent temporarily lacks a Close request", async () => {
  await render(); vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Offline")); await confirm();
  const journal = localStorage.getItem("hosty.workspace.close-recovery.workspace");
  await render("closing", [tree], null);
  expect(localStorage.getItem("hosty.workspace.close-recovery.workspace")).toBe(journal);
  await render(); expect(button("Retry pausing")).toBeDefined();
});
