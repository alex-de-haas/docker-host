import type { AppUpdateAvailability, CoreApp, CoreUpdateStatus } from "./types";

const stages: Record<string, string> = {
  queued: "Update queued", preparing: "Preparing update",
  "backing-up": "Creating backup", installing: "Installing", downloading: "Downloading",
  checking: "Checking readiness",
};

export function updateFeedback(app: Pick<CoreApp, "operationStatus" | "lastOperation" | "updateProgress">) {
  if (app.operationStatus !== "updating") return null;
  const progress = app.updateProgress;
  if (!progress) return "Updating";
  if (app.lastOperation !== "update" || ["completed", "needs-attention", "failed", "interrupted"].includes(progress.stage)) return null;
  // Runtime lifecycle transitions belong in the primary status. The update remains active
  // through stop/start, but this secondary line describes only the update operation.
  if (progress.stage === "stopping" || progress.stage === "starting") return "Updating";
  const label = stages[progress.stage] ?? "Updating";
  return progress.service ? `${label} · ${progress.service}` : label;
}

export function updateCheckDescription(verdict: Pick<AppUpdateAvailability, "checkedAt" | "lastSuccessfulCheckAt" | "error" | "updateAvailable"> | null | undefined) {
  if (!verdict) return "Updates have not been checked yet.";
  const successfulAt = verdict.lastSuccessfulCheckAt ?? (!verdict.error ? verdict.checkedAt : null);
  const lastSuccess = successfulAt ? `Last successful check: ${new Date(successfulAt).toLocaleString()}.` : "No successful check yet.";
  return verdict.error
    ? `Update check failed: ${verdict.error} ${lastSuccess}${verdict.updateAvailable ? " Showing the previously found update." : ""}`
    : `${verdict.updateAvailable ? "Update available." : "No updates found."} ${lastSuccess}`;
}

export function isRoutineUpdate(app: Pick<CoreApp, "operationStatus" | "updateCheck">) {
  const check = app.updateCheck;
  return check?.updateAvailable === true && !check.error && !check.requiresReview &&
    Boolean(check.planDigest) && app.operationStatus !== "updating";
}

/** Terminal observations take precedence over a still-pending request flag. */
export function coreUpdateFeedback(updating: boolean, phase: CoreUpdateStatus["clientPhase"]): { label: string; tone: "working" | "attention" | "success" } | null {
  if (phase === "completed") return { label: "Updated", tone: "success" };
  if (phase === "unconfirmed") return { label: "Update not confirmed", tone: "attention" };
  if (!updating && !phase) return null;
  return { label: phase === "reconnecting" ? "Reconnecting" : phase === "verifying" ? "Verifying update" : "Installing update", tone: "working" };
}

/** These labels come from the local Core stop/restart hooks, not provider error text. */
export function coreOperationNeedsAttention(phase: string | null) {
  return phase === "Waiting for confirmation" || phase === "Stop not confirmed" || phase === "Restart not confirmed — check Core logs";
}
