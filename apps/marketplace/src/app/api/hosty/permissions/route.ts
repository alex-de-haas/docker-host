import { readAppIdentityToken, resolveAppSession } from "@hosty-sdk/app/server";
import { readOwnPermissionNotice } from "@hosty-sdk/app/permissions/server";
import { hostyAppConfig as config } from "@/lib/host-auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await resolveAppSession(readAppIdentityToken(request.headers, config), config);
  const role = session.status === "active" ? session.identity.hostRole : null;
  try {
    return Response.json(await readOwnPermissionNotice(role, { appId: process.env.HOSTY_APP_ID ?? config.appIdFallback }, request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ message: "Permission state is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
