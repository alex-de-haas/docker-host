import type { PlanDetail } from "./types";

export type DiscussionChoice = { appId: string; key: string; displayName: string; problem: string | null };
export type DiscussionOptions = { userId: string; providers: DiscussionChoice[] };
export type DiscussionInput = {
  repositoryId: string; path: string; workspaceId: string | null; contentHash: string;
  providerAppId: string; key: string; requestId: string;
};

export function discussionVersion(detail: PlanDetail, workspaceId: string | null) {
  if (!workspaceId)
    return detail.document && !detail.error
      ? { document: detail.document, workspaceId: null, label: `Tracked branch: ${detail.repository.branch}` }
      : null;
  const version = detail.workspaces.find(item => item.workspace.id === workspaceId);
  if (!version?.document || version.error) return null;
  return { document: version.document, workspaceId: version.workspace.id, label: `Workspace: ${version.workspace.branch}` };
}
