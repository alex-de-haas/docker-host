import type { TelemetryApp } from "@/lib/types";

// Hosty Core is a telemetry source but not an installed app: it is the host kernel, so it never appears
// in Core's app-directory roster and no runtime, collector, or manifest describes it. Its records reach
// the store under this reserved id, which the store, the query routes, and the MCP tool schemas all
// accept as an ordinary opaque key — so carrying Core needed no schema column and no change to any
// request or response shape.
//
// It did need a few deliberate behaviour changes, all of them small and local: the fleet responses
// exclude this id from the *app* count they report (Core is not an app), Core's MCP `tail_app_logs`
// answers that it is the host kernel rather than reporting a missing app, and the UI names it and adds
// it to the resource filters below.
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
