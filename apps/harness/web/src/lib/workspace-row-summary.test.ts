import { expect, it } from "vitest";
import type { DevelopmentWorkspace } from "./development-api";
import { workspaceRowSummary } from "./workspace-row-summary";
const now = Date.parse("2026-11-04T10:00:00Z");
const base: DevelopmentWorkspace = { id: "one", name: "Workspace", state: "active", owner: { kind: "external", reference: "task", label: "Agent" },
  workflow: { state: "in-progress", revision: 1 }, worktrees: [{ id: "tree", workspaceId: "one", repository: "repo", branch: "branch", state: "active", apps: [], leases: [], pullRequests: [], observationHealth: "watching",
    observation: { at: "2026-11-03T10:00:00Z", state: "ok", local: { files: [], truncated: false } } }] };
const labels = (workspace: DevelopmentWorkspace, time = now) => workspaceRowSummary(workspace, time).map(f => f.label);
it("separates lifecycle from session activity and keeps completed rows explicit", () => {
  expect(labels(base)).toEqual(["In progress", "Clean"]);
  expect(labels({ ...base, workflow: { state: "in-progress", revision: 2, closure: "closed" } })).toEqual(["Paused"]);
  expect(labels({ ...base, workflow: { state: "completed", revision: 3 } })).toEqual(["Completed"]);
  expect(labels({ ...base, workflow: { state: "deleting", revision: 4 } })).toEqual(["Deleting"]);
});
it("never treats missing, partial or recovering source as clean", () => {
  expect(labels({ ...base, worktrees: [{ ...base.worktrees[0], observation: undefined }] })).toContain("Changes unknown");
  expect(labels({ ...base, worktrees: [{ ...base.worktrees[0], observationHealth: "recovering" }] })).toContain("Changes unknown");
  const dirty = { ...base.worktrees[0], observation: { ...base.worktrees[0].observation!, local: { files: [{ path: "a", status: "M" }], truncated: true } } };
  expect(labels({ ...base, worktrees: [dirty] })).toContain("1+ files");
  expect(labels({ ...base, worktrees: [{ ...dirty, observation: { ...dirty.observation, conflict: true } }] })).toContain("Conflicts");
});
it.each([['failed', 'CI failed'], ['running', 'CI running'], ['passed', 'CI passed'], ['unknown', 'PR open']])("shows aggregate %s checks without loading row details", (checks, label) => {
  const workspace = { ...base, pullRequestSummary: { count: 2, state: "open", checks, observedAt: new Date(now).toISOString(), partial: false } };
  expect(labels(workspace)).toContain(label);
  expect(labels(workspace, now + 5 * 60_000)).toContain(label);
  expect(labels(workspace, now + 361_000)).toContain("PR outdated");
});
it("keeps merged history distinct from CI and refuses incomplete all-merged claims", () => {
  const workspace = { ...base, pullRequestSummary: { count: 2, state: "merged", checks: "none", observedAt: "2026-10-01T10:00:00Z", partial: false } };
  expect(labels(workspace)).toContain("Merged");
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "unknown", partial: true } })).toContain("PR unknown");
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "closed" } })).toContain("Closed");
});
it("handles older Core inventories without inventing provider facts", () => {
  expect(labels({ ...base, worktrees: [{ ...base.worktrees[0], pullRequests: [{ url: "https://example.test/pr/1" }] }] })).toContain("PR unknown");
});

it("keeps incomplete lifecycle observations unavailable without claiming clean source", () => {
  expect(labels({ ...base, workflow: { revision: 1 } as DevelopmentWorkspace["workflow"] })).toEqual(["Unavailable"]);
});
