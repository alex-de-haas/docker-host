import { expect, it } from "vitest";
import { navigationItems, workspaceCounts, workspaceSessionIds } from "./workspace-navigation";
import type { DevelopmentWorkspace, WorkspaceParticipation } from "./development-api";
import type { AssistantSession } from "./assistant-api";
const now = Date.parse("2026-10-25T20:00:00Z");
const participant = (id: string, status: string, canOpen = false): WorkspaceParticipation["sessions"][number] => ({
  appId: "assistant", userId: canOpen ? "me" : "other", sessionId: id, title: id, attached: true, canOpen,
  viewerPath: canOpen ? `/development?session=${id}` : null, status, activityAt: new Date(now).toISOString(), changedAt: new Date(now - 60_000).toISOString(),
});
const workspace = (bindings: WorkspaceParticipation["sessions"]): DevelopmentWorkspace => ({
  id: "shared", name: "Shared source", state: "active", owner: { kind: "assistant", reference: "owner", label: "Owner" },
  workflow: { state: "in-progress", revision: 1 }, worktrees: [], participation: {
    id: "shared", revision: 1, role: "contributor", viewerUserId: "me", members: [], sessions: bindings, eligibleUsers: [],
  },
});
it("counts each current participant once across simultaneous work, attention, and failure without exposing private tabs", () => {
  const space = workspace([participant("my", "running", true), participant("foreign-work", "running"), participant("approval", "awaiting_approval"), participant("question", "awaiting_question"), participant("error", "failed"), participant("idle", "idle")]);
  expect(workspaceCounts(space, [], now)).toEqual({ working: 2, waiting: 2, failed: 1, unknown: 0 });
  expect(workspaceSessionIds(space)).toEqual(["my"]);
  const items = navigationItems([space], [], now);
  expect(items).toHaveLength(1); expect(items[0].search).toContain("foreign-work"); expect(items[0].matches).toEqual([]);
});
it("expires active observations while retaining terminal failures and never infers external activity from leases", () => {
  const space = workspace([participant("work", "running"), participant("failed", "failed"), participant("waiting", "awaiting_question"), participant("stopping", "stopping")]);
  expect(workspaceCounts(space, [], now + 50_000)).toEqual({ working: 0, waiting: 0, failed: 1, unknown: 3 });
  expect(workspaceCounts({ ...space, owner: { kind: "external", label: "Codex", reference: "task" } }, [], now)).toEqual({ working: 0, waiting: 0, failed: 0, unknown: 0 });
});
it("uses newer authorized own-session changes without aliasing a foreign session with the same id", () => {
  const space = workspace([participant("same", "failed", true), participant("same", "awaiting_question")]);
  const mine = { id: "same", status: "running", createdAt: new Date(now).toISOString(), updatedAt: new Date(now + 1000).toISOString() } as AssistantSession;
  expect(workspaceCounts(space, [mine], now)).toEqual({ working: 1, waiting: 1, failed: 0, unknown: 0 });
  expect(workspaceCounts(space, [{ ...mine, status: "idle" }], now)).toEqual({ working: 0, waiting: 1, failed: 0, unknown: 0 });
});
it("keeps workspace ordering stable and lists all chats independently of attachment", () => {
  const space = workspace([participant("mine", "idle", true)]);
  const mine = { id: "mine", title: "My chat", status: "idle", createdAt: new Date(now - 60_000).toISOString() } as AssistantSession;
  const solo = { ...mine, id: "solo", createdAt: new Date(now - 30_000).toISOString() };
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["workspace:shared"]);
  space.participation!.sessions[0].activityAt = new Date(now + 60_000).toISOString();
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["workspace:shared"]);
  expect(navigationItems([space], [mine, solo], now, "chats").map(i => i.key)).toEqual(["session:solo", "session:mine"]);
  space.participation!.sessions[0].attached = false;
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["workspace:shared"]);
});
