import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
import { hostyAppConfig } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createHostyUiRouteHandler(hostyAppConfig, { administratorOnly: true });
export const GET = handler;
export const POST = handler;
