import type { TelemetryApp } from "@/lib/types";

// Hosty Core is a telemetry source but not an installed app: it is the host kernel, so it never appears
// in Core's app-directory roster and no runtime, collector, or manifest describes it. Its records reach
// the store under this reserved id, which every appId-keyed layer below the UI treats as an ordinary
// opaque key — no schema column, no query change, no MCP tool change.
//
// The roster is deliberately NOT where this is fixed. Adding a synthetic entry there would also hand
// Core to the ai-gateway, which reads the same app-directory payload to discover MCP providers and to
// prune what it knows about. So the UI carries the reserved id itself, in these few places.
export const CORE_SOURCE_ID = "hosty.core";
export const CORE_SOURCE_NAME = "Hosty Core";

// The roster plus Core, for the pages whose filters would otherwise be unable to select it: without
// this Core's records show up under "All resources" and can never be isolated.
export function withCoreSource(apps: TelemetryApp[]): TelemetryApp[] {
  return apps.some((app) => app.id === CORE_SOURCE_ID)
    ? apps
    : [...apps, { id: CORE_SOURCE_ID, displayName: CORE_SOURCE_NAME }];
}
