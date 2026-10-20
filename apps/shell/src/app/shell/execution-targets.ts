"use client";

import { useEffect, useState } from "react";
import { fetchCore } from "./core-transport.js";
import { watchWorkspaceInventory } from "./events/workspace-inventory-events";
import type { AppExecutionTargets, CoreApp } from "./types";

/** One inventory for the table; workspace metadata changes do not require an app restart. */
export function useExecutionTargets(coreOrigin: string, apps: CoreApp[], enabled: boolean) {
  const key = enabled ? JSON.stringify(apps.map(app => [app.id, app.selectedRuntime, app.sourceLivePath,
    app.sourceOverridePath, app.sourceManagedPath]).sort()) : "[]";
  const [result, setResult] = useState<{ key: string; origin: string; apps: AppExecutionTargets[] } | null>(null);
  useEffect(() => {
    if (key === "[]") return;
    const abort = new AbortController();
    const unsubscribe = watchWorkspaceInventory(coreOrigin, async () => {
      try {
        const response = await fetchCore(`${coreOrigin}/api/apps/execution-targets`, { credentials: "include", signal: abort.signal });
        if (response.status === 401 || response.status === 403) {
          if (!abort.signal.aborted) setResult(null);
          return "forbidden";
        }
        if (!response.ok) return "unavailable";
        const value = await response.json() as { apps: AppExecutionTargets[] };
        if (!abort.signal.aborted && Array.isArray(value.apps)) {
          setResult({ key, origin: coreOrigin, apps: value.apps });
          return "authorized";
        }
      } catch { /* A disconnected stream resynchronizes the retained inventory. */ }
      return "unavailable";
    });
    return () => { abort.abort(); unsubscribe(); };
  }, [coreOrigin, key]);
  return result?.key === key && result.origin === coreOrigin ? result.apps : [];
}
