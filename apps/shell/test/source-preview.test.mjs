import assert from "node:assert/strict";
import test from "node:test";
import { isBinarySourceDiff, isSourceImageDataUrl } from "../src/app/shell/source/source-preview-data.ts";

const diff = { path: "file", combined: "", staged: "", truncated: false, head: null, newFile: false };

test("Core binary classification takes precedence over text and truncation", () => {
  assert.equal(isBinarySourceDiff({ ...diff, binary: true, truncated: true }, false), true);
  assert.equal(isBinarySourceDiff({ ...diff, binary: false, combined: "New binary file" }, true), false);
});

test("older Core binary responses get a clear fallback even when truncated", () => {
  assert.equal(isBinarySourceDiff({ ...diff, combined: "New binary file", truncated: true }, true), true);
  assert.equal(isBinarySourceDiff({ ...diff, combined: "diff --git a/a b/a\nBinary files a/a and b/a differ\n" }, false), true);
  assert.equal(isBinarySourceDiff({ ...diff, staged: "GIT binary patch\n" }, false), true);
  assert.equal(isBinarySourceDiff({ ...diff, combined: "+Binary files a/a and b/a differ\n" }, false), false);
  assert.equal(isBinarySourceDiff({ ...diff, combined: "Binary files a/a and b/a differ\n" }, true), false);
});

test("image sources allow only inline raster bytes", () => {
  for (const mime of ["png", "jpeg", "gif", "webp"])
    assert.equal(isSourceImageDataUrl(`data:image/${mime};base64,AQIDBA==`), true);
  for (const value of [null, "", "https://example.test/private.png", "file:///etc/passwd", "data:image/svg+xml;base64,AQID", "data:text/html;base64,AQID", "data:image/png;base64,<script>"])
    assert.equal(isSourceImageDataUrl(value), false);
});
