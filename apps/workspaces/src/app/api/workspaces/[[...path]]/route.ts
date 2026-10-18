import { requireAdministrator, errorResponse, WorkspacesError } from "@/lib/auth";
import { coreRead } from "@/lib/core-client";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const token = await requireAdministrator(request.headers);
    const parts = (await context.params).path ?? [];
    if (parts.length !== 0 && !(parts.length >= 3 && parts.length <= 4 && /^[a-f0-9]{64}$/.test(parts[0])
      && parts[1] === "worktrees" && /^[a-f0-9]{64}$/.test(parts[2]) && (parts.length === 3 || parts[3] === "diff")))
      throw new WorkspacesError("Unknown workspace read.", 404, "not_found");
    const input = new URL(request.url).searchParams;
    const query = new URLSearchParams();
    for (const key of ["path", "view"]) if (input.has(key)) query.set(key, input.get(key)!);
    const value = await coreRead(parts.length ? "/" + parts.join("/") : "", token, request.signal, query);
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
