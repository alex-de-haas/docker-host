import { createHostySessionRouteHandler } from "@hosty-sdk/app/server";
import { authConfig } from "@/lib/auth";
export const dynamic = "force-dynamic";
export const GET = createHostySessionRouteHandler(authConfig);
