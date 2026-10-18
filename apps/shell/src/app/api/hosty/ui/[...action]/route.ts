import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
import { appCookie } from "@/app/shell/app-auth-server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createHostyUiRouteHandler({ appIdFallback: "hosty.shell", identityCookieName: appCookie });
export const GET = handler;
export const POST = handler;
