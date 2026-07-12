import { NextResponse } from "next/server";
import { authorizeTelemetryRequest, telemetryAuthorizationError } from "@/lib/route-auth";
import { backendErrorResponse, backendGet, backendPassthroughError } from "@/lib/backend";
import { buildNameLookup, enrichTraces } from "@/lib/enrich";
import { fetchAppRoster } from "@/lib/roster";
import type { BackendTracesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cross-resource trace summaries merged across apps. Forwards the page's filters (range/limit/apps/q) to
// the backend and injects the root + per-trace app display names from the Core roster.
export async function GET(request: Request) {
  const auth = await authorizeTelemetryRequest(request.headers);
  if (!auth.ok) {
    return telemetryAuthorizationError(auth);
  }
  const search = new URL(request.url).search;
  try {
    const response = await backendGet(`/api/observability/traces${search}`);
    if (!response.ok) {
      return backendPassthroughError(response);
    }
    const payload = (await response.json()) as BackendTracesResponse;
    const names = buildNameLookup(await fetchAppRoster());
    return NextResponse.json(enrichTraces(payload, names), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return backendErrorResponse(error);
  }
}
