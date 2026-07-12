import { buildCoreEndpoint } from "@/lib/host-auth";
import type { TelemetryApp } from "@/lib/types";

const rosterTimeoutMs = 2_000;

// The telemetry backend keys everything by hosty.app.id; display names are Core's domain, not the
// backend's. The UI asks Core — with its own app service token — for the id→displayName roster so the
// merged logs/traces views and the resource picker can label resources. Any failure degrades to an
// empty roster: the pages still render (labels fall back to the raw id).
export async function fetchAppRoster(): Promise<TelemetryApp[]> {
  const appId = process.env.HOSTY_APP_ID?.trim() || "hosty.telemetry";
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  const endpoint = buildCoreEndpoint(`/api/internal/apps/${encodeURIComponent(appId)}/app-directory`);
  if (!serviceToken || !endpoint) {
    return [];
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(rosterTimeoutMs),
    });
    if (!response.ok) {
      return [];
    }
    return extractRoster(await response.json().catch(() => null));
  } catch {
    return [];
  }
}

export function extractRoster(payload: unknown): TelemetryApp[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const apps = (payload as { apps?: unknown }).apps;
  if (!Array.isArray(apps)) {
    return [];
  }
  return apps
    .map((entry): TelemetryApp | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const id = (entry as { id?: unknown }).id;
      const displayName = (entry as { displayName?: unknown }).displayName;
      if (typeof id !== "string" || id.length === 0) {
        return null;
      }
      return {
        id,
        displayName: typeof displayName === "string" && displayName.length > 0 ? displayName : id,
      };
    })
    .filter((app): app is TelemetryApp => app !== null);
}
