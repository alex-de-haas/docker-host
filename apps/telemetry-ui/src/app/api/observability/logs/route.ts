import { NextResponse } from "next/server";
import { authorizeTelemetryRequest, telemetryAuthorizationError } from "@/lib/route-auth";
import { backendErrorResponse, backendGet, backendPassthroughError } from "@/lib/backend";
import { buildNameLookup, enrichLogs } from "@/lib/enrich";
import { fetchAppRoster } from "@/lib/roster";
import type { BackendFleetLogsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cross-resource OTLP logs merged across apps. Forwards the page's filters (range/severity/limit/apps/q)
// to the backend and injects each record's display name from the Core roster.
export async function GET(request: Request) {
  const auth = await authorizeTelemetryRequest(request.headers);
  if (!auth.ok) {
    return telemetryAuthorizationError(auth);
  }
  const search = new URL(request.url).search;
  try {
    const response = await backendGet(`/api/observability/logs${search}`);
    if (!response.ok) {
      return backendPassthroughError(response);
    }
    const payload = (await response.json()) as BackendFleetLogsResponse;
    const names = buildNameLookup(await fetchAppRoster());
    return NextResponse.json(enrichLogs(payload, names), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return backendErrorResponse(error);
  }
}
