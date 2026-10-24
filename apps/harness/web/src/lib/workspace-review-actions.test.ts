// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { developmentRequest, DevelopmentRequestError } from "./development-api";
import { submitReviewAction } from "./workspace-review-actions";
import { ReviewThreadActionError } from "@/components/review-thread";
import type { ReviewSource } from "./workspace-review-api";
vi.mock("./development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
const source: ReviewSource = { scope: "pull-request", label: "PR", base: "base", head: "original-published-head", pullRequestUrl: "https://github.com/example/repo/pull/1", observedAt: "", revision: "revision", published: true, notPublished: false };
const requestId = "4b46e38c-c57e-45a4-b698-a485a3f3c7e4";
beforeEach(() => { sessionStorage.clear(); vi.mocked(developmentRequest).mockReset(); });
it("persists the full original reply intent before sending and replays it after the observed head changes", async () => {
  vi.mocked(developmentRequest).mockImplementationOnce(async () => {
    expect(JSON.parse(sessionStorage.getItem(`hosty.review-intent.${requestId}`)!)).toMatchObject({ workspaceId: "workspace", treeId: "tree", command: { requestId, expectedHead: "original-published-head", authorIntent: true, body: "Reply", threadId: "thread" } });
    throw new Error("Response lost");
  });
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Reply")).rejects.toThrow("Response lost");
  const command = vi.mocked(developmentRequest).mock.calls[0][1];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "succeeded" });
  await submitReviewAction("workspace", "tree", { ...source, head: "new-head" }, "reply", "thread", requestId, "Reply", false);
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/worktrees/tree/reviews/reply", command); expect(sessionStorage.length).toBe(0);
});
it("recovers an uncertain original resolve after the PR closes and rejects fresh actions while unavailable", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "pending", error: "Await provider result" }).mockResolvedValueOnce({ state: "succeeded" });
  await expect(submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId)).rejects.toThrow("Await provider result");
  await submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId, undefined, false);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  await expect(submitReviewAction("workspace", "tree", source, "resolve", "thread", "new-request", undefined, false)).rejects.toMatchObject({ definitive: true });
  expect(developmentRequest).toHaveBeenCalledTimes(2);
});
it("never changes an existing recovery into another workspace, PR, thread, operation or body", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Unknown"));
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Original")).rejects.toThrow("Unknown");
  const attempts = [
    submitReviewAction("other", "tree", source, "reply", "thread", requestId, "Original"),
    submitReviewAction("workspace", "other", source, "reply", "thread", requestId, "Original"),
    submitReviewAction("workspace", "tree", { ...source, pullRequestUrl: "https://github.com/example/repo/pull/2" }, "reply", "thread", requestId, "Original"),
    submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId),
    submitReviewAction("workspace", "tree", source, "reply", "other-thread", requestId, "Original"),
    submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Changed"),
  ];
  for (const attempt of attempts) await expect(attempt).rejects.toThrow("another review action");
  expect(developmentRequest).toHaveBeenCalledOnce();
});
it.each([400, 401, 403, 404, 422])("releases a fresh definitely rejected HTTP %i intent", async status => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Rejected", "rejected", status));
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Reply")).rejects.toBeInstanceOf(ReviewThreadActionError);
  expect(sessionStorage.length).toBe(0);
});
it("retains a previously uncertain intent through a later authority failure and clears definite operation failures", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Lost response")).mockRejectedValueOnce(new DevelopmentRequestError("Login again", "unauthorized", 401)).mockResolvedValueOnce({ state: "failed", error: "Head stale" });
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Reply")).rejects.toThrow("Lost response");
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Reply")).rejects.toThrow("Login again"); expect(sessionStorage.length).toBe(1);
  await expect(submitReviewAction("workspace", "tree", source, "reply", "thread", requestId, "Reply")).rejects.toMatchObject({ definitive: true }); expect(sessionStorage.length).toBe(0);
});
it("does not issue writes for unpublished views or if durable recovery cannot be saved", async () => {
  await expect(submitReviewAction("workspace", "tree", { ...source, published: false }, "resolve", "thread", requestId)).rejects.toMatchObject({ definitive: true });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try { await expect(submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId)).rejects.toThrow("Storage unavailable"); }
  finally { set.mockRestore(); }
  expect(developmentRequest).not.toHaveBeenCalled();
});

it("retains an unknown response for recovery rather than treating it as a rejected write", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "unrecognized" }).mockResolvedValueOnce({ state: "succeeded" });
  await expect(submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId)).rejects.toThrow("unknown review action result"); expect(sessionStorage.length).toBe(1);
  await submitReviewAction("workspace", "tree", source, "resolve", "thread", requestId); expect(sessionStorage.length).toBe(0);
});
