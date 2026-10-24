import { expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { placeReviewThreads, reviewThreadLocation, type ReviewThread } from "./review-threads";

const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -10,2 +10,3 @@\n before\n-old\n+new\n+extra\n@@ -30 +31 @@\n-old again\n+new again\n";
const file = parsePatchFiles(patch, undefined, true)[0].files[0];
const thread = (id: string, fields: Partial<ReviewThread> = {}): ReviewThread => ({ id, path: "example.ts", line: 11, resolved: false, comments: ["Review"], diffSide: "RIGHT", ...fields });
it("places multi-line and left-side threads only on the coordinates present in the rendered patch", () => {
  const result = placeReviewThreads([thread("right", { startLine: 10, line: 12, startDiffSide: "RIGHT" }), thread("left", { diffSide: "LEFT" }), thread("second-hunk", { line: 31 }), thread("gap", { line: 20 }), thread("cross-gap", { startLine: 12, line: 31 }), thread("cross-side", { startLine: 10, startDiffSide: "LEFT" })], file);
  expect(result.inline.map(({ thread, side, lineNumber }) => [thread.id, side, lineNumber])).toEqual([["right", "additions", 12], ["left", "deletions", 11], ["second-hunk", "additions", 31]]);
  expect(result.unplaced.map(t => t.id)).toEqual(["gap", "cross-gap", "cross-side"]);
});
it("never reuses original coordinates or guesses a missing side and keeps every thread visible", () => {
  const threads = [thread("outdated", { outdated: true, originalLine: 11 }), thread("file", { subjectType: "FILE", line: null }), thread("old-only", { line: null, originalLine: 11 }), thread("missing-side", { diffSide: null }), thread("different-path", { path: "other.ts" }), thread("invalid", { line: 0 }), thread("fraction", { line: 10.5 })];
  const result = placeReviewThreads(threads, file);
  expect(result.inline).toHaveLength(0);
  expect(result.outdated.map(t => t.id)).toEqual(["outdated"]);
  expect(result.file.map(t => t.id)).toEqual(["file"]);
  expect(result.unplaced.map(t => t.id)).toEqual(["old-only", "missing-side", "different-path", "invalid", "fraction"]);
  expect(Object.values(result).flat()).toHaveLength(threads.length);
});
it("uses a renamed old path only for old-side annotations and preserves threads when rendering is unavailable", () => {
  const renamed = { ...file, prevName: "former.ts" };
  const threads = [thread("old", { path: "former.ts", diffSide: "LEFT" }), thread("new", { path: "former.ts" })];
  expect(placeReviewThreads(threads, renamed).inline.map(t => t.thread.id)).toEqual(["old"]);
  expect(placeReviewThreads(threads).unplaced).toEqual(threads);
});
it("labels file and original multi-line locations without implying local changes resolve reviews", () => {
  expect(reviewThreadLocation(thread("file", { subjectType: "FILE" }))).toBe("example.ts · File");
  expect(reviewThreadLocation(thread("range", { startLine: 10, line: 12, changedLocally: true }))).toBe("example.ts:10–12 · new");
  expect(reviewThreadLocation(thread("old", { outdated: true, originalLine: 9, originalStartLine: 7, diffSide: "LEFT" }))).toBe("example.ts:7–9 · old");
});
