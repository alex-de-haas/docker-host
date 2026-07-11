import { NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime";
import { authorizeMarketplaceRequest, marketplaceAuthorizationError } from "@/lib/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authorization = await authorizeMarketplaceRequest(request.headers);
  if (!authorization.ok) {
    return marketplaceAuthorizationError(authorization);
  }

  const { id } = await context.params;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const response = await getRuntime().catalog.getApp(id, { refresh });
  if (!response) {
    return NextResponse.json(
      { code: "catalog_app_not_found", message: `Catalog app '${id}' was not found.` },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
