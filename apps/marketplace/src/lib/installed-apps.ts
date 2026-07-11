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

// Core resolves the feed manifest (and, for docker apps, remote image digests) to decide this, so it
// can take longer than the installed-apps list; give it more room but still bound it.
const updateStatusTimeoutMs = 6_000;

export type AppUpdateStatusResult = { installed: boolean; updateAvailable: boolean };

// Asks Core whether an already-installed catalog app has an update available (installed manifest vs
// the feed's latest). Any failure degrades to "no update" so the details dialog never blocks.
export async function fetchUpdateStatusFromCore(targetAppId: string): Promise<AppUpdateStatusResult> {
  const appId = process.env.HOSTY_APP_ID?.trim() || "hosty.marketplace";
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  const endpoint = buildCoreEndpoint(
    `/api/internal/apps/${encodeURIComponent(appId)}/installed-apps/${encodeURIComponent(targetAppId)}/update-status`,
  );
  if (!serviceToken || !endpoint) {
    return { installed: false, updateAvailable: false };
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(updateStatusTimeoutMs),
    });
    if (!response.ok) {
      return { installed: false, updateAvailable: false };
    }
    return extractUpdateStatus(await response.json().catch(() => null));
  } catch {
    return { installed: false, updateAvailable: false };
  }
}

export function extractUpdateStatus(payload: unknown): AppUpdateStatusResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { installed: false, updateAvailable: false };
  }
  const record = payload as { installed?: unknown; updateAvailable?: unknown };
  return {
    installed: record.installed === true,
    updateAvailable: record.updateAvailable === true,
  };
}
