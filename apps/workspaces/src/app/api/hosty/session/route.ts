import { createHostySessionRouteHandler } from "@hosty-sdk/app/server";
import { config } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = createHostySessionRouteHandler(config, { administratorOnly: true });
