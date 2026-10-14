// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacesWorkbench } from "./workbench";
import type { Worktree, Workspace } from "@/lib/types";
const state = vi.hoisted(() => ({ query: "workspace=group", revoked: false }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
let root: Root; let container: HTMLDivElement;
const tree: Worktree = { id: "tree", workspaceId: "group", repository: "https://github.com/example/project.git", branch: "session/one", targetBranch: "main",
  originalBase: "a".repeat(40), integrationBase: "a".repeat(40), path: "/core/worktree", state: "active", apps: [], operations: [], leases: [],
  pullRequests: [], consumers: [], commits: [], sessionChanges: [{ path: "private.txt", status: "M" }], commitsTruncated: false, detailError: null,
  observation: { at: "2026-10-09T10:00:00Z", state: "ok", conflict: false, head: "b".repeat(40), sessionFiles: ["private.txt"], local: { files: [{ path: "private.txt", status: " M" }], truncated: false } } };
const workspace: Workspace = { id: "group", state: "active", worktrees: [tree], owner: { kind: "external", label: "Codex", reference: "task-one", appId: null, sessionUrl: null, sessionUnavailable: null } };
beforeEach(() => {
  state.query = "workspace=group"; state.revoked = false; tree.pullRequests = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (state.revoked) return new Response(JSON.stringify({ message: "Source access was revoked." }), { status: 403 });
    const result = input === "/api/environments" ? { environments: [] } : input === "/api/sandboxes" ? { instances: [] } : input === "/api/workspaces" ? { workspaces: [workspace], observedAt: "2026-10-09T10:00:00Z" }
      : input.includes("/diff?") ? { path: "private.txt", combined: "+private source contents", binary: false, truncated: false } : tree;
    return new Response(JSON.stringify(result));
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("renders a real file diff, then removes source and details when inventory authorization is revoked", async () => {
  await act(async () => root.render(<WorkspacesWorkbench />));
  expect(container.textContent).toContain("task-one");
  expect(container.querySelector('a[href*="session"]')).toBeNull();
  const file = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("private.txt"))!;
  await act(async () => file.click());
  expect(container.textContent).toContain("+private source contents");
  state.revoked = true;
  const refresh = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Refresh view"))!;
  await act(async () => refresh.click());
  expect(container.textContent).toContain("Source access was revoked.");
  expect(container.textContent).not.toContain("private source contents");
  expect(container.textContent).not.toContain("/core/worktree");
});
it("does not silently select a different worktree for an invalid deep link", async () => {
  state.query = "workspace=group&worktree=foreign";
  await act(async () => root.render(<WorkspacesWorkbench />));
  expect(container.textContent).toContain("requested worktree is not in this workspace");
  expect(fetch).toHaveBeenCalledWith("/api/workspaces", expect.anything());
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/worktrees/"))).toBe(false);
});

async function openPullRequests() {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(t => t.textContent?.startsWith("Pull requests"))!;
  await act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
}
it("shows tracked draft, CI, review summary and remote head differences", async () => {
  tree.pullRequests = [{ url: "https://github.com/example/project/pull/590", publishedHead: "c".repeat(40), unavailable: null,
    observation: { at: new Date().toISOString(), state: "open", draft: true, reviewDecision: "APPROVED", unresolvedThreads: 2, complete: false,
      checks: [{ name: "Core tests", state: "SUCCESS" }, { name: "Workspaces build", state: "IN_PROGRESS" }] } }];
  await act(async () => root.render(<WorkspacesWorkbench />)); await openPullRequests();
  for (const text of ["Draft", "Recently observed", "APPROVED", "2 unresolved threads", "Core tests", "SUCCESS", "IN_PROGRESS", "differs from this worktree"])
    expect(container.textContent).toContain(text);
  tree.pullRequests = [{ ...tree.pullRequests[0], observation: null, unavailable: "PR tracking is not connected. Reconnect the source account." }];
  const refresh = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Refresh view"))!;
  await act(async () => refresh.click());
  expect(container.textContent).toContain("Reconnect the source account");
  expect(container.textContent).not.toContain("Core tests");
  expect(container.textContent).not.toContain("APPROVED");
});
it("distinguishes an unobserved reference from an old observation", async () => {
  tree.pullRequests = [{ url: "https://github.com/example/project/pull/590", publishedHead: null, observation: null,
    unavailable: "Waiting for the next provider observation." }];
  await act(async () => root.render(<WorkspacesWorkbench />)); await openPullRequests();
  expect(container.textContent).toContain("Awaiting provider data");
  expect(container.textContent).not.toContain("Stale");
  tree.pullRequests = [{ ...tree.pullRequests[0], unavailable: null, observation: { at: "2020-01-01T00:00:00Z", state: "merged", draft: false, unresolvedThreads: 0, complete: true } }];
  const refresh = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Refresh view"))!;
  await act(async () => refresh.click());
  expect(container.textContent).toContain("merged");
  expect(container.textContent).toContain("Stale");
  expect(container.textContent).toContain("No review decision");
});
