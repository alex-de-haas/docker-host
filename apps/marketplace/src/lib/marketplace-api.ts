import type {
  CatalogAppDetailResponse,
  CatalogAppsResponse,
  ErrorResponse,
} from "@/lib/catalog-types";
import type { MarketplaceIdentity } from "@/lib/host-auth";

export async function fetchCatalogApps(refresh: boolean, signal?: AbortSignal): Promise<CatalogAppsResponse> {
  return fetchJson<CatalogAppsResponse>(`/api/catalog/apps${refresh ? "?refresh=1" : ""}`, signal);
}

export async function fetchCatalogApp(
  appId: string,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<CatalogAppDetailResponse> {
  const suffix = refresh ? "?refresh=1" : "";
  return fetchJson<CatalogAppDetailResponse>(`/api/catalog/apps/${encodeURIComponent(appId)}${suffix}`, signal);
}

export async function fetchIdentity(signal?: AbortSignal): Promise<MarketplaceIdentity> {
  return fetchJson<MarketplaceIdentity>("/api/auth/identity", signal);
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ErrorResponse | null;
    throw new Error(body?.message || `Marketplace request returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}
