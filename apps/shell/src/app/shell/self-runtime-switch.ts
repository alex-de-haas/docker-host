import { fetchCore } from "./core-transport.js";
import type { AppsResponse } from "./types";

export type ShellRuntimeSwitchOutcome =
  | { kind: "settled" }
  | { kind: "failed"; message: string }
  | { kind: "unresolved" };

/** Recover a self-switch without replaying the apply whose proxy connection may have died. */
export async function waitForShellRuntimeSwitch(options: {
  coreOrigin: string;
  shellAppId: string;
  targetRuntime: string;
  timeoutMs?: number;
}): Promise<ShellRuntimeSwitchOutcome> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(5_000, deadline - Date.now()));
    try {
      const response = await fetchCore(`${options.coreOrigin}/api/apps`, {
        cache: "no-store", signal: controller.signal,
      });
      if (response.ok) {
        const app = ((await response.json()) as AppsResponse).apps.find(item => item.id === options.shellAppId);
        if (app?.operationStatus === "runtime-switch-rollback") {
          return { kind: "failed", message: app.lastError || "The target runtime failed to start. Shell is stopped on its previous runtime." };
        }
        // An answering origin can still be the old Shell. Wait for the target's completed start.
        if (app?.selectedRuntime === options.targetRuntime && app.operationStatus === "started" && app.runtimeState === "running") {
          return { kind: "settled" };
        }
      }
    } catch {
      // Stopping Shell also stops its Core proxy. A lost read cannot tell us the apply's outcome.
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1_500, remaining)));
  }
  return { kind: "unresolved" };
}
