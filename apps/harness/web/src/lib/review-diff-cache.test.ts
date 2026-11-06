import { expect, it } from "vitest";
import type { ReviewDiff } from "./workspace-review-api";
import { retainReviewDiff } from "./review-diff-cache";

const diff = (combined = "patch"): ReviewDiff => ({ source: { scope: "session", label: "Workspace changes", base: "base", head: "head", observedAt: "2026-11-04", revision: "revision", published: false, notPublished: true },
  diff: { path: "file", combined, truncated: false, binary: false }, localRanges: [], localRangesComplete: false });

it("bounds retained diffs by count and replaces repeated keys without accumulating copies", () => {
  let entries = retainReviewDiff([], "one", diff(), { maxEntries: 2, maxBytes: 10_000 });
  entries = retainReviewDiff(entries, "two", diff(), { maxEntries: 2, maxBytes: 10_000 });
  entries = retainReviewDiff(entries, "one", diff("new"), { maxEntries: 2, maxBytes: 10_000 });
  expect(entries.map(entry => entry.key)).toEqual(["two", "one"]);
  expect(entries[1].value.diff.combined).toBe("new");
  entries = retainReviewDiff(entries, "three", diff(), { maxEntries: 2, maxBytes: 10_000 });
  expect(entries.map(entry => entry.key)).toEqual(["one", "three"]);
});

it("evicts old diffs to fit the byte budget and does not retain an oversized response", () => {
  const value = diff();
  const bytes = JSON.stringify(value).length * 2;
  const limits = { maxEntries: 24, maxBytes: bytes * 2 - 1 };
  const entries = retainReviewDiff(retainReviewDiff([], "one", value, limits), "two", value, limits);
  expect(entries.map(entry => entry.key)).toEqual(["two"]);
  expect(retainReviewDiff(entries, "big", diff("x".repeat(limits.maxBytes)), limits)).toEqual(entries);
  expect(entries.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(limits.maxBytes);
});
