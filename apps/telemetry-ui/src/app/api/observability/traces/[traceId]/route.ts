import { NextResponse } from "next/server";
import { authorizeTelemetryRequest, telemetryAuthorizationError } from "@/lib/route-auth";
import { backendErrorResponse, backendGet, backendPassthroughError } from "@/lib/backend";
import { buildNameLookup, enrichTraceDetail } from "@/lib/enrich";
import { fetchAppRoster } from "@/lib/roster";
import type { BackendTraceDetailResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One trace's spans merged across apps. Injects each span's app display name from the Core roster.
export async function GET(request: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const auth = await authorizeTelemetryRequest(request.headers);
  if (!auth.ok) {
    return telemetryAuthorizationError(auth);
  }
  const { traceId } = await params;
  // Start the roster fetch concurrently with the backend read — they're independent, so awaiting the
  // roster only when enriching avoids serializing two round-trips. fetchAppRoster never rejects (it
  // degrades to []), so leaving it pending is safe if the backend call throws first.
  const rosterPromise = fetchAppRoster();
  try {
    const response = await backendGet(`/api/observability/traces/${encodeURIComponent(traceId)}`);
    if (!response.ok) {
      return backendPassthroughError(response);
    }
    const payload = (await response.json()) as BackendTraceDetailResponse;
    const names = buildNameLookup(await rosterPromise);
    return NextResponse.json(enrichTraceDetail(payload, names), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return backendErrorResponse(error);
  }
}
