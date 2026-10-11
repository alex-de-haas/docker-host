import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
import { appIdentityCookieName } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createHostyUiRouteHandler({ appIdFallback: "com.haas.demo-app", identityCookieName: appIdentityCookieName });
export const GET = handler;
export const POST = handler;
