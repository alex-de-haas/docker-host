import type { AppUpdateAvailability, CoreApp } from "./types";

const stages: Record<string, string> = {
  queued: "Update queued", preparing: "Preparing update", stopping: "Stopping",
  "backing-up": "Creating backup", installing: "Installing", downloading: "Downloading",
  starting: "Starting", checking: "Checking readiness", completed: "Updated",
  "needs-attention": "Updated · not ready", failed: "Update failed", interrupted: "Update interrupted",
};

export const UPDATE_SUCCESS_DURATION = 30_000;

export function updateFeedback(app: Pick<CoreApp, "operationStatus" | "lastOperation" | "updateProgress">, now: number) {
  const progress = app.updateProgress;
  if (!progress) return app.operationStatus === "updating" ? "Updating" : null;
  if (app.lastOperation !== "update") return null;
  if (progress.stage === "completed" && now - Date.parse(progress.changedAt) >= UPDATE_SUCCESS_DURATION) return null;
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
