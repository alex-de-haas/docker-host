import { getAppAuthProtocol, readAppIdentityToken, resolveAppSession } from "@hosty-sdk/app/server";
import { readOwnPermissionNotice } from "@hosty-sdk/app/permissions/server";
import { getCoreOrigin } from "@/app/shell/server-env";
import { appCookie } from "@/app/shell/app-auth-server";
const config = { appIdFallback: "hosty.shell", identityCookieName: appCookie };
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await resolveAppSession(readAppIdentityToken(request.headers, config), config);
  const role = session.status === "active" ? session.identity.hostRole : null;
  try {
    const appId = process.env.HOSTY_APP_ID ?? config.appIdFallback;
    const appAuthProtocol = await getAppAuthProtocol();
    return Response.json({ ...await readOwnPermissionNotice(role, { appId: process.env.HOSTY_APP_ID ?? config.appIdFallback }, request.signal),
      appAuthProtocol, recovery: { appId, corePublicOrigin: getCoreOrigin(), appAuthProtocol },
      activeUntil: session.status === "active" ? session.identity.activeUntil : null,
      activityRequired: session.status === "active" ? session.identity.activityRequired : false },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ message: "Permission state is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
