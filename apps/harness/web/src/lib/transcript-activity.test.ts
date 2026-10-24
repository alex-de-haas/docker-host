import { expect, it } from "vitest";
import type { AssistantEvent } from "./assistant-api";
import { activityRuns, commandDuration, commandOutcome, readActivityLabel, recordedEditGroups, recordedEditTotals, recordedFileEdits } from "./transcript-activity";
const event = (seq: number, toolName: string, extra = {}): AssistantEvent => ({ seq, ts: "", type: "tool_use", toolName, ...extra });
const ref = { sessionId: "s", workspaceId: "w", worktreeId: "tree", repository: "repo", path: "src/file.ts" };
const edit = (seq: number, value = {}, reference = ref) => event(seq, "Edit", { fileEdits: [{ path: reference.path, kind: "edit", review: reference, ...value }] });
it("groups consecutive compatible reads, edits and commands without crossing other activity", () => {
  const events = [event(1, "Read"), event(2, "Grep"), edit(3), edit(4), event(5, "Bash"), event(6, "Command"), event(7, "mcp__unknown__read_file"), event(8, "Read")];
  expect(activityRuns(events).map(run => [run.kind, run.events.map(e => e.seq)])).toEqual([["reads", [1, 2]], ["edits", [3, 4]], ["command", [5, 6]], ["other", [7]], ["reads", [8]]]);
  expect(readActivityLabel([event(1, "Read"), event(2, "Read"), event(3, "Grep"), event(4, "WebSearch")])).toBe("Read 2 files and 1 search and 1 web request");
});
it("sums only recorded counts from the exact source tuple and keeps same filenames in other sources separate", () => {
  const events = [edit(1, { additions: 2, deletions: 1 }), edit(2, { additions: 3, deletions: 4 }), edit(3, { additions: 5, deletions: 6 }, { ...ref, workspaceId: "other", worktreeId: "other", repository: "other" })];
  expect(recordedFileEdits(events).map(e => ({ review: e.review, additions: e.additions, deletions: e.deletions, calls: e.calls }))).toEqual([{ review: ref, additions: 5, deletions: 5, calls: 2 }, { review: { ...ref, workspaceId: "other", worktreeId: "other", repository: "other" }, additions: 5, deletions: 6, calls: 1 }]);
});
it("does not turn missing/overflowed counts into zero and never combines unbound legacy paths", () => {
  const values = recordedFileEdits([edit(1, { additions: 1, deletions: 1 }), edit(2, { deletions: 2 }), edit(3, { additions: Number.MAX_SAFE_INTEGER, deletions: 1 })]);
  expect(values).toHaveLength(1); expect(values[0].additions).toBeUndefined(); expect(values[0].deletions).toBe(4);
  const legacy = [event(10, "Edit", { input: { file_path: "same.ts" } }), event(11, "Edit", { input: { file_path: "same.ts" } })];
  expect(recordedFileEdits(legacy)).toHaveLength(2); expect(recordedFileEdits(legacy).every(e => e.additions === undefined && !e.review)).toBe(true);
});
it("renders only typed command facts and the strict one-line summary allowlist", () => {
  expect(commandOutcome({ seq: 1, ts: "", type: "command_result", toolUseId: "command:first", status: "failed", exitCode: 2, durationMs: 1_500, summary: "14 passed · 1 failed", stdout: "secret output" })).toEqual({ status: "failed", exitCode: 2, durationMs: 1_500, summary: "14 passed · 1 failed" });
  for (const summary of ["secret=token", "14 passed\nsecret", "12345678 passed", "Build succeeded", "14 passed; secret", "14 passed · 0 failed extra"]) expect(commandOutcome({ seq: 1, ts: "", type: "command_result", toolUseId: "command:first", status: "completed", summary })).not.toHaveProperty("summary");
  expect(commandOutcome({ seq: 1, ts: "", type: "command_result", toolUseId: "command:first", status: "success", exitCode: 0.5, durationMs: -1, output: "secret" })).toEqual({ status: "unknown" });
  expect(commandDuration(100)).toBe("100 ms"); expect(commandDuration(1_500)).toBe("1.5 s");
});

