import type { InstallationClient, InstallationRequest } from "@hosty-sdk/app/install";
import { requestCoreApproval } from "./app-removal";

/** Changes requiring review use Core-owned consent; routine updates use the queued endpoint. */
export function requestAppUpdate(client: InstallationClient, appId: string, planDigest: string,
  onSubmitted: (request: InstallationRequest) => void): Promise<InstallationRequest> {
  return requestCoreApproval(client, { updateAppId: appId, planDigest }, onSubmitted, { retryInterruptedStatus: true });
}

/** Queue ordinary apps before Shell so its restart cannot interrupt their submissions. */
export async function reviewUpdatesInOrder<T extends { id: string }>(apps: readonly T[], shellAppId: string,
  review: (app: T) => Promise<boolean>): Promise<void> {
  const ordered = [...apps.filter(app => app.id !== shellAppId), ...apps.filter(app => app.id === shellAppId)];
  for (const app of ordered) await review(app);
}

/** Core validates the cached plan and current grants; never retry an uncertain mutation. */
export function enqueueRoutineUpdate(
  request: (url: string, body: unknown) => Promise<Response>, coreOrigin: string, appId: string, planDigest: string,
): Promise<Response> {
  return request(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/update`, { planDigest });
}
