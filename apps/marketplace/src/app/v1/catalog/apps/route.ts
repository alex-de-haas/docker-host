import { NextResponse } from "next/server";
import { handleCatalogRequest } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleCatalogRequest(request, async ({ catalog }) => NextResponse.json(await catalog.getApps()));
}
