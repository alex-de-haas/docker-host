import { readOwnPermissionNotice } from "@hosty-sdk/app/permissions/server";
import { config, errorResponse, requireAdministrator } from "@/lib/auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireAdministrator(request.headers);
    return Response.json(await readOwnPermissionNotice("host.admin", { appId: process.env.HOSTY_APP_ID ?? config.appIdFallback }, request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
