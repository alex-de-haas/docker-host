import type { CoreStatus, CoreUpdateStatus } from "./types";

/** A restart can interrupt this read; retain the last status and retry on the next stream sync. */
export async function readCoreStatus(coreOrigin: string, signal?: AbortSignal): Promise<CoreStatus | null> {
  try {
    const response = await fetch(`${coreOrigin}/api/core/status`, {
      credentials: "include",
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    const status = (await response.json()) as CoreStatus;
    return signal?.aborted ? null : status;
  } catch {
    return null;
  }
}

/** Reconcile at the read boundary so either response order cannot expose an offer for an old binary. */
export function reconcileCoreUpdate(update: CoreUpdateStatus | null, installedVersion?: string): CoreUpdateStatus | null {
  if (!update || !installedVersion || update.currentVersion === installedVersion) return update;
  return {
    ...update,
    currentVersion: installedVersion,
    updateAvailable: false,
    availableVersion: null,
    lastSuccessfulCheckAt: null,
  };
}
