import { buildCoreEndpoint } from "@/lib/host-auth";

// Marketplace holds no Core session, so it asks Core — with its own app service token — which apps
// are already installed. That lets catalog cards show an "Installed" state without depending on the
// Shell (just one possible UI) to push the list in. Any failure degrades to an empty list: the
// catalog still renders, only the install badges are missing.
const requestTimeoutMs = 1_500;

export type InstalledAppsResult = { appIds: string[] };

export async function fetchInstalledAppIdsFromCore(): Promise<InstalledAppsResult> {
  const appId = process.env.HOSTY_APP_ID?.trim() || "hosty.marketplace";
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  const endpoint = buildCoreEndpoint(`/api/internal/apps/${encodeURIComponent(appId)}/installed-apps`);
  if (!serviceToken || !endpoint) {
    return { appIds: [] };
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      return { appIds: [] };
    }
    const payload: unknown = await response.json().catch(() => null);
    return { appIds: extractAppIds(payload) };
  } catch {
    return { appIds: [] };
  }
}

export function extractAppIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const ids = (payload as { appIds?: unknown }).appIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}
