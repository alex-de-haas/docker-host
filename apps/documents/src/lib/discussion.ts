import type { PlanDetail } from "./types";
import type { AppSurfaceRef, PanelTarget } from "@hosty-sdk/app/ui";

export type DiscussionChoice = { appId: string; installationId: string | null; key: string; displayName: string; problem: string | null };
export type DiscussionOptions = { userId: string; providers: DiscussionChoice[] };
export type DiscussionInput = {
  intent?: "discuss" | "questions" | "repair" | "implement";
  repositoryId: string; path: string; workspaceId: string | null; contentHash: string;
  providerAppId: string; installationId: string; key: string; requestId: string;
};
export type DiscussionResult = { url: string; conversationId: string; target: PanelTarget | null; destination: AppSurfaceRef; reason?: "no_panel" | "ambiguous_surface" };

export function discussionVersion(detail: PlanDetail, workspaceId: string | null) {
  if (!workspaceId)
    return detail.document && !detail.error
      ? { document: detail.document, workspaceId: null, label: `Tracked branch: ${detail.repository.branch}` }
      : null;
  const version = detail.workspaces.find(item => item.workspace.id === workspaceId);
  if (!version?.document || version.error) return null;
  return { document: version.document, workspaceId: version.workspace.id, label: `Workspace: ${version.workspace.branch}` };
}
