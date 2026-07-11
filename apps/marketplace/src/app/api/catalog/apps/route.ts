import { NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime";
import { authorizeMarketplaceRequest, marketplaceAuthorizationError } from "@/lib/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) {
    return marketplaceAuthorizationError(authorization);
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const response = await getRuntime().catalog.getApps({ refresh });

  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
