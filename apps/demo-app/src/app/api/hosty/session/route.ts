import { createHostySessionRouteHandler } from "@hosty-sdk/app/server";
import { appIdentityCookieName } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = createHostySessionRouteHandler({ appIdFallback: "com.haas.demo-app", identityCookieName: appIdentityCookieName });
