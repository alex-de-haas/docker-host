"use client";
import { developmentRequest, DevelopmentRequestError } from "./development-api";
import { ReviewThreadActionError } from "@/components/review-thread";
import { reviewRoot, type ReviewSource } from "./workspace-review-api";
type Intent = { kind: "reply" | "resolve"; workspaceId: string; treeId: string; command: { requestId: string; pullRequestUrl: string; expectedHead: string; threadId: string; body?: string; authorIntent: true } };
export async function submitReviewAction(workspaceId: string, treeId: string, source: ReviewSource, kind: Intent["kind"], threadId: string, requestId: string, body?: string, canStart = true): Promise<void> {
  const key = `hosty.review-intent.${requestId}`;
  let intent: Intent;
  const stored = sessionStorage.getItem(key);
  const recovering = !!stored;
  if (stored) {
    intent = JSON.parse(stored) as Intent;
    if (intent.workspaceId !== workspaceId || intent.treeId !== treeId || intent.kind !== kind || intent.command.threadId !== threadId || intent.command.pullRequestUrl !== source.pullRequestUrl || intent.command.body !== body)
      throw new Error("The pending request belongs to another review action. Recover it in its original review.");
  } else {
    if (!canStart) throw new ReviewThreadActionError("Refresh a complete observation of an open PR before starting a review action.", true);
    if (!source.published || !source.pullRequestUrl || !source.head) throw new ReviewThreadActionError("An observed published PR is required.", true);
    intent = { kind, workspaceId, treeId, command: { requestId, pullRequestUrl: source.pullRequestUrl, expectedHead: source.head, threadId, ...(body !== undefined ? { body } : {}), authorIntent: true } };
    // Persist the entire intent before sending; a later head refresh must never change a replay.
    sessionStorage.setItem(key, JSON.stringify(intent));
  }
  try {
    const result = await developmentRequest<{ state: string; error?: string }>(`${reviewRoot(workspaceId, treeId)}/reviews/${kind}`, intent.command);
    if (result?.state === "pending") throw new Error(result.error || "The provider result is uncertain. Retry to recover this request.");
    if (result?.state === "failed") throw new ReviewThreadActionError(result.error || "The review action was rejected.", true);
    if (result?.state !== "succeeded") throw new Error("Core returned an unknown review action result. Retry to recover this request.");
    sessionStorage.removeItem(key);
  } catch (error) {
    if (error instanceof ReviewThreadActionError && error.definitive) sessionStorage.removeItem(key);
    // Transport errors retain the original intent, including its original expected head.
    if (!recovering && error instanceof DevelopmentRequestError && [400, 401, 403, 404, 422].includes(error.status ?? 0)) {
      sessionStorage.removeItem(key); throw new ReviewThreadActionError(error.message, true);
    }
    throw error;
  }
}

export type NewReviewComment = { path: string; diffSide: "LEFT" | "RIGHT"; startLine: number; line: number; body: string };
export type NewReviewCommentResult = { threadId: string; commentId?: string };
export async function submitReviewComment(workspaceId: string, treeId: string, source: ReviewSource, input: NewReviewComment, requestId: string, canStart = true, recovering = false): Promise<NewReviewCommentResult> {
  const key = `hosty.review-intent.${requestId}`;
  const stored = sessionStorage.getItem(key);
  const candidate = { kind: "comment", workspaceId, treeId, command: { requestId, pullRequestUrl: source.pullRequestUrl, expectedHead: source.head, threadId: "", ...input, authorIntent: true } };
  let intent = candidate;
  if (stored) {
    intent = JSON.parse(stored) as typeof candidate;
    const oldCommand = { ...intent.command, expectedHead: null };
    const newCommand = { ...candidate.command, expectedHead: null };
    if (intent.kind !== "comment" || intent.workspaceId !== workspaceId || intent.treeId !== treeId || JSON.stringify(oldCommand) !== JSON.stringify(newCommand))
      throw new Error("Recover the original comment before changing its file, range or body.");
  } else {
    if ((!canStart && !recovering) || !source.published || !source.pullRequestUrl || !source.head) throw new ReviewThreadActionError("Open a current published PR diff before creating a comment.", true);
    sessionStorage.setItem(key, JSON.stringify(intent));
  }
  try {
    const result = await developmentRequest<{ state: string; error?: string; threadId?: string; commentId?: string }>(`${reviewRoot(workspaceId, treeId)}/reviews/comment`, intent.command);
    if (result?.state === "failed") throw new ReviewThreadActionError(result.error || "The comment was rejected.", true);
    if (result?.state !== "succeeded" || typeof result.threadId !== "string" || !result.threadId.trim() || (result.commentId != null && typeof result.commentId !== "string")) throw new Error(result?.error || "Could not confirm this comment. Recover using the same request.");
    sessionStorage.removeItem(key);
    return { threadId: result.threadId, commentId: result.commentId };
  } catch (error) {
    if (error instanceof ReviewThreadActionError && error.definitive) sessionStorage.removeItem(key);
    if (!stored && !recovering && error instanceof DevelopmentRequestError && [400, 401, 403, 404, 422].includes(error.status ?? 0)) {
      sessionStorage.removeItem(key); throw new ReviewThreadActionError(error.message, true);
    }
    throw error;
  }
}
