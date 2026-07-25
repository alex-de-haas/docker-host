import { NextResponse } from "next/server";
import { fetchUpdateStatusFromCore } from "@/lib/installed-apps";
import { authorizeMarketplaceRequest, marketplaceAuthorizationError } from "@/lib/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) {
    return marketplaceAuthorizationError(authorization);
  }

  const { id } = await params;
  const result = await fetchUpdateStatusFromCore(id);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
