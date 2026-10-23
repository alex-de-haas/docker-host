import type { AssistantEvent } from "./assistant-api";
import type { DevelopmentWorkspace } from "./development-api";
import { describeApproval } from "./tool-display";
import type { TranscriptFileEdit, TranscriptReviewReference } from "../../../src/sessions/transcript-edit-types";
export type { TranscriptFileEdit, TranscriptReviewReference };

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function reference(value: unknown): TranscriptReviewReference | undefined {
  const ref = object(value);
  if (![ref.sessionId, ref.workspaceId, ref.worktreeId, ref.repository, ref.path].every(v => typeof v === "string" && v.length > 0 && v.length <= 4_096)) return;
  const file = ref.path as string;
  if (/^[\\/]|^[A-Za-z]:|[\0\r\n]/.test(file) || file.includes("\\") || file.split("/").some(v => !v || v === "." || v === "..")) return;
  return ref as TranscriptReviewReference;
}
/** Old logs stay readable, but a current filename never retroactively grants a source binding. */
export function transcriptEdits(event: AssistantEvent): TranscriptFileEdit[] {
  if (event.type !== "tool_use") return [];
  if (Array.isArray(event.fileEdits)) return event.fileEdits.slice(0, 200).flatMap(value => {
    const item = object(value);
    if (typeof item.path !== "string" || !item.path || item.path.length > 4_096) return [];
    const bound = reference(item.review);
    const review = bound?.path === item.path ? bound : undefined;
    return [{ path: item.path, kind: typeof item.kind === "string" ? item.kind : "edit",
      ...(Number.isSafeInteger(item.additions) && Number(item.additions) >= 0 ? { additions: Number(item.additions) } : {}),
      ...(Number.isSafeInteger(item.deletions) && Number(item.deletions) >= 0 ? { deletions: Number(item.deletions) } : {}),
      ...(review ? { review } : { unavailable: "This transcript has no verified source binding for the file." }),
    }];
  });
  const view = describeApproval(String(event.toolName ?? ""), event.input);
  return view.kind === "file" ? view.changes.filter(v => v.path && v.kind !== "write access").slice(0, 200).map(item => ({
    path: item.path!, kind: item.kind ?? "edit", unavailable: "This older transcript has no recorded source binding. Open Session changes to choose the file.",
  })) : [];
}

/** Require the exact session, owner, repository and tree, even when another source has the same path. */
export function resolveTranscriptReview(ref: TranscriptReviewReference, sessionId: string | undefined,
  workspaces: readonly DevelopmentWorkspace[]) {
  if (!sessionId || ref.sessionId !== sessionId || !reference(ref)) return;
  const matches = workspaces.filter(w => w.id === ref.workspaceId && w.workflow.state !== "deleted"
    && w.owner.kind === "assistant" && w.owner.appId === "hosty.harness" && w.owner.reference === sessionId)
    .flatMap(workspace => workspace.worktrees.filter(tree => tree.id === ref.worktreeId && tree.workspaceId === workspace.id
      && tree.repository === ref.repository && tree.state !== "deleted").map(tree => ({ workspace, tree })));
  return matches.length === 1 ? matches[0] : undefined;
}
