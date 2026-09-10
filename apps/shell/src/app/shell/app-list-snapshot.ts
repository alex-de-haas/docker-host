import type { AppsResponse, CoreApp, AppUpdateCheckStatus } from "./types";

export type AppListSnapshot = {
  apps: CoreApp[];
  updateCheck?: AppUpdateCheckStatus | null;
  appsReadId?: number;
};

/** Full-page and event refreshes share a read sequence; response arrival order is not freshness. */
export function reconcileAppList(
  current: AppListSnapshot,
  incoming: AppsResponse,
  readId: number,
): AppListSnapshot {
  if (readId < (current.appsReadId ?? 0)) {
    return { apps: current.apps, updateCheck: current.updateCheck, appsReadId: current.appsReadId };
  }
  return { apps: incoming.apps ?? [], updateCheck: incoming.updateCheck ?? null, appsReadId: readId };
}
