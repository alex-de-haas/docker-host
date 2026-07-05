import { readCoreError, redirectToCoreLoginIfAuthRequired } from "./core-api";
import type { CatalogAppDetail, CatalogAppsResponse } from "./types";

// Marketplace catalog reads (Core GET /api/catalog/*). Direct, credentialed calls like the rest of the
// Shell; a 401 redirects to the Core login. Best-effort on the Core side — an unreachable source yields
// an empty catalog rather than an error.
export async function getCatalogApps(coreOrigin: string, signal?: AbortSignal): Promise<CatalogAppsResponse> {
  const response = await fetch(`${coreOrigin}/api/catalog/apps`, { credentials: "include", signal });
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) {
    throw new Error(await readCoreError(response));
  }

  return (await response.json()) as CatalogAppsResponse;
}

export async function getCatalogApp(coreOrigin: string, appId: string, signal?: AbortSignal): Promise<CatalogAppDetail> {
  const response = await fetch(`${coreOrigin}/api/catalog/apps/${encodeURIComponent(appId)}`, { credentials: "include", signal });
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) {
    throw new Error(await readCoreError(response));
  }

  return (await response.json()) as CatalogAppDetail;
}
