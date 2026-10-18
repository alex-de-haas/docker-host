const passed = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const failed = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);
const pending = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

export function checkResult(state: string): { kind: "passed" | "failed" | "pending" | "unknown"; completed: boolean; label: string } {
  const normalized = state.toUpperCase();
  const kind = passed.has(normalized) ? "passed" : failed.has(normalized) ? "failed" : pending.has(normalized) ? "pending" : "unknown";
  const label = normalized ? normalized[0] + normalized.slice(1).toLowerCase().replaceAll("_", " ") : "Unknown";
  return { kind, completed: kind === "passed" || kind === "failed", label };
}
