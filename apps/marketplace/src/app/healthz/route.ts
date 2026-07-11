import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Open (unauthenticated) health probe — the one route Core and container health checks may hit
// without the app service token.
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
