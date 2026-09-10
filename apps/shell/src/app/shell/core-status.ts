import type { CoreStatus } from "./types";

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
