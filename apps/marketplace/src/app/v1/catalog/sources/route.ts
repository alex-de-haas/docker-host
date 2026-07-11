import { NextResponse } from "next/server";
import { errorResponse, handleCatalogRequest } from "@/lib/api";
import type { CatalogSourceUpsertRequest } from "@/lib/catalog-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleCatalogRequest(request, async ({ sources }) => NextResponse.json(await sources.list()));
}

export async function POST(request: Request) {
  return handleCatalogRequest(request, async ({ sources }) => {
    let body: CatalogSourceUpsertRequest;
    try {
      body = (await request.json()) as CatalogSourceUpsertRequest;
    } catch {
      return errorResponse("catalog_source_invalid", "Request body must be JSON with a url field.", 400);
    }

    return NextResponse.json(await sources.add(body?.url ?? null));
  });
}

export async function DELETE(request: Request) {
  return handleCatalogRequest(request, async ({ sources }) => {
    const url = new URL(request.url).searchParams.get("url");
    return NextResponse.json(await sources.remove(url));
  });
}
