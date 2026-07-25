import { NextResponse } from "next/server";
import { fetchInstalledAppIdsFromCore } from "@/lib/installed-apps";
import { authorizeMarketplaceRequest, marketplaceAuthorizationError } from "@/lib/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  // The installed-app roster is host state, not catalog data: gate it like the catalog routes so it
  // never leaves the Marketplace origin without an administrator session.
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) {
    return marketplaceAuthorizationError(authorization);
  }

  const result = await fetchInstalledAppIdsFromCore();
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
