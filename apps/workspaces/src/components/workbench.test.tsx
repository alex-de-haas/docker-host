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
  state.query = "workspace=group"; state.revoked = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (state.revoked) return new Response(JSON.stringify({ message: "Source access was revoked." }), { status: 403 });
    const result = input === "/api/workspaces" ? { workspaces: [workspace], observedAt: "2026-10-09T10:00:00Z" }
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
  expect(fetch).toHaveBeenCalledTimes(1);
});
