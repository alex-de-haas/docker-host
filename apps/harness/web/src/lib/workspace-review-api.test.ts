import { beforeEach, expect, it, vi } from "vitest";
import { developmentRequest, DevelopmentRequestError, type Worktree } from "./development-api";
import { fileThreads, readReview, readReviewDiff, reviewFiles, reviewQuery, type ReviewInventory, type ReviewDiff } from "./workspace-review-api";
import type { ReviewThread } from "./review-threads";
vi.mock("./development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
const tree: Worktree = { id: "tree", workspaceId: "workspace", repository: "repo", branch: "feature", state: "active", apps: [], leases: [], pullRequests: [], observationRevision: "observed", observation: { at: "2026-10-21T17:00:00Z", head: "local-head", state: "ok", local: { files: [{ path: "local.txt", status: "M" }], truncated: false } }, sessionChanges: [{ path: "session.txt", status: "M" }] };
const inventory = (): ReviewInventory => ({ source: { scope: "pull-request", label: "PR", base: "base", head: "published", observedAt: "", revision: "review", published: true, notPublished: true }, files: [{ path: "changed.txt", status: "M" }], threads: [], truncated: false });
const signal = () => new AbortController().signal;
beforeEach(() => vi.mocked(developmentRequest).mockReset());
it("encodes each bound PR URL as one query value", () => {
  const url = "https://github.com/example/repo/pull/2?tab=files&x=y";
  const query = reviewQuery(`pr:${url}`);
  expect(query.get("scope")).toBe("pull-request"); expect(query.get("pullRequestUrl")).toBe(url); expect([...query.keys()]).toEqual(["scope", "pullRequestUrl"]);
});
it.each(["local", "session"])("retains honest %s review on a Core with an absent endpoint", async view => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Missing route", "workspace_failed", 404));
  const value = await readReview("workspace", tree, view, signal());
  expect(value).toMatchObject({ legacy: true, source: { scope: view, head: "local-head", published: false, notPublished: true } });
  expect(value.files).toEqual(view === "local" ? tree.observation!.local!.files : tree.sessionChanges);
  vi.mocked(developmentRequest).mockResolvedValueOnce({ path: "local.txt", combined: "legacy text", binary: false, truncated: false });
  const result = await readReviewDiff("workspace", tree, view, "local.txt", value, signal());
  expect(result.localRangesComplete).toBe(false); expect(developmentRequest).toHaveBeenLastCalledWith(`/workspace/worktrees/tree/diff?path=local.txt&view=${view}`, undefined, expect.any(AbortSignal));
});
it.each([[403, "forbidden"], [404, "workspace_not_found"], [404, "app_not_found"], [500, "workspace_failed"]])("does not bypass %i %s with older workspace data", async (status, code) => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Actual failure", code, status));
  await expect(readReview("workspace", tree, "session", signal())).rejects.toThrow("Actual failure"); expect(developmentRequest).toHaveBeenCalledOnce();
});
it.each(["target", "pr:https://github.com/example/repo/pull/1"])("does not turn unsupported %s review into an unrelated workspace diff", async view => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Missing route", "not_found", 404));
  await expect(readReview("workspace", tree, view, signal())).rejects.toMatchObject({ code: "review_api_unavailable", status: 409 });
});
it("rejects malformed inventories and invalid diff overlap evidence rather than crashing the renderer", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ source: { revision: "review" }, files: [] });
  await expect(readReview("workspace", tree, "session", signal())).rejects.toThrow("invalid review response");
  const valid: ReviewDiff = { source: inventory().source, diff: { path: "changed.txt", combined: "patch", binary: false, truncated: false }, localRanges: [], localRangesComplete: true };
  for (const malformed of [{ ...valid, localRanges: undefined }, { ...valid, localRangesComplete: undefined }, { ...valid, localRanges: [{ startLine: 0, endLine: 2 }] }, { ...valid, localRanges: [{ startLine: 4, endLine: 2 }] }, { ...valid, diff: { path: "changed.txt" } }]) {
    vi.mocked(developmentRequest).mockResolvedValueOnce(malformed);
    await expect(readReviewDiff("workspace", tree, "target", "changed.txt", inventory(), signal())).rejects.toThrow("invalid review diff response");
  }
});
it("lists comments on unchanged or removed files exactly once", () => {
  const value = inventory(); value.threads = ["changed.txt", "removed.txt", "removed.txt"].map((path, index) => ({ id: `${index}`, path, resolved: false, comments: [] }));
  expect(reviewFiles(value)).toEqual([{ path: "changed.txt", status: "M" }, { path: "removed.txt", status: "", reviewOnly: true }]); expect(value.files).toHaveLength(1);
});
it("marks overlap only with complete published evidence and current positive same-side coordinates", () => {
  const value = inventory(); const thread = (id: string, fields: Partial<ReviewThread> = {}): ReviewThread => ({ id, path: "changed.txt", line: 12, startLine: 10, diffSide: "RIGHT", resolved: false, comments: [], ...fields });
  value.threads = [thread("overlap"), thread("outside", { startLine: 20, line: 21 }), thread("left", { diffSide: "LEFT" }), thread("outdated", { outdated: true }), thread("cross-side", { startDiffSide: "LEFT" }), thread("reversed", { startLine: 13 }), thread("invalid", { startLine: 0 }), thread("fraction", { line: 12.5 })];
  const result: ReviewDiff = { source: value.source, diff: { path: "changed.txt", combined: "patch", binary: false, truncated: false }, localRanges: [{ startLine: 12, endLine: 12 }], localRangesComplete: true };
  expect(fileThreads(value, "changed.txt", result).filter(thread => thread.changedLocally).map(thread => thread.id)).toEqual(["overlap"]);
  expect(fileThreads(value, "changed.txt", { ...result, localRangesComplete: false }).every(thread => !thread.changedLocally)).toBe(true);
  expect(fileThreads(value, "changed.txt", { ...result, source: { ...result.source, published: false } }).every(thread => !thread.changedLocally)).toBe(true);
  expect(fileThreads(value, "changed.txt", result).find(thread => thread.id === "overlap")?.resolved).toBe(false);
});