it("does not accept coerced statuses, invalid native IDs, out-of-contract facts or contradictory completion as success", () => {
  const valid = { seq: 1, ts: "", type: "command_result", toolUseId: "command:run:1", status: "completed", exitCode: 0, summary: "14 passed" };
  for (const altered of [{ status: ["completed"] }, { toolUseId: "bad\nid" }, { toolUseId: "x".repeat(257) }, { exitCode: 2_147_483_648 }, { exitCode: -2_147_483_649 }, { durationMs: 604_800_001 }, { status: "completed", exitCode: 1 }]) expect(commandOutcome({ ...valid, ...altered })).toEqual({ status: "unknown" });
});

it.each(["cancelled", "unknown"])("does not show canonical passed totals for a restored %s command outcome", status => {
  const outcome = commandOutcome({ seq: 1, ts: "", type: "command_result", toolUseId: "command:run:1", status, durationMs: 500, summary: "14 passed" });
  expect(outcome).toEqual({ status, durationMs: 500 }); expect(outcome).not.toHaveProperty("summary");
});

it("aggregates changes across calls while keeping unknown and overflowed line directions unavailable", () => {
  const calls = [edit(1, { additions: 2, deletions: 1 }), event(2, "Command"), edit(3, { additions: 3, deletions: 2 }), edit(4, { additions: 1, deletions: 0 }, { ...ref, repository: "other", worktreeId: "other" })];
  const edits = recordedFileEdits(calls);
  expect(edits).toHaveLength(2); expect(recordedEditTotals(edits)).toEqual({ additions: 6, deletions: 3 });
  expect(recordedEditTotals(recordedFileEdits([edit(1, { additions: 0, deletions: 0 })]))).toEqual({ additions: 0, deletions: 0 });
  expect(recordedEditTotals(recordedFileEdits([edit(1, { additions: 2, deletions: 1 }), edit(2, { deletions: 0 }, { ...ref, repository: "other" })]))).toEqual({ additions: undefined, deletions: 1 });
  expect(recordedEditTotals(recordedFileEdits([edit(1, { additions: Number.MAX_SAFE_INTEGER, deletions: 0 }), edit(2, { additions: 1, deletions: 0 }, { ...ref, repository: "other" })]))).toEqual({ additions: undefined, deletions: 0 });
});

it("groups files only by their complete recorded source while preserving first-source order", () => {
  const first = { ...ref, repository: "https://github.com/one/project", path: "README.md" };
  const anotherFile = { ...first, path: "src/main.ts" };
  const otherRepository = { ...first, repository: "https://github.com/two/project" };
  const otherTree = { ...first, worktreeId: "another-tree" };
  const otherWorkspace = { ...first, workspaceId: "another-workspace" };
  const otherSession = { ...first, sessionId: "another-session" };
  const edits = recordedFileEdits([edit(1, { additions: 1, deletions: 0 }, first), edit(2, { additions: 2, deletions: 0 }, otherRepository), edit(3, { additions: 3, deletions: 0 }, anotherFile), edit(4, {}, otherTree), edit(5, {}, otherWorkspace), edit(6, {}, otherSession)]);
  const groups = recordedEditGroups(edits);
  expect(groups).toHaveLength(5);
  expect(groups[0].edits.map(edit => edit.path)).toEqual(["README.md", "src/main.ts"]);
  expect(groups.map(group => group.edits[0].review)).toEqual([first, otherRepository, otherTree, otherWorkspace, otherSession]);
  expect(new Set(groups.map(group => group.key)).size).toBe(5);
  expect(groups[0].edits.map(edit => edit.additions)).toEqual([1, 3]);
});
it("does not invent a shared repository identity for unbound legacy edits", () => {
  const legacy = recordedFileEdits([event(1, "Edit", { input: { file_path: "README.md" } }), event(2, "Edit", { input: { file_path: "README.md" } })]);
  const groups = recordedEditGroups(legacy);
  expect(groups).toHaveLength(2);
  expect(groups.every(group => group.repository === undefined && group.edits.length === 1)).toBe(true);
  expect(groups.map(group => group.edits[0])).toEqual(legacy);
});
