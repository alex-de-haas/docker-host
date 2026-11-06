import type { TaskWorkflowBinding } from "@hosty-sdk/app/providers";
import type { TaskRecord } from "@hosty-sdk/app/tasks";
import { activeAttempt, fingerprint, taskError, type TaskState, type TaskStore } from "./store.js";

/** Called again inside the provider's writer, after Core checked its own current authority. */
export function assertTaskCoordinator(store: TaskStore, state: TaskState, binding: TaskWorkflowBinding, owner: string, target?: TaskRecord): TaskRecord {
  const parent = store.find(state, binding.parentTaskRef.id, { userId: owner, appId: null });
  const root = store.find(state, binding.rootTaskRef.id, { userId: owner, appId: null });
  const current = activeAttempt(parent), coordinator = parent.coordination;
  if (fingerprint(parent.ref) !== fingerprint(binding.parentTaskRef) || fingerprint(root.ref) !== fingerprint(binding.rootTaskRef)
    || parent.owner.userId !== owner || root.owner.userId !== owner || parent.rootTaskRef.id !== root.ref.id
    || root.parentTaskRef || ["Done", "Cancelled"].includes(root.status) || root.cancelRequested || parent.cancelRequested
    || current?.executionId !== binding.parentExecutionId || current.cancelRequested || current.invalidated
    || coordinator?.executionId !== binding.parentExecutionId || coordinator.coordinatorEpoch !== binding.coordinatorEpoch
    || coordinator.rootGeneration !== binding.rootGeneration || root.coordination?.rootGeneration !== binding.rootGeneration)
    return taskError("stale_input", "This coordinator is no longer the admitted parent of the current root generation.");
  if (target && (target.rootTaskRef.id !== root.ref.id || target.ref.id !== parent.ref.id && target.parentTaskRef?.id !== parent.ref.id))
    return taskError("permission_denied", "An executor may manage only its own task and direct children.", 403);
  return parent;
}
