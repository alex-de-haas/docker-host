import { NextResponse } from "next/server";
import { fetchInstalledAppIdsFromCore, InstalledAppsError } from "@/lib/installed-apps";
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

  try {
    const result = await fetchInstalledAppIdsFromCore(request.headers);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ code: error instanceof InstalledAppsError ? error.code : "installed_apps_unavailable", message: error instanceof Error ? error.message : "Installed apps could not be loaded." }, {
      status: error instanceof InstalledAppsError ? error.status : 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
