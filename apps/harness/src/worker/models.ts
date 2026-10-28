import { WorkerApiError, type ExecutionSelection, type ModelCatalog, type ModelChoice } from "./contracts.js";
import { digest } from "./journal.js";

export const effortLabel = (id: string): string => id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1);
export function catalog(models: ModelChoice[], defaultModel?: string): ModelCatalog {
  return { revision: digest({ models, defaultModel }), models, ...(defaultModel ? { defaultModel } : {}) };
}
export function validateSelection(selection: ExecutionSelection, available: ModelCatalog): void {
  if (selection.model === null && selection.reasoningEffort === null) return;
  const model = available.models.find(m => m.id === (selection.model ?? available.defaultModel));
  if (!model || model.unavailableReason) throw new WorkerApiError(400, "model_unavailable", "Select an available model for this connection.");
  if (selection.reasoningEffort !== null && !model.efforts.some(e => e.id === selection.reasoningEffort))
    throw new WorkerApiError(400, "effort_unavailable", "This model does not support the selected reasoning effort.");
}
