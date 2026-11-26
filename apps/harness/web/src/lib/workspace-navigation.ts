import type { AssistantSession } from "./assistant-api";
import type { DevelopmentWorkspace, WorkspaceParticipation } from "./development-api";
import { activityTime, isWaiting, lastSeenStatus, observedSessionStatus, orderSessions, type LastSeen } from "./attention";

export type ActivityCounts = { working: number; waiting: number; failed: number; unknown: number; lastSeen?: LastSeen[] };
export const emptyCounts = (): ActivityCounts => ({ working: 0, waiting: 0, failed: 0, unknown: 0 });
export function countStatus(counts: ActivityCounts, status: string, lastSeen?: LastSeen) {
  if (lastSeen) (counts.lastSeen ??= []).push(lastSeen);
  if (status === "running") counts.working++;
  else if (isWaiting(status)) counts.waiting++;
  else if (status === "failed") counts.failed++;
  else if (["unknown", "stopping"].includes(status)) counts.unknown++;
}
export function attachedWorkspaceSessionIds(participation: WorkspaceParticipation): string[] {
  return [...new Set(participation.sessions.filter(session => session.attached && session.canOpen).map(session => session.sessionId))];
}
export function workspaceSessionIds(workspace: DevelopmentWorkspace): string[] {
  return workspace.participation ? attachedWorkspaceSessionIds(workspace.participation)
    : workspace.owner.kind === "assistant" && workspace.owner.appId === "hosty.harness" ? [workspace.owner.reference] : [];
}
export function workspaceChats(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[]) {
  const ids = new Set(workspaceSessionIds(workspace));
  return orderSessions(sessions.filter(s => ids.has(s.id)));
}
export function workspaceActivityRows(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[], now: number) {
  const attached = workspace.participation?.sessions.filter(s => s.attached) ?? [];
  const executions = new Map<string, number>();
  for (const row of attached) if (row.kind === "execution" && row.activityGroup)
    executions.set(row.activityGroup, 1 + (executions.get(row.activityGroup) ?? 0));
  const chats = new Map(attached.filter(s => s.canOpen && s.activityGroup).map(s => [s.activityGroup, s.sessionId]));
  return attached.map(binding => {
    const linked = binding.activityGroup ? executions.get(binding.activityGroup) : undefined;
    // A chat and its one native execution can report the same ongoing work.
    const chatId = binding.canOpen ? binding.sessionId : binding.kind === "execution" && linked === 1 && binding.activityGroup ? chats.get(binding.activityGroup) : undefined;
    const own = chatId ? sessions.find(s => s.id === chatId) : undefined;
    const observed = Date.parse(binding.activityAt ?? "");
    const active = !["idle", "failed", "cancelled", "completed"].includes(binding.status);
    const status = own ? observedSessionStatus(own) : active && (!Number.isFinite(observed) || now - observed > 45_000) ? "unknown" : binding.status;
    const lastSeen = own ? lastSeenStatus(own) : status === "unknown" && binding.status !== "unknown"
      ? { status: binding.status, observedAt: binding.activityAt } : undefined;
    return { binding, status, lastSeen, counted: binding.kind === "execution" || !linked };
  });
}
export function workspaceCounts(workspace: DevelopmentWorkspace, sessions: readonly AssistantSession[], now = Date.now()): ActivityCounts {
  const counts = emptyCounts();
  if (workspace.participation) {
    for (const row of workspaceActivityRows(workspace, sessions, now)) if (row.counted) countStatus(counts, row.status, row.lastSeen);
  } else {
    for (const session of workspaceChats(workspace, sessions)) countStatus(counts, observedSessionStatus(session), lastSeenStatus(session));
  }
  return counts;
}
export type NavigationItem = { key: string; label: string; at: number; counts: ActivityCounts; workspace?: DevelopmentWorkspace; session?: AssistantSession; matches: AssistantSession[]; search: string };
export function navigationItems(workspaces: readonly DevelopmentWorkspace[], sessions: readonly AssistantSession[], now = Date.now()): NavigationItem[] {
  const listedWorkspaces = workspaces.filter(w => w.workflow.state !== "deleted");
  // Only an accessible chat in a listed workspace is represented by its workspace row.
  // Session-side source history alone must not hide chats after removal or lost access.
  const represented = new Set(listedWorkspaces.flatMap(workspaceSessionIds));
  const items: NavigationItem[] = listedWorkspaces.map(workspace => {
    const chats = workspaceChats(workspace, sessions);
    const label = workspace.name?.trim() || workspace.owner.label?.trim() || "Workspace";
    return { key: `workspace:${workspace.id}`, label, workspace, matches: chats, counts: workspaceCounts(workspace, sessions, now),
      at: Math.max(activityTime(workspace), ...chats.map(activityTime), ...(workspace.participation?.sessions.filter(s => s.attached).map(s => Date.parse(s.changedAt ?? "") || 0) ?? [])),
      search: [label, ...workspace.participation?.sessions.filter(s => s.attached).map(s => s.title) ?? [], ...chats.flatMap(s => [s.title, ...s.contextApps?.map(a => a.displayName) ?? [], ...s.appIds ?? []])].join(" ").toLowerCase() };
  });
  for (const session of sessions) {
    if (represented.has(session.id)) continue;
    const counts = emptyCounts(); countStatus(counts, observedSessionStatus(session), lastSeenStatus(session));
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