it("passes the explicit comparison PR for a working scope and keeps it pinned to the inventory URL/head", async () => {
  const url = "https://github.com/example/repo/pull/7?view=files&value=a b";
  expect(reviewQuery("session", url).get("pullRequestUrl")).toBe(url);
  expect(reviewQuery(`pr:${url}`, "https://github.com/example/repo/pull/8").get("pullRequestUrl")).toBe(url);
  const value = inventory(); value.source = { ...value.source, scope: "session", published: false, publishedComparisonUrl: url, publishedComparisonHead: "published-comparison" };
  vi.mocked(developmentRequest).mockResolvedValueOnce(value); await readReview("workspace", tree, "session", signal(), url);
  expect(new URL(`https://core.test${vi.mocked(developmentRequest).mock.calls[0][0]}`).searchParams.get("pullRequestUrl")).toBe(url);
  const result: ReviewDiff = { source: value.source, diff: { path: "changed.txt", combined: "patch", binary: false, truncated: false }, localRanges: [], localRangesComplete: false, publishedEvidence: { pullRequestUrl: url, head: "published-comparison", complete: true, unpublishedRanges: [{ startLine: 2, endLine: 3 }] } };
  vi.mocked(developmentRequest).mockResolvedValueOnce(result); await expect(readReviewDiff("workspace", tree, "session", "changed.txt", value, signal())).resolves.toBe(result);
  const query = new URL(`https://core.test${vi.mocked(developmentRequest).mock.calls[1][0]}`).searchParams;
  expect(query.get("pullRequestUrl")).toBe(url); expect(query.get("revision")).toBe(value.source.revision);
});
it.each([{ head: "other-head" }, { pullRequestUrl: "https://github.com/example/repo/pull/8" }, { complete: undefined }, { unpublishedRanges: [{ startLine: 0, endLine: 1 }] }, { unpublishedRanges: [{ startLine: 5, endLine: 2 }] }])("rejects invalid or mismatched published-line comparison evidence: %j", async change => {
  const value = inventory(); value.source.publishedComparisonUrl = "https://github.com/example/repo/pull/7"; value.source.publishedComparisonHead = "published-comparison";
  vi.mocked(developmentRequest).mockResolvedValueOnce({ source: value.source, diff: { path: "changed.txt", combined: "patch", binary: false, truncated: false }, localRanges: [], localRangesComplete: true,
    publishedEvidence: { pullRequestUrl: value.source.publishedComparisonUrl, head: value.source.publishedComparisonHead, complete: true, unpublishedRanges: [], ...change } });
  await expect(readReviewDiff("workspace", tree, "session", "changed.txt", value, signal())).rejects.toThrow("published-line evidence");
});
