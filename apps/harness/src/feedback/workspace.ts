export interface FeedbackWorkspaceSession {
  workspaceAssociation?: { id: string } | null;
  developmentWorkspaces?: readonly { state: string; workspaceId?: string | null }[];
}

/** Source-prepared chats may have retained worktrees without an explicit association. */
export function feedbackWorkspace(session: FeedbackWorkspaceSession): string | null {
  if (session.workspaceAssociation) return session.workspaceAssociation.id;
  const ids = [...new Set((session.developmentWorkspaces ?? []).filter(w => w.state === "active")
    .map(w => w.workspaceId).filter((id): id is string => !!id))];
  return ids.length === 1 ? ids[0]! : null;
}
