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
it.each([false, true])("retains the last successful clean/conflict result through a queued scan (conflict=%s)", conflict => {
  const tree = { ...base.worktrees[0], observation: { ...base.worktrees[0].observation!, conflict } };
  for (const observationHealth of ["watching", "pending", "watching"]) {
    const workspace = { ...base, worktrees: [{ ...tree, observationHealth }] };
    expect(labels(workspace)).toEqual(["In progress", conflict ? "Conflicts" : "Clean"]);
    const source = workspaceRowSummary(workspace, now)[1];
    expect(!!source.refreshing).toBe(observationHealth === "pending");
    if (source.refreshing) expect(source.detail).toContain("last successful source observation while checking for updates");
  }
});
it.each(["starting", "recovering", "unknown", "paused", "failed"])("does not reuse a successful source snapshot when observation health is %s", observationHealth => {
  expect(labels({ ...base, worktrees: [{ ...base.worktrees[0], observationHealth,
    observation: { ...base.worktrees[0].observation!, at: new Date(now).toISOString() } }] })).toEqual(["In progress", "Changes unknown"]);
});
it("requires a successful readable snapshot during pending and retains partial-count guards", () => {
  const tree = { ...base.worktrees[0], observationHealth: "pending" };
  for (const observation of [undefined, { ...tree.observation!, state: "unavailable" }, { ...tree.observation!, local: undefined }]) {
    const facts = workspaceRowSummary({ ...base, worktrees: [{ ...tree, observation }] }, now);
    expect(facts.map(f => f.label)).toEqual(["In progress", "Changes unknown"]);
    expect(facts.some(f => f.refreshing)).toBe(false);
  }
  expect(labels({ ...base, worktrees: [{ ...tree, observation: { ...tree.observation!, local: { files: [], truncated: true } } }] })).toEqual(["In progress", "Changes unknown"]);
});
it.each([['failed', 'CI failed'], ['running', 'CI running'], ['passed', 'CI passed'], ['unknown', 'PR open']])("shows aggregate %s checks without loading row details", (checks, label) => {
  const workspace = { ...base, pullRequestSummary: { count: 2, state: "open", checks, observedAt: new Date(now).toISOString(), partial: false } };
  expect(labels(workspace)).toContain(label);
  expect(labels(workspace, now + 5 * 60_000)).toContain(label);
  expect(labels(workspace, now + 361_000)).toEqual(["In progress", "Clean", "PR outdated"]);
});
it.each([['failed', 'CI failed'], ['running', 'CI running'], ['passed', 'CI passed'], ['unknown', null], ['none', null]])("keeps the open PR count visible with clean source and %s checks", (checks, ciLabel) => {
  const workspace = { ...base, pullRequestSummary: { count: 5, openCount: 2, draftCount: 1, state: "open", checks: checks!, observedAt: new Date(now).toISOString(), partial: false } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "2 open PRs", ...(ciLabel ? [ciLabel] : [])]);
  const detail = workspaceRowSummary(workspace, now)[2].detail;
  expect(detail).toContain("2 observed open pull requests, including 1 draft");
  expect(detail).toContain("5 linked pull requests");
  expect(labels(workspace, now + 361_000)).toEqual(["In progress", "Clean", "PR outdated"]);
  const stale = workspaceRowSummary(workspace, now + 361_000)[2];
  expect(stale.tone).toBe("muted");
  expect(stale.detail).toContain("Last known: 2 observed open pull requests, including 1 draft");
  expect(stale.detail).toContain("last observed");
});
it("distinguishes drafts and lower bounds without counting merged history as open", () => {
  const workspace = { ...base, pullRequestSummary: { count: 5, openCount: 1, draftCount: 1, state: "draft", checks: "failed", observedAt: new Date(now).toISOString(), partial: false } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "1 draft PR", "CI failed"]);
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, checks: "unknown", partial: true } })).toEqual(["In progress", "Clean", "1+ open PRs", "PR unknown"]);
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, openCount: 0, draftCount: 0, state: "unknown", checks: "unknown", partial: true } })).toEqual(["In progress", "Clean", "PR unknown"]);
});
it("keeps old Core open PR labels without guessing an open count from all historical links", () => {
  const workspace = { ...base, pullRequestSummary: { count: 7, state: "open", checks: "passed", observedAt: new Date(now).toISOString(), partial: false } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "PR open", "CI passed"]);
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "draft" } })).toEqual(["In progress", "Clean", "Draft PR", "CI passed"]);
});
it("does not advertise stale drafts as active even for a completed workspace", () => {
  const workspace = { ...base, workflow: { state: "completed", revision: 3 }, pullRequestSummary: {
    count: 5, openCount: 1, draftCount: 1, state: "draft", checks: "passed", observedAt: new Date(now - 361_000).toISOString(), partial: false,
  } };
  expect(labels(workspace)).toEqual(["Completed", "PR outdated"]);
  expect(workspaceRowSummary(workspace, now)[1].detail).toContain("Last known: 1 observed open pull request, including 1 draft");
});
it.each([undefined, null, "invalid"])("keeps nonterminal PR state outdated without a usable observation timestamp (%s)", observedAt => {
  const workspace = { ...base, pullRequestSummary: { count: 1, openCount: 1, draftCount: 0, state: "open", checks: "failed", observedAt, partial: false } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "PR outdated"]);
  const stale = workspaceRowSummary(workspace, now)[2];
  expect(stale.tone).toBe("muted");
  expect(stale.detail).toContain("Last known: 1 observed open pull request");
  expect(stale.detail).toContain("observation time unavailable");
});
it.each(["failed", "running", "passed", "unknown"])("suppresses stale partial open and CI %s claims while retaining the last-known lower bound", checks => {
  const workspace = { ...base, pullRequestSummary: { count: 3, openCount: 1, draftCount: 1, state: "open", checks,
    observedAt: new Date(now - 361_000).toISOString(), partial: true } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "PR outdated"]);
  expect(workspaceRowSummary(workspace, now)[2].detail).toContain("Last known: At least 1 observed open pull request, including 1 draft");
});
it("does not turn an unavailable stale open count into zero or all historical links", () => {
  const workspace = { ...base, pullRequestSummary: { count: 7, openCount: 0, draftCount: 0, state: "open", checks: "none", observedAt: null, partial: false } };
  expect(labels(workspace)).toEqual(["In progress", "Clean", "PR outdated"]);
  const detail = workspaceRowSummary(workspace, now)[2].detail;
  expect(detail).toContain("Last known: Open pull requests");
  expect(detail).not.toContain("0 observed open");
  expect(detail).not.toContain("7 observed open");
});
it("keeps merged history distinct from CI and refuses incomplete all-merged claims", () => {
  const workspace = { ...base, pullRequestSummary: { count: 2, state: "merged", checks: "none", observedAt: "2026-10-01T10:00:00Z", partial: false } };
  expect(labels(workspace)).toContain("Merged");
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "unknown", partial: true } })).toContain("PR unknown");
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "closed" } })).toContain("Closed");
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, observedAt: null } })).toEqual(["In progress", "Clean", "Merged"]);
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "closed", observedAt: null } })).toEqual(["In progress", "Clean", "Closed"]);
  expect(labels({ ...workspace, pullRequestSummary: { ...workspace.pullRequestSummary, state: "unknown", partial: true, checks: "failed", observedAt: null } })).toEqual(["In progress", "Clean", "PR unknown"]);
});
it("handles older Core inventories without inventing provider facts", () => {
  expect(labels({ ...base, worktrees: [{ ...base.worktrees[0], pullRequests: [{ url: "https://example.test/pr/1" }] }] })).toContain("PR unknown");
});

