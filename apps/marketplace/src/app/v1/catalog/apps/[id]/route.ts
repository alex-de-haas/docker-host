import { NextResponse } from "next/server";
import { errorResponse, handleCatalogRequest } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleCatalogRequest(request, async ({ catalog }) => {
    const detail = await catalog.getApp(id);
    return detail === null
      ? errorResponse("catalog_app_not_found", `Catalog app '${id}' was not found in any configured source.`, 404)
      : NextResponse.json(detail);
  });
}
