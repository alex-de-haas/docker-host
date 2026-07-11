import { NextResponse } from "next/server";
import { MarketplaceError } from "@/lib/errors";
import { getRuntime, type MarketplaceRuntime } from "@/lib/runtime";
import { SERVICE_TOKEN_HEADER, authorizeServiceToken } from "@/lib/service-token";

// Shared route-handler shell: service-token authorization first, then the action, with
// MarketplaceError codes mapped onto the same status conventions Core's catalog endpoints used, so
// the Core compatibility proxy can pass responses through unchanged.
export async function handleCatalogRequest(
  request: Request,
  action: (runtime: MarketplaceRuntime) => Promise<NextResponse>,
): Promise<NextResponse> {
  const runtime = getRuntime();
  const decision = authorizeServiceToken(request.headers.get(SERVICE_TOKEN_HEADER), runtime.options.serviceToken);
  if (!decision.ok) {
    return errorResponse(decision.code, decision.message, decision.status);
  }

  try {
    return await action(runtime);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      const status =
        error.code === "catalog_source_not_found" ? 404 : error.code === "catalog_source_exists" ? 409 : 400;
      return errorResponse(error.code, error.message, status);
    }

    throw error;
  }
}

export function errorResponse(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message }, { status });
}
