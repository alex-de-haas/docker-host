import { errorResponse, requireAdministrator } from "@/lib/auth";
import { CoreSourceReader } from "@/lib/core-client";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const credential = await requireAdministrator(request.headers);
    return Response.json({ repositories: await new CoreSourceReader(credential, request.signal).repositories() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
