import { errorResponse, PlansError, requireAdministrator } from "@/lib/auth";
import { CoreSourceReader } from "@/lib/core-client";
import { PlansService } from "@/lib/service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const credential = await requireAdministrator(request.headers);
    const query = new URL(request.url).searchParams;
    const repository = query.get("repository"), path = query.get("path");
    if (!repository || !path) throw new PlansError("Repository and document path are required.", 400, "invalid_document");
    return Response.json(await new PlansService(new CoreSourceReader(credential, request.signal)).detail(repository, path, query.get("refresh") === "true"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
