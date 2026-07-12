import { NextResponse } from "next/server";
import { authorizeTelemetryRequest, telemetryAuthorizationError } from "@/lib/route-auth";
import { backendErrorResponse, backendGet, backendPassthroughError } from "@/lib/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-app metric series over the resolved range. Metrics are keyed by appId and need no display-name
// enrichment (the page labels each section from the roster it already holds), so this is a straight
// admin-gated pass-through to the backend query API.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTelemetryRequest(request.headers);
  if (!auth.ok) {
    return telemetryAuthorizationError(auth);
  }
  const { id } = await params;
  const range = new URL(request.url).searchParams.get("range");
  const query = range ? `?range=${encodeURIComponent(range)}` : "";
  try {
    const response = await backendGet(`/api/apps/${encodeURIComponent(id)}/metrics${query}`);
    if (!response.ok) {
      return backendPassthroughError(response);
    }
    const body = await response.text();
    return new NextResponse(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return backendErrorResponse(error);
  }
}
