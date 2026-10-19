import type { RetentionSettings } from "../settings/store.js";
import type { RetentionSnapshot } from "./development.js";
import type { SessionRecord } from "./store.js";

export interface RetentionStatus {
  state: "off" | "protected" | "scheduled" | "blocked" | "deleting";
  kind?: RetentionSnapshot["kind"];
  dueAt?: string;
  completedAt?: string;
  message: string;
  observedAt: string;
}
export function retentionBusy(record: SessionRecord): boolean {
  return ["running", "awaiting_approval", "awaiting_question"].includes(record.status)
    || record.workspaceActivation?.state === "queued" || record.workflowCompletion?.state === "queued" || !!record.handoffPending || !!record.handoffDraft
    || ["queued", "running", "unknown"].includes(record.handoffDispatch?.state ?? "")
    || !!record.appCreations?.some(o => o.state === "pending")
    || !!record.mcpPendingApprovals?.length
    || !!record.coreEnvironmentOperations?.some(o => o.state === "pending")
    || !!record.sandboxOperations?.some(o => o.state === "pending");
}
export function hasResourceHistory(record: SessionRecord): boolean {
  return !!(record.appCreations?.some(o => o.state !== "rejected") || record.developmentLease || record.developmentWorkspaces?.length || record.publicationReferences?.length || record.coreEnvironments?.length
    || record.sandboxInstances?.length || record.coreEnvironmentOperations?.length || record.sandboxOperations?.length);
}
// Core deliberately retains no successful Delete receipt. Only its explicit absence
// confirmation can reconcile local history; older/unavailable Core remains fail-closed.
export function reconcileRetentionSnapshot(record: SessionRecord, snapshot: RetentionSnapshot): RetentionSnapshot {
  const workspaceHistory = record.developmentLease || record.developmentWorkspaces?.length
    || record.publicationReferences?.length || record.retentionCleanup;
  if (!snapshot.workspaceAbsent || snapshot.workflow || !workspaceHistory) return snapshot;
  return { ...snapshot, kind: "workspace", workflow: {
    state: "deleted", revision: 0, completedAt: record.retention?.completedAt ?? record.updatedAt,
  } };
}
export function retentionStatus(record: SessionRecord, policy: RetentionSettings, snapshot: RetentionSnapshot, now: Date): RetentionStatus {
  const base = { observedAt: now.toISOString(), kind: snapshot.kind };
  if (retentionBusy(record)) return { ...base, state: "protected", message: "Active work, pending input or unresolved operations are retained." };
  if (snapshot.kind === "chat" && hasResourceHistory(record)) return { ...base, state: "blocked", message: "Resource history could not be reconciled with Core." };
  const workflow = snapshot.workflow;
  if (workflow?.closure === "closing")
    return { ...base, state: "protected", message: "An interrupted workspace action must be recovered before retention." };
  if (snapshot.kind === "workspace" && (!workflow || !["completed", "deleted", "deleting"].includes(workflow.state)))
    return { ...base, state: "protected", message: "Unfinished or deferred workspace. No automatic deletion." };
  if (!snapshot.resourcesFinished && snapshot.kind !== "workspace")
    return { ...base, state: "protected", message: "Finish retained sandbox resources before conversation cleanup." };
  const days = snapshot.kind === "workspace" ? policy.completedWorkspaceDays : policy.ordinaryDays;
  if (days === null) return { ...base, state: "off", message: "Automatic deletion is off." };
  const activity = Date.parse(record.updatedAt);
  const completion = snapshot.kind === "workspace" ? Date.parse(workflow?.completedAt ?? "") : activity;
  if (!Number.isFinite(activity) || !Number.isFinite(completion))
    return { ...base, state: "blocked", message: "The retention start time is unknown." };
  const dueAt = new Date(Math.max(activity, completion) + days * 86400000).toISOString();
  return { ...base, state: "scheduled", dueAt, ...(snapshot.kind === "workspace" ? { completedAt: workflow!.completedAt! } : {}),
    message: "Core rechecks completion and resource ownership before deletion." };
}
