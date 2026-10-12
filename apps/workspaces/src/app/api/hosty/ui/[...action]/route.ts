import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
import { config } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createHostyUiRouteHandler(config, { administratorOnly: true });
export const GET = handler;
export const POST = handler;
