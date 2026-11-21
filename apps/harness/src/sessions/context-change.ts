import { AppContextError } from "./app-context.js";
import { messageRequestId, type SessionRecord } from "./store.js";
import type { AgentConnectionSelection } from "../agent-providers/types.js";

export function contextChangeInput(input: Record<string, unknown>) {
  const { expectedRevision, connectionId, expectedBinding, model, reasoningEffort, mode } = input;
  const validChoice = (value: unknown): value is string | null =>
    value === null || typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/.test(value);
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || typeof connectionId !== "string" || !connectionId || connectionId.length > 512
    || typeof expectedBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedBinding)
    || !validChoice(model) || !validChoice(reasoningEffort) || (mode !== "fresh" && mode !== "resume"))
    throw new AppContextError(400, "context_choice_invalid", "Review the connection, model and context choice.");
  let requestId: string;
  try { requestId = messageRequestId(input.requestId); }
  catch { throw new AppContextError(400, "context_request_invalid", "A UUID is required for this context change."); }
  return { requestId, expectedRevision, connectionId, expectedBinding, model, reasoningEffort, mode } as const;
}

export function sameProviderInterface(a: AgentConnectionSelection["provider"], b: AgentConnectionSelection["provider"]) {
  return a.appId === b.appId && a.key === b.key;
}

/** Losing an installation never settles a pending command or releases the resource it owns. */
export function contextChangeBlocked(record: SessionRecord, originalInstalled: boolean, resumingSend?: string): string | undefined {
  if (record.taskExecutionId || record.taskDispatch) return "An accepted task keeps its assigned provider and model.";
  if (record.handoffPending || ["queued", "unknown", "running"].includes(record.handoffDispatch?.state ?? ""))
    return "Finish the outstanding handoff before changing context.";
  if (record.workerRun || record.workerRecovery?.state === "pending" || record.sourceAdmission || record.providerRetirement || record.providerRecovery?.state === "pending"
      || record.retentionCleanup || record.subagentStartPending || record.subagentsPending
      || record.associationRequests?.some(request => request.state === "pending") || record.coreEnvironmentOperations?.some(op => op.state === "pending")
      || record.decisionWaitIds?.length || record.developmentLease && record.developmentLeaseState !== "stopped")
    return "Finish this chat’s pending execution or workspace operation before changing context.";
  const state = record.providerExecution;
  if (originalInstalled && (["running", "awaiting_approval", "awaiting_question"].includes(record.status)
    || state?.runId && !state.run?.stopConfirmed || Object.keys(state?.mutations ?? {}).length
    || Object.values(state?.continuations ?? {}).some(item => item.state === "pending" || item.state === "awaiting_authorization")))
    return "Finish or stop the current turn before changing context.";
  if (state?.runId && !state.run?.stopConfirmed && state.lastRunInput?.input.resources?.length)
    return `The previous execution still has an unconfirmed claim on ${state.lastRunInput.input.resources.map(resource => resource.id).join(", ")}. Reconcile it before using the workspace again.`;
  if (record.messageQueue?.entries.some(entry => entry.state === "unknown" || entry.state === "sending" && (!resumingSend || entry.attempt?.clientRequestId !== resumingSend)))
    return "Review the outstanding queued send before changing context.";
}
