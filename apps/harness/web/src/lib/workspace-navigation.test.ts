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
  expect(workspaceCounts({ ...space, participation: undefined, owner: { kind: "external", label: "Codex", reference: "task" } }, [], now)).toEqual({ working: 0, waiting: 0, failed: 0, unknown: 0 });
});
it("uses newer authorized own-session changes without aliasing a foreign session with the same id", () => {
  const space = workspace([participant("same", "failed", true), participant("same", "awaiting_question")]);
  const mine = { id: "same", status: "running", createdAt: new Date(now).toISOString(), updatedAt: new Date(now + 1000).toISOString() } as AssistantSession;
  expect(workspaceCounts(space, [mine], now)).toEqual({ working: 1, waiting: 1, failed: 0, unknown: 0 });
  expect(workspaceCounts(space, [{ ...mine, status: "idle" }], now)).toEqual({ working: 0, waiting: 1, failed: 0, unknown: 0 });
});
it("interleaves workspaces and unattached chats without promoting participant heartbeats", () => {
  const space = workspace([participant("mine", "idle", true)]);
  const mine = { id: "mine", title: "My chat", status: "idle", createdAt: new Date(now - 60_000).toISOString() } as AssistantSession;
  const solo = { ...mine, id: "solo", createdAt: new Date(now - 30_000).toISOString() };
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["session:solo", "workspace:shared"]);
  space.participation!.sessions[0].activityAt = new Date(now + 60_000).toISOString();
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["session:solo", "workspace:shared"]);
  space.participation!.sessions[0].attached = false;
  expect(navigationItems([space], [mine, solo], now).map(i => i.key)).toEqual(["session:solo", "session:mine", "workspace:shared"]);
});

it("retains accessible chats when their workspace is missing or deleted despite session-side source history", () => {
  const space = workspace([participant("mine", "idle", true)]);
  const mine = { id: "mine", title: "Retained chat", status: "idle", createdAt: new Date(now).toISOString(),
    workspaceAssociation: { id: space.id, revision: 1 }, developmentWorkspaces: [{ state: "active", workspaceId: space.id }] } as AssistantSession;
  expect(navigationItems([space], [mine], now).map(i => i.key)).toEqual(["workspace:shared"]);
  expect(navigationItems([], [mine], now).map(i => i.key)).toEqual(["session:mine"]);
  expect(navigationItems([{ ...space, workflow: { state: "deleted", revision: 2 } }], [mine], now).map(i => i.key)).toEqual(["session:mine"]);
});

it("does not hide an own chat behind a private participant with the same session id", () => {
  const space = workspace([participant("same", "running")]);
  const mine = { id: "same", title: "My independent chat", status: "idle", createdAt: new Date(now).toISOString() } as AssistantSession;
  const items = navigationItems([space], [mine], now);
  expect(items.map(i => i.key)).toEqual(["session:same", "workspace:shared"]);
  expect(items.find(i => i.workspace)?.matches).toEqual([]);
  expect(items.find(i => i.workspace)?.counts.working).toBe(1);
});

it("uses legacy ownership only when participation is absent and keeps empty external workspaces", () => {
  const mine = { id: "mine", title: "My chat", status: "idle", createdAt: new Date(now).toISOString() } as AssistantSession;
  const legacy = { ...workspace([]), participation: undefined, owner: { kind: "assistant", appId: "hosty.harness", reference: mine.id, label: "Legacy" } };
  const external = { ...legacy, id: "external", owner: { kind: "external", reference: "task", label: "External" } };
  expect(navigationItems([legacy, external], [mine], now).map(i => i.key)).toEqual(["workspace:shared", "workspace:external"]);
  const detached = { ...legacy, participation: workspace([]).participation };
  expect(navigationItems([detached], [mine], now).map(i => i.key)).toEqual(["session:mine", "workspace:shared"]);
});

it("sorts mixed activity with stable identities, ignoring source observations and invalid dates", () => {
  const older = { ...workspace([]), id: "older", updatedAt: new Date(now - 2000).toISOString() };
  const newer = { ...older, id: "newer", updatedAt: new Date(now).toISOString() };
  const unknown = { ...older, id: "unknown", updatedAt: "invalid", participation: undefined };
  const session = { id: "middle", status: "idle", title: "Middle", createdAt: new Date(now - 1000).toISOString() } as AssistantSession;
  const sessions = [session, { ...session, id: "z", createdAt: "invalid" }, { ...session, id: "a", createdAt: "invalid" }];
  const workspaces = [older, unknown, newer];
  expect(navigationItems(workspaces, sessions, now).map(i => i.key)).toEqual(["workspace:newer", "session:middle", "workspace:older", "session:a", "session:z", "workspace:unknown"]);
  expect(workspaces.map(w => w.id)).toEqual(["older", "unknown", "newer"]);
  expect(sessions.map(s => s.id)).toEqual(["middle", "z", "a"]);
});

it("navigates and counts hosted chats in external workspaces without exposing foreign tabs", () => {
  const space = { ...workspace([participant("mine", "idle", true), participant("private", "running")]),
    owner: { kind: "external" as const, label: "Codex", reference: "external-task" } };
  const mine = { id: "mine", title: "Review external changes", status: "idle", createdAt: new Date(now).toISOString() } as AssistantSession;
  expect(workspaceSessionIds(space)).toEqual(["mine"]);
  const item = navigationItems([space], [mine], now)[0];
  expect(item.matches).toEqual([mine]); expect(item.search).toContain("review external changes");
  expect(item.counts).toEqual({ working: 1, waiting: 0, failed: 0, unknown: 0 });
});
