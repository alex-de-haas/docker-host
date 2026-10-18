import { expect, it } from "vitest";
import { prepareWorkspaceDiff } from "./workspace-diff";
const patch = "diff --git a/example.ts b/example.ts\nindex 1234567..abcdef0 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n export { value };\n";
const input = { contentKind: "patch" as const, path: "example.ts", combined: patch, binary: false, truncated: false };
it("preserves old/new contents and line numbers of a tracked patch", () => {
  const preview = prepareWorkspaceDiff(input);
  expect(preview.kind).toBe("diff"); if (preview.kind !== "diff") return;
  expect(preview.file.hunks[0]).toMatchObject({ deletionStart: 1, additionStart: 1, deletionLines: 1, additionLines: 1 });
  expect(preview.file.deletionLines.join("")).toContain("const value = 1;");
  expect(preview.file.additionLines.join("")).toContain("const value = 2;");
});
it.each([patch, "hello", "<script>alert('literal source')</script>\n"])("treats untracked text literally: %s", combined => {
  const preview = prepareWorkspaceDiff({ ...input, combined, contentKind: "text" });
  expect(preview.kind).toBe("diff"); if (preview.kind !== "diff") return;
  expect(preview.file.type).toBe("new"); expect(preview.file.additionLines.join("")).toBe(combined);
  expect(preview.file.deletionLines).toHaveLength(0);
});
it.each([
  ["new", "diff --git a/example.ts b/example.ts\nnew file mode 100644\n--- /dev/null\n+++ b/example.ts\n@@ -0,0 +1 @@\n+hello\n"],
  ["deleted", "diff --git a/example.ts b/example.ts\ndeleted file mode 100644\n--- a/example.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n"],
])("renders a %s file from a Git patch", (type, combined) => {
  const preview = prepareWorkspaceDiff({ ...input, combined });
  expect(preview.kind).toBe("diff"); if (preview.kind === "diff") expect(preview.file.type).toBe(type);
});
it("keeps metadata and invalid patches readable without inventing line changes", () => {
  for (const combined of ["not a patch", "diff --git a/example.ts b/example.ts\nold mode 100644\nnew mode 100755\n", patch.replace("@@ -1,2 +1,2 @@", "@@ invalid @@")]) {
    expect(prepareWorkspaceDiff({ ...input, combined })).toMatchObject({ kind: "text", content: combined });
  }
});
it("does not parse oversized or binary previews and identifies empty text", () => {
  for (const flags of [{ truncated: true }, { binary: true }, { image: {} }]) {
    const preview = prepareWorkspaceDiff({ ...input, ...flags });
    expect(preview.kind).toBe("text"); expect(preview).not.toHaveProperty("content");
  }
  expect(prepareWorkspaceDiff({ ...input, combined: "", contentKind: "text" })).toMatchObject({ message: "Empty new file." });
  expect(prepareWorkspaceDiff({ ...input, combined: "" })).toMatchObject({ message: "No text changes." });
});

it("keeps older Core responses readable without guessing whether source is a patch", () => {
  expect(prepareWorkspaceDiff({ ...input, contentKind: undefined })).toMatchObject({ kind: "text", content: patch });
});
