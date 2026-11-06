import { expect, it } from "vitest";
import { resolveTranscriptReview, transcriptEdits, type TranscriptReviewReference } from "./transcript-edits";
import type { AssistantEvent } from "./assistant-api";
import type { DevelopmentWorkspace } from "./development-api";
const ref: TranscriptReviewReference = { sessionId: "session", workspaceId: "one", worktreeId: "tree-one", repository: "https://github.com/example/one", path: "src/index.ts" };
const workspace = (id: string): DevelopmentWorkspace => ({ id, state: "active", workflow: { state: "in-progress", revision: 0 }, owner: { kind: "assistant", appId: "hosty.harness", reference: "session", label: "Session" }, worktrees: [{ id: `tree-${id}`, workspaceId: id, repository: `https://github.com/example/${id}`, branch: "feature", state: "active", apps: [], leases: [], pullRequests: [] }] });
const event = (extra: object): AssistantEvent => ({ seq: 1, ts: "", type: "tool_use", toolName: "Edit", ...extra });
it("preserves persisted exact bindings when two repositories contain the same file", () => {
  const edits = transcriptEdits(event({ fileEdits: [{ path: ref.path, kind: "edit", additions: 1, deletions: 2, review: ref }] }));
  expect(edits[0]?.review).toEqual(ref);
  expect(resolveTranscriptReview(edits[0]!.review!, "session", [workspace("two"), workspace("one")])?.tree.id).toBe("tree-one");
});
it("never chooses another source or session after replay or authorization loss", () => {
  expect(resolveTranscriptReview(ref, "other-session", [workspace("one")])).toBeUndefined();
  expect(resolveTranscriptReview(ref, "session", [workspace("two")])).toBeUndefined();
  const original = workspace("one");
  for (const altered of [{ ...original, owner: { ...original.owner, kind: "external" } }, { ...original, owner: { ...original.owner, appId: "another-app" } }, { ...original, owner: { ...original.owner, reference: "other-session" } }, { ...original, worktrees: [{ ...original.worktrees[0]!, repository: "https://github.com/example/two" }] }])
    expect(resolveTranscriptReview(ref, "session", [altered])).toBeUndefined();
});
it("keeps legacy edit entries readable without guessing a binding and rejects invalid metadata", () => {
  expect(transcriptEdits(event({ input: { file_path: "/old/worktree/src/index.ts", old_string: "a", new_string: "b" } }))[0]).toMatchObject({ path: "/old/worktree/src/index.ts", unavailable: expect.stringContaining("older transcript") });
  for (const path of ["../outside", "/outside", "dir/../file", "C:\\outside", "bad\nfile"]) {
    expect(transcriptEdits(event({ fileEdits: [{ path: "readable", review: { ...ref, path } }] }))[0]?.review).toBeUndefined();
  }
  expect(transcriptEdits(event({ toolName: "FileChange", input: { grantRoot: "/worktree" } }))).toEqual([]);
});

it("does not open a different recorded path behind the displayed filename", () => {
  const edits = transcriptEdits(event({ fileEdits: [{ path: "expected.ts", review: { ...ref, path: "other.ts" } }] }));
  expect(edits[0]?.path).toBe("expected.ts"); expect(edits[0]?.review).toBeUndefined();
});

it("resolves an attached external-workspace chat but refuses detached and private associations", () => {
  const external = { ...workspace("one"), owner: { kind: "external" as const, reference: "external-task", label: "Codex" },
    participation: { id: "one", revision: 2, role: "operator" as const, viewerUserId: "me", members: [], eligibleUsers: [], sessions: [
      { appId: "hosty.harness", userId: "me", sessionId: "session", title: "Attached chat", attached: true, canOpen: true,
        viewerPath: "/development?session=session", status: "idle", activityAt: null },
    ] } };
  expect(resolveTranscriptReview(ref, "session", [external])?.tree.id).toBe("tree-one");
  external.participation.sessions[0].attached = false;
  expect(resolveTranscriptReview(ref, "session", [external])).toBeUndefined();
  external.participation.sessions[0].attached = true;
  external.participation.sessions[0].canOpen = false;
  expect(resolveTranscriptReview(ref, "session", [external])).toBeUndefined();
});
