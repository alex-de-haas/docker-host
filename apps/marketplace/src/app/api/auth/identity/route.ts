import { NextResponse } from "next/server";
import { getMarketplaceIdentity } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const identity = await getMarketplaceIdentity(request.headers);
  return NextResponse.json(identity, {
    headers: { "Cache-Control": "no-store" },
  });
}
