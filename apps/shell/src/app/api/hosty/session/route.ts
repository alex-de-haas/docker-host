import { createHostySessionRouteHandler } from "@hosty-sdk/app/server";
import { appCookie } from "@/app/shell/app-auth-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = createHostySessionRouteHandler({ appIdFallback: "hosty.shell", identityCookieName: appCookie });
