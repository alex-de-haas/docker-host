import { NextResponse } from "next/server";
import { getRecoveryParams, getTelemetryIdentity } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const identity = await getTelemetryIdentity(request.headers);
  return NextResponse.json({ ...identity, recovery: getRecoveryParams() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
