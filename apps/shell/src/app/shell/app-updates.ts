import type { InstallationClient, InstallationRequest } from "@hosty-sdk/app/install";
import { requestCoreApproval } from "./app-removal";

/** Routine updates use the same Core-owned consent as changes requesting new grants. */
export function requestAppUpdate(client: InstallationClient, appId: string, planDigest: string,
  onSubmitted: (request: InstallationRequest) => void): Promise<InstallationRequest> {
  return requestCoreApproval(client, { updateAppId: appId, planDigest }, onSubmitted, { retryInterruptedStatus: true });
}

/** Each review finishes before reusing its popup; the Shell restart cannot interrupt earlier reviews. */
export async function reviewUpdatesInOrder<T extends { id: string }>(apps: readonly T[], shellAppId: string,
  review: (app: T) => Promise<boolean>): Promise<void> {
  const ordered = [...apps.filter(app => app.id !== shellAppId), ...apps.filter(app => app.id === shellAppId)];
  for (const app of ordered) await review(app);
}
