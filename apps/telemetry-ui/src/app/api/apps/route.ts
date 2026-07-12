import { NextResponse } from "next/server";
import { authorizeTelemetryRequest, telemetryAuthorizationError } from "@/lib/route-auth";
import { fetchAppRoster } from "@/lib/roster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The fleet roster (id → displayName) the pages use for the resource picker and to label merged
// logs/traces. Sourced from Core with the app service token; admin-gated like every data route.
export async function GET(request: Request) {
  const auth = await authorizeTelemetryRequest(request.headers);
  if (!auth.ok) {
    return telemetryAuthorizationError(auth);
  }
  const apps = await fetchAppRoster();
  return NextResponse.json({ apps }, { headers: { "Cache-Control": "no-store" } });
}
