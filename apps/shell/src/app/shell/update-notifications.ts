"use client";

import { useEffect, useRef } from "react";
import { toast } from "@/components/reui/operation-toast";
import { appReadinessProblem } from "./app-problems";
import type { CoreApp } from "./types";

// Both reviewed and queued updates finish through the same app-state stream. A successful
// installation request alone does not say that the replacement app passed readiness checks.
export function useAppUpdateNotifications(apps: readonly CoreApp[], openLogs: (app: CoreApp) => void) {
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    const next = new Map<string, string>();
    for (const app of apps) {
      const progress = app.updateProgress;
      const identity = `${app.operationStatus}:${progress?.changedAt}:${progress?.stage}`;
      next.set(app.id, identity);
      // Loading an existing result is not a newly finished operation. Persistent row diagnostics
      // still explain old warnings after reloading Shell, without replaying their toasts.
      if (!previous.current.has(app.id) || previous.current.get(app.id) === identity ||
          app.lastOperation !== "update" || app.operationStatus === "updating" || !progress) continue;
      const id = `${app.id}:update`;
      const problem = appReadinessProblem(app);
      const action = app.capabilities.includes("logs")
        ? { label: "Open logs", onClick: () => openLogs(app) } : undefined;
      if (progress.stage === "needs-attention" && problem) {
        toast.warning(`${app.displayName}: update needs attention`, { id,
          description: problem.detail, action, duration: 12_000 });
      } else if (progress.stage === "failed" || progress.stage === "interrupted") {
        toast.error(`${app.displayName}: update ${progress.stage}`, { id, appId: app.id,
          description: app.lastError ?? "The update did not finish. Open console logs to investigate." });
      } else if (progress.stage === "completed") {
        toast.success("App updated", { id, description: app.displayName });
      }
    }
    previous.current = next;
  }, [apps, openLogs]);
}
