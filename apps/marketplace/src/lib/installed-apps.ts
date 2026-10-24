import { buildCoreEndpoint, hostyAppConfig, type HeaderReader } from "@/lib/host-auth";
import { readAppIdentityToken, getCorePublicOrigin } from "@hosty-sdk/app/server";
import type { InstalledApp, InstalledAppsResult } from "./installed-types";

const requestTimeoutMs = 6_000;
export class InstalledAppsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/** Reuse Core's app/user management authorization. Never forward a Core cookie or expose its
 * complete summary (settings, mounts, source paths) to the storefront. */
export async function fetchInstalledAppIdsFromCore(headers: HeaderReader): Promise<InstalledAppsResult> {
  const token = readAppIdentityToken(headers, hostyAppConfig);
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  const endpoint = buildCoreEndpoint("/api/apps");
  if (!token) throw new InstalledAppsError("Sign in through Hosty to view installed apps.", 401, "app_identity_required");
  if (!serviceToken || !endpoint) throw new InstalledAppsError("Core integration is not configured.", 503, "core_unavailable");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${serviceToken}`, "X-Hosty-App-Identity": token },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch { throw new InstalledAppsError("Installed apps could not be loaded. Core is unavailable.", 503, "core_unavailable"); }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new InstalledAppsError(error?.message || "Installed apps could not be loaded.", response.status, error?.code || "installed_apps_unavailable");
  }
  const payload = await response.json().catch(() => null);
  if (!payload || !Array.isArray(payload.apps)) throw new InstalledAppsError("Core returned an invalid installed-app list.", 502, "installed_apps_invalid");
  const summaries = payload.apps as CoreApp[];
  const shell = summaries.find(app => app.id === "hosty.shell");
  const apps = summaries.map(app => projectInstalledApp(app, shell));
  return { appIds: apps.map(app => app.id), apps };
}

type CoreApp = { id: string; displayName?: string; version?: string; source?: string; followedFeedId?: string;
  feedsUrl?: string; selectedRuntime?: string; runtimeState?: string; entryPath?: string; entryEndpoint?: string;
  endpoints?: { key: string; public: boolean; protocol: string; browserOrigin?: string }[];
  runtimeProfiles?: { key: string; type: string }[];
  installationId?: string; updateCheck?: { updateAvailable?: boolean; targetVersion?: string; error?: string } };
function openUrl(app: CoreApp | undefined, route?: string): string | null {
  if (!app?.installationId || !app.entryEndpoint || !(route ?? app.entryPath)) return null;
  const origin = getCorePublicOrigin();
  if (!origin) return null;
  const url = new URL(`/api/apps/${encodeURIComponent(app.id)}/open`, origin);
  url.search = new URLSearchParams({ installationId: app.installationId, endpoint: app.entryEndpoint, route: route ?? app.entryPath! }).toString();
  return url.href;
}
function shellUrl(shell: CoreApp | undefined, route: string): string | null {
  if (shell?.id !== "hosty.shell" || shell.runtimeState !== "running") return null;
  const endpoints = shell.endpoints?.filter(endpoint => endpoint.public && ["http", "https"].includes(endpoint.protocol)) ?? [];
  const origin = (endpoints.find(endpoint => endpoint.key === "web") ?? endpoints[0])?.browserOrigin;
  if (!origin) return null;
  try { const url = new URL(origin); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? new URL(route, url.origin).href : null; }
  catch { return null; }
}
export function projectInstalledApp(app: CoreApp, shell?: CoreApp): InstalledApp {
  // Catalog membership is not provenance. Name only Core's recorded install source/feed.
  let source = "Source unavailable";
  if (app.feedsUrl) {
    try { source = `Feed · ${new URL(app.feedsUrl).hostname}${app.followedFeedId ? ` · ${app.followedFeedId}` : ""}`; } catch { source = "Configured feed"; }
  } else if (app.source) {
    try { const url = new URL(app.source); source = ["http:", "https:"].includes(url.protocol) ? `Direct install · ${url.hostname}` : "Local install"; }
    catch { source = "Local install"; }
  }
  const profileType = app.runtimeProfiles?.find(profile => profile.key === app.selectedRuntime)?.type;
  return { id: app.id, name: app.displayName || app.id, version: app.version || null, source,
    runtime: profileType === "localCommand" ? "local" : profileType === "docker" ? "docker" : null,
    state: app.runtimeState || "unknown", openUrl: app.id === "hosty.shell" ? shellUrl(app, "/dashboard") : openUrl(app),
    manageUrl: shellUrl(shell, `/settings?${new URLSearchParams({ tab: `manage:${app.id}`, section: "app" })}`),
    update: app.updateCheck ? { state: app.updateCheck.error ? "failed" : app.updateCheck.updateAvailable ? "available" : "current", availableVersion: app.updateCheck.targetVersion || null, message: app.updateCheck.error || null } : null };
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
