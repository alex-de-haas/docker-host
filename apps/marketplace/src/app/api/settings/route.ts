import { NextResponse } from "next/server";
import { getRuntime, MarketplaceSettingsConflictError, updateMarketplaceSettings } from "@/lib/runtime";
import { authorizeMarketplaceRequest, marketplaceAuthorizationError } from "@/lib/route-auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) return marketplaceAuthorizationError(authorization);
  return NextResponse.json(getRuntime().options, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  // A same-origin JSON request cannot be submitted by an unrelated website without CORS approval.
  if (request.headers.get("sec-fetch-site") === "cross-site" || !request.headers.get("content-type")?.startsWith("application/json"))
    return NextResponse.json({ message: "A same-origin JSON request is required." }, { status: 403 });
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) return marketplaceAuthorizationError(authorization);
  try {
    const input = await request.json();
    if (typeof input.sourceUrl !== "string" || typeof input.expectedSourceUrl !== "string") throw new Error("Catalog address is required.");
    return NextResponse.json(updateMarketplaceSettings(input.sourceUrl, input.expectedSourceUrl));
  } catch (error) {
    if (error instanceof MarketplaceSettingsConflictError)
      return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not save settings." }, { status: 400 });
  }
}
