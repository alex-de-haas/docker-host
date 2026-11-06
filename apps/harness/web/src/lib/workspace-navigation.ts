import type { AssistantSession } from "./assistant-api";
import type { DevelopmentWorkspace } from "./development-api";
import { activityTime, isWaiting, orderSessions } from "./attention";

export type ActivityCounts = { working: number; waiting: number; failed: number; unknown: number };
export const emptyCounts = (): ActivityCounts => ({ working: 0, waiting: 0, failed: 0, unknown: 0 });
export function countStatus(counts: ActivityCounts, status: string) {
  if (status === "running") counts.working++;
  else if (isWaiting(status)) counts.waiting++;
  else if (status === "failed") counts.failed++;
  else if (["unknown", "stopping"].includes(status)) counts.unknown++;
}
export function workspaceSessionIds(workspace: DevelopmentWorkspace): string[] {
  return workspace.participation ? workspace.participation.sessions.filter(s => s.attached && s.canOpen).map(s => s.sessionId)
    : workspace.owner.kind === "assistant" && workspace.owner.appId === "hosty.harness" ? [workspace.owner.reference] : [];
}
export function workspaceChats(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[]) {
  const ids = new Set(workspaceSessionIds(workspace));
  return orderSessions(sessions.filter(s => ids.has(s.id)));
}
export function workspaceCounts(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[], now = Date.now()): ActivityCounts {
  const counts = emptyCounts();
  if (!workspace.participation) {
    workspaceChats(workspace, sessions).forEach(s => countStatus(counts, s.status));
    return counts;
  }
  for (const binding of workspace.participation.sessions.filter(s => s.attached)) {
    // Current authenticated own-session events can lead the bounded Core heartbeat.
    const own = binding.canOpen ? sessions.find(s => s.id === binding.sessionId) : undefined;
    const newer = own && activityTime(own) > (Date.parse(binding.activityAt ?? "") || 0)
      && (!["running", "awaiting_approval", "awaiting_question"].includes(own.status) || now - activityTime(own) <= 45_000);
    const observed = Date.parse(binding.activityAt ?? "");
    const status = newer ? own.status : !["idle", "failed"].includes(binding.status) && (!Number.isFinite(observed) || now - observed > 45_000) ? "unknown" : binding.status;
    countStatus(counts, status);
  }
  return counts;
}
export type NavigationItem = { key: string; label: string; at: number; counts: ActivityCounts; workspace?: DevelopmentWorkspace; session?: AssistantSession; matches: AssistantSession[]; search: string };
export function navigationItems(workspaces: readonly DevelopmentWorkspace[], sessions: readonly AssistantSession[], now = Date.now(), view: "workspaces" | "chats" = "workspaces"): NavigationItem[] {
  const items: NavigationItem[] = (view === "workspaces" ? workspaces : []).filter(w => w.workflow.state !== "deleted").map(workspace => {
    const chats = workspaceChats(workspace, sessions);
    const label = workspace.name?.trim() || workspace.owner.label?.trim() || "Workspace";
    return { key: `workspace:${workspace.id}`, label, workspace, matches: chats, counts: workspaceCounts(workspace, sessions, now),
      at: Math.max(activityTime(workspace), ...chats.map(activityTime), ...(workspace.participation?.sessions.filter(s => s.attached).map(s => Date.parse(s.changedAt ?? "") || 0) ?? [])),
      search: [label, ...workspace.participation?.sessions.filter(s => s.attached).map(s => s.title) ?? [], ...chats.flatMap(s => [s.title, ...s.contextApps?.map(a => a.displayName) ?? [], ...s.appIds ?? []])].join(" ").toLowerCase() };
  });
  for (const session of view === "chats" ? sessions : []) {
    const counts = emptyCounts(); countStatus(counts, session.status);
    const label = session.title?.trim() || "Untitled session";
    items.push({ key: `session:${session.id}`, label, session, counts, at: activityTime(session), matches: [],
      search: [label, ...session.contextApps?.map(a => a.displayName) ?? [], ...session.appIds ?? []].join(" ").toLowerCase() });
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}
export function rememberedWorkspaceSession(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[]): AssistantSession | undefined {
  const chats = workspaceChats(workspace, sessions);
  try {
    const id = sessionStorage.getItem(`hosty.workspace-tab:${workspace.participation?.viewerUserId ?? "legacy"}:${workspace.id}`);
    return chats.find(s => s.id === id) ?? chats[0];
  } catch { return chats[0]; }
}
export function rememberWorkspaceSession(workspace: DevelopmentWorkspace, id: string) {
  try { sessionStorage.setItem(`hosty.workspace-tab:${workspace.participation?.viewerUserId ?? "legacy"}:${workspace.id}`, id); } catch { /* Optional navigation memory. */ }
}
