import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceDiff } from "../src/app/shell/source/source-diff-data.ts";

const patch = "diff --git a/example.ts b/example.ts\nindex 1234567..abcdef0 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n export { value };\n";
const input = { path: "example.ts", content: patch, truncated: false };

test("tracked and staged Git patches retain both sides and line numbers", () => {
  const result = prepareSourceDiff(input);
  assert.equal(result.kind, "diff");
  assert.equal(result.file.hunks[0].deletionStart, 1);
  assert.equal(result.file.hunks[0].additionStart, 1);
  assert.equal(result.file.hunks[0].deletionLines, 1);
  assert.equal(result.file.hunks[0].additionLines, 1);
  assert.ok(result.file.deletionLines.includes("const value = 1;\n"));
  assert.ok(result.file.additionLines.includes("const value = 2;\n"));
});

test("untracked patch-like content is added literally instead of parsed as a patch", () => {
  const result = prepareSourceDiff({ ...input, untracked: true });
  assert.equal(result.kind, "diff");
  assert.equal(result.file.type, "new");
  assert.equal(result.file.additionLines.join(""), patch);
  assert.equal(result.file.deletionLines.length, 0);
});

test("untracked text without a final newline preserves its content", () => {
  const result = prepareSourceDiff({ ...input, untracked: true, content: "hello" });
  assert.equal(result.kind, "diff");
  assert.equal(result.file.additionLines.join(""), "hello");
});

test("staged additions are parsed as patches, not untracked contents", () => {
  const result = prepareSourceDiff({ ...input, content: "diff --git a/example.ts b/example.ts\nnew file mode 100644\n--- /dev/null\n+++ b/example.ts\n@@ -0,0 +1 @@\n+hello\n" });
  assert.equal(result.kind, "diff");
  assert.equal(result.file.type, "new");
  assert.equal(result.file.additionLines.join(""), "hello\n");
});

test("empty and binary files have a readable fallback", () => {
  for (const content of ["", "New binary file"]) {
    const result = prepareSourceDiff({ ...input, untracked: true, content });
    assert.equal(result.kind, "text");
    assert.ok(result.message);
  }
  assert.equal(prepareSourceDiff({ ...input, content: "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n" }).kind, "text");
});

test("truncated and malformed patches fall back instead of showing misleading line changes", () => {
  assert.equal(prepareSourceDiff({ ...input, truncated: true }).kind, "text");
  assert.equal(prepareSourceDiff({ ...input, content: "not a patch" }).kind, "text");
  assert.equal(prepareSourceDiff({ ...input, content: patch.replace("@@ -1,2 +1,2 @@", "@@ invalid @@") }).kind, "text");
});
