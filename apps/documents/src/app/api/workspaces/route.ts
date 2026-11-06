import { errorResponse, requireAdministrator } from "@/lib/auth";
import { CoreSourceReader } from "@/lib/core-client";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const credential = await requireAdministrator(request.headers);
    const repository = new URL(request.url).searchParams.get("repository") ?? undefined;
    return Response.json({ workspaces: await new CoreSourceReader(credential, request.signal).workspaces(repository) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
