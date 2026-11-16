import { AgentApiError } from "@hosty-sdk/app/agent";
import type { ExecutionSelection, ModelCatalog } from "./compatibility.js";

/** Validate the public catalog without loading an execution adapter or its vendor SDK. */
export function validateSelection(selection: ExecutionSelection, available: ModelCatalog): void {
  if (selection.model === null && selection.reasoningEffort === null) return;
  const model = available.models.find(candidate => candidate.id === (selection.model ?? available.defaultModel));
  if (!model || model.unavailableReason) throw new AgentApiError("model_unavailable", "Select an available model for this connection.", 400);
  if (selection.reasoningEffort !== null && !model.efforts.some(effort => effort.id === selection.reasoningEffort))
    throw new AgentApiError("effort_unavailable", "This model does not support the selected reasoning effort.", 400);
}