it("keeps incomplete lifecycle observations unavailable without claiming clean source", () => {
  expect(labels({ ...base, workflow: { revision: 1 } as DevelopmentWorkspace["workflow"] })).toEqual(["Unavailable"]);
});

it("aggregates confirmed added and deleted lines across repositories while retaining the file count", () => {
  const first = { ...base.worktrees[0], observation: { ...base.worktrees[0].observation!, local: {
    files: [{ path: "one", status: "M" }], truncated: false, lineStats: { additions: 12, deletions: 4 },
  } } };
  const second = { ...first, id: "second", observation: { ...first.observation, local: {
    files: [{ path: "two", status: "A" }, { path: "three", status: "M" }], truncated: false, lineStats: { additions: 8, deletions: 3 },
  } } };
  expect(labels({ ...base, worktrees: [first, second] })).toEqual(["In progress", "3 files", "+20 −7"]);
  expect(workspaceRowSummary({ ...base, worktrees: [first, second] }, now).at(-1)?.detail).toContain("20 added and 7 deleted lines in uncommitted changes");
  const pending = { ...base, worktrees: [first, { ...second, observationHealth: "pending" }] };
  expect(labels(pending)).toEqual(["In progress", "3 files", "+20 −7"]);
  expect(workspaceRowSummary(pending, now).filter(f => f.refreshing)).toHaveLength(1);
  expect(workspaceRowSummary(pending, now).at(-1)?.detail).toContain("last successful source observation while checking for updates");
});

it("uses complete per-file observations from older inventories without inventing missing line totals", () => {
  const tree = { ...base.worktrees[0], observation: { ...base.worktrees[0].observation!, local: {
    files: [{ path: "code", status: "M", lineStats: { additions: 4, deletions: 0 } }, { path: "image", status: "M", binary: true }], truncated: false,
  } } };
  expect(labels({ ...base, worktrees: [tree] })).toEqual(["In progress", "2 files", "+4 −0"]);
  const missing = { ...tree, observation: { ...tree.observation, local: { ...tree.observation.local, files: [{ path: "unknown", status: "M" }] } } };
  expect(labels({ ...base, worktrees: [tree, missing] })).toEqual(["In progress", "3 files"]);
});

it("omits line totals for truncated, stale, recovering or incomplete source observations", () => {
  const tree = { ...base.worktrees[0], observation: { ...base.worktrees[0].observation!, local: {
    files: [{ path: "code", status: "M" }], truncated: false, lineStats: { additions: 4, deletions: 2 },
  } } };
  expect(labels({ ...base, worktrees: [{ ...tree, observation: { ...tree.observation, local: { ...tree.observation.local, truncated: true } } }] })).toEqual(["In progress", "1+ files"]);
  expect(labels({ ...base, worktrees: [{ ...tree, observationHealth: undefined }] })).toEqual(["In progress", "Changes unknown"]);
  expect(labels({ ...base, worktrees: [{ ...tree, observationHealth: "recovering" }] })).toEqual(["In progress", "Changes unknown"]);
  expect(labels({ ...base, worktrees: [tree, { ...tree, id: "unreadable", observation: undefined }] })).toEqual(["In progress", "1+ files"]);
  expect(labels({ ...base, worktrees: [tree], workflow: { state: "completed", revision: 2 } })).toEqual(["Completed"]);
});
