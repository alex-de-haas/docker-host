import { readCoreError, redirectToCoreLoginIfAuthRequired } from "./core-api";
import type { CatalogAppDetail, CatalogAppsResponse, CatalogSourcesResponse } from "./types";

type SendCsrfJson = (endpoint: string, body?: unknown, method?: string) => Promise<Response>;

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

// Catalog source management (WS7 federation). Reads mirror the storefront reads; add/remove go through
// sendCsrfJson (Core requires the CSRF header on catalog source mutations). Every mutation returns the
// full updated list so the caller refreshes to consistent state.
export async function getCatalogSources(coreOrigin: string, signal?: AbortSignal): Promise<CatalogSourcesResponse> {
  const response = await fetch(`${coreOrigin}/api/catalog/sources`, { credentials: "include", signal });
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) {
    throw new Error(await readCoreError(response));
  }

  return (await response.json()) as CatalogSourcesResponse;
}

export async function addCatalogSource(
  coreOrigin: string,
  sendCsrfJson: SendCsrfJson,
  url: string,
): Promise<CatalogSourcesResponse> {
  const response = await sendCsrfJson(`${coreOrigin}/api/catalog/sources`, { url });
  return (await response.json()) as CatalogSourcesResponse;
}

export async function removeCatalogSource(
  coreOrigin: string,
  sendCsrfJson: SendCsrfJson,
  url: string,
): Promise<CatalogSourcesResponse> {
  const response = await sendCsrfJson(`${coreOrigin}/api/catalog/sources?url=${encodeURIComponent(url)}`, undefined, "DELETE");
  return (await response.json()) as CatalogSourcesResponse;
}
