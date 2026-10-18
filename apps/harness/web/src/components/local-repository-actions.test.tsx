// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalRepositoryActions } from "./local-repository-actions";
import { workspaceAction } from "@/lib/assistant-api";
import type { Worktree } from "@/lib/development-api";
vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
const tree: Worktree = { id: "a".repeat(64), workspaceId: "aggregate", repository: "/source/.git", branch: "hosty/session/test", state: "active", apps: [], pullRequests: [], leases: [], observation: { state: "ok", at: "now", head: "b".repeat(40), local: { files: [], truncated: false } } };
const remote = { acceptedHead: "c".repeat(40), remote: { repository: "https://github.com/owner/test.git", targetBranch: "qa/base", grant: { connectionId: "github" } }, observation: { at: "2026-10-17T12:00:00Z", state: "missing", related: false } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(workspaceAction).mockImplementation(async (_session, action) => action === "pr-list" ? { publications: [] } : remote);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const render = (disabled = false) => act(async () => root.render(<LocalRepositoryActions sessionId="session" appId="local.app" tree={tree} disabled={disabled} refresh={() => {}} />));
const click = async (text: string) => act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === text)!.click());
it("opening and cancelling publication review does not send source", async () => {
  await render(); await click("Publish accepted base…");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(remote.acceptedHead);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("qa/base");
  await click("Cancel");
  expect(vi.mocked(workspaceAction).mock.calls.map(c => c[1])).toEqual(["remote-status", "pr-list"]);
});
it("retries lost base publication with identical arguments after remount", async () => {
  await render(); await click("Publish accepted base…");
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("lost response"));
  await click("Confirm publish accepted base");
  const original = vi.mocked(workspaceAction).mock.calls.at(-1)!;
  expect(original[2]).toMatchObject({ expectedTargetHead: remote.acceptedHead, appId: "local.app", workspaceId: tree.id });
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.textContent).toContain("Unconfirmed: Publish accepted base");
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...remote, operation: { id: original[2]!.requestId, state: "succeeded" } });
  await click("Retry repository action");
  expect(vi.mocked(workspaceAction).mock.calls.at(-1)).toEqual(original);
  expect(localStorage.length).toBe(0);
});
it("allows a new reviewed request only after inspecting a terminal refusal", async () => {
  await render(); await click("Publish accepted base…");
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("stale base"));
  await click("Confirm publish accepted base");
  const request = vi.mocked(workspaceAction).mock.calls.at(-1)![2]!;
  await click("Cancel");
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...remote, operation: { id: request.requestId, state: "failed", error: "Review current base" } });
  await click("Check last action");
  expect(localStorage.length).toBe(0); expect(container.textContent).toContain("Review current base");
});
it("blocks mutations while the agent is active", async () => {
  await render(true); expect([...container.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
});
