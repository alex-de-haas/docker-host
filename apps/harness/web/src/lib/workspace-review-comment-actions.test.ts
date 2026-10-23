// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { developmentRequest, DevelopmentRequestError } from "./development-api";
import { submitReviewComment, type NewReviewComment } from "./workspace-review-actions";
import type { ReviewSource } from "./workspace-review-api";
vi.mock("./development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
const source: ReviewSource = { scope: "pull-request", label: "PR", base: "base", head: "original-published-head", pullRequestUrl: "https://github.com/example/repo/pull/7", observedAt: "", revision: "revision", published: true, notPublished: false };
const input: NewReviewComment = { path: "src/file.ts", diffSide: "RIGHT", startLine: 8, line: 10, body: "Please adjust this range" };
const requestId = "4b46e38c-c57e-45a4-b698-a485a3f3c7e4", key = `hosty.review-intent.${requestId}`;
beforeEach(() => { sessionStorage.clear(); vi.mocked(developmentRequest).mockReset(); });
it("durably saves the complete comment before dispatch and recovers its exact original head after refresh/closure", async () => {
  vi.mocked(developmentRequest).mockImplementationOnce(async () => { expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ kind: "comment", workspaceId: "workspace", treeId: "tree", command: { requestId, expectedHead: source.head, pullRequestUrl: source.pullRequestUrl, authorIntent: true, threadId: "", ...input } }); throw new Error("Lost response"); }).mockResolvedValueOnce({ state: "succeeded", threadId: "thread", commentId: "comment" });
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow("Lost response");
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  await expect(submitReviewComment("workspace", "tree", { ...source, head: "new-head" }, input, requestId, false)).resolves.toEqual({ threadId: "thread", commentId: "comment" });
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/worktrees/tree/reviews/comment", original); expect(sessionStorage.getItem(key)).toBeNull();
});
it("refuses changing a pending comment's workspace, tree, PR, file, side, range or body", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Unknown")); await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow("Unknown");
  for (const attempt of [() => submitReviewComment("other", "tree", source, input, requestId), () => submitReviewComment("workspace", "other", source, input, requestId), () => submitReviewComment("workspace", "tree", { ...source, pullRequestUrl: "https://github.com/example/repo/pull/8" }, input, requestId), ...[{ path: "other.ts" }, { diffSide: "LEFT" as const }, { startLine: 7 }, { line: 11 }, { body: "Changed" }].map(change => () => submitReviewComment("workspace", "tree", source, { ...input, ...change }, requestId))])
    await expect(attempt()).rejects.toThrow("Recover the original comment");
  expect(developmentRequest).toHaveBeenCalledOnce(); expect(sessionStorage.getItem(key)).not.toBeNull();
});
it.each([undefined, null, {}, { state: "pending", error: "Await confirmation" }, { state: "unknown" }, { state: "succeeded" }, { state: "succeeded", threadId: 7 }, { state: "succeeded", threadId: "thread", commentId: {} }])("retains malformed or uncertain provider result for exact-ID recovery: %j", async result => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(result);
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow(); expect(sessionStorage.getItem(key)).not.toBeNull();
});
it("clears a definite rejected operation but preserves uncertain recovery through a later authority failure", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Lost response")).mockRejectedValueOnce(new DevelopmentRequestError("Login again", "unauthorized", 401)).mockResolvedValueOnce({ state: "failed", error: "Head changed" });
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow("Lost response");
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow("Login again"); expect(sessionStorage.getItem(key)).not.toBeNull();
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toMatchObject({ definitive: true }); expect(sessionStorage.getItem(key)).toBeNull();
});
it.each([400, 401, 403, 404, 422])("releases a fresh definitely rejected HTTP %i comment intent", async status => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Rejected", "rejected", status));
  await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toMatchObject({ definitive: true }); expect(sessionStorage.getItem(key)).toBeNull();
});
it.each([{ ...source, published: false }, { ...source, pullRequestUrl: undefined }, { ...source, head: null }])("does not dispatch new comments outside a published PR scope: %j", async invalid => {
  await expect(submitReviewComment("workspace", "tree", invalid, input, requestId)).rejects.toMatchObject({ definitive: true }); expect(developmentRequest).not.toHaveBeenCalled();
});
it("refuses fresh actions without authority or when durable recovery storage cannot be written", async () => {
  await expect(submitReviewComment("workspace", "tree", source, input, requestId, false)).rejects.toMatchObject({ definitive: true });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try { await expect(submitReviewComment("workspace", "tree", source, input, requestId)).rejects.toThrow("Storage unavailable"); } finally { set.mockRestore(); }
  expect(developmentRequest).not.toHaveBeenCalled();
});

it("recovers a composer-saved original request even if its helper intent was not saved before navigation", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "succeeded", threadId: "thread", commentId: "comment" });
  await expect(submitReviewComment("workspace", "tree", source, input, requestId, false, true)).resolves.toEqual({ threadId: "thread", commentId: "comment" });
  expect(vi.mocked(developmentRequest).mock.calls[0][1]).toMatchObject({ requestId, expectedHead: source.head, ...input });
});
it("does not discard a composer recovery UUID after an authority failure merely because helper storage was absent", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Login again", "unauthorized", 401));
  await expect(submitReviewComment("workspace", "tree", source, input, requestId, false, true)).rejects.toThrow("Login again");
  expect(sessionStorage.getItem(key)).not.toBeNull();
});
