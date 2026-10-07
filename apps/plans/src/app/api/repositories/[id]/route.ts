import { errorResponse, requireAdministrator } from "@/lib/auth";
import { CoreSourceReader } from "@/lib/core-client";
import { PlansService } from "@/lib/service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const credential = await requireAdministrator(request.headers);
    const { id } = await params;
    const result = await new PlansService(new CoreSourceReader(credential, request.signal)).repository(id, new URL(request.url).searchParams.get("refresh") === "true");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
