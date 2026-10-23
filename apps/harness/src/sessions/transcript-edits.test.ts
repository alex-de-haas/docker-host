import { expect, it } from "vitest";
import { transcriptFileEdits } from "./transcript-edits.js";
import type { DevelopmentWorkspace } from "./development.js";
const tree = (id: string, root: string): DevelopmentWorkspace => ({ id, workspaceId: `workspace-${id}`, path: root, repository: `https://github.com/example/${id}`, state: "active", apps: [], operations: [], leases: [], branch: "feature", targetBranch: "main", originalBase: "base", sessionPath: "/cache" , pullRequests: [] });
it("binds Claude replacements and Codex patches to each exact repository with the same filename", () => {
  const trees = [tree("one", "/trees/one"), tree("two", "/trees/two")];
  const claude = transcriptFileEdits("Edit", { file_path: "/trees/one/src/index.ts", old_string: "old\n", new_string: "new\nsecond\n" }, "session", trees);
  const codex = transcriptFileEdits("FileChange", { changes: [{ path: "src/index.ts", kind: { type: "update" }, diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n" }] }, "session", trees, "/trees/two");
  expect(claude[0]).toMatchObject({ path: "src/index.ts", additions: 2, deletions: 1, review: { sessionId: "session", workspaceId: "workspace-one", worktreeId: "one", repository: trees[0]!.repository, path: "src/index.ts" } });
  expect(codex[0]).toMatchObject({ path: "src/index.ts", additions: 1, deletions: 1, review: { workspaceId: "workspace-two", worktreeId: "two" } });
});
it("supports projected worker and Windows cwd descriptors without substituting a repository for unknown relative paths", () => {
  expect(transcriptFileEdits("Write", { file_path: "src/file.ts", content: "text" }, "s", [tree("one", "/trees/one")])[0]?.review).toBeUndefined();
  expect(transcriptFileEdits("FileChange", { changes: [{ path: "file.ts" }] }, "s", [tree("one", "/worker/trees/one")], "/worker/trees/one")[0]?.review?.path).toBe("file.ts");
  expect(transcriptFileEdits("Edit", { file_path: "src\\file.ts" }, "s", [tree("one", "C:\\trees\\one")], "C:\\trees\\one")[0]?.review?.path).toBe("src/file.ts");
});
it("refuses traversal, prefix collisions, ambiguous nested descriptors, deleted roots and malformed paths", () => {
  const trees = [tree("one", "/trees/one")];
  for (const file_path of ["/trees/one-other/file.ts", "/trees/one/../other/file.ts", "/outside/file.ts", "file.ts", "/trees/one/bad\nfile.ts"]) {
    expect(transcriptFileEdits("Edit", { file_path }, "s", trees)[0]?.review).toBeUndefined();
  }
  expect(transcriptFileEdits("Edit", { file_path: "/trees/one/nested/file.ts" }, "s", [...trees, tree("nested", "/trees/one/nested")])[0]?.review).toBeUndefined();
  expect(transcriptFileEdits("Edit", { file_path: "/trees/one/file.ts" }, "s", [{ ...trees[0]!, state: "deleted" }])[0]?.review).toBeUndefined();
  expect(transcriptFileEdits("FileChange", { changes: Array.from({ length: 500 }, () => ({ path: "/trees/one/file.ts" })) }, "s", trees)).toHaveLength(200);
});
