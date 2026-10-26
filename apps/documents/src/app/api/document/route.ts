import { errorResponse, DocumentsError, requireAdministrator } from "@/lib/auth";
import { CoreSourceReader } from "@/lib/core-client";
import { DocumentsService } from "@/lib/service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const credential = await requireAdministrator(request.headers);
    const query = new URL(request.url).searchParams;
    const repository = query.get("repository"), path = query.get("path");
    if (!repository || !path) throw new DocumentsError("Repository and document path are required.", 400, "invalid_document");
    return Response.json(await new DocumentsService(new CoreSourceReader(credential, request.signal)).detail(repository, path, query.get("refresh") === "true", query.get("workspace") ?? undefined, true), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
