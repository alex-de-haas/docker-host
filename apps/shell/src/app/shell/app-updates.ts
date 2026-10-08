import { InstallationError, type InstallationClient, type InstallationRequest } from "@hosty-sdk/app/install";
import { requestCoreApproval } from "./app-removal";
import { CoreRequestError } from "./core-api";

/** Changes requiring review use Core-owned consent; routine updates use the queued endpoint. */
export function requestAppUpdate(client: InstallationClient, appId: string, planDigest: string,
  onSubmitted: (request: InstallationRequest) => void | (() => void)): Promise<InstallationRequest> {
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

/** Read Core's still-valid snapshot or rebuild once, before any submission. */
export async function prepareAppUpdate<T extends { planDigest: string }>(
  cached: () => Promise<T | null>, rebuild: () => Promise<T>, forceRefresh = false,
): Promise<T> {
  const plan = forceRefresh ? null : await cached();
  return plan ?? await rebuild();
}

/** Retry only a definite refusal during preparation, before submit can be reached. */
export function isStaleUpdatePreparation(error: unknown) {
  return (error instanceof InstallationError || error instanceof CoreRequestError) && error.status === 409 &&
    ["update_plan_expired", "update_plan_stale", "update_plan_digest_mismatch"].includes(error.code ?? "");
}
