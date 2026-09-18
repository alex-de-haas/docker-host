import { createInstallationRouteHandler } from "@hosty-sdk/app/install/server";
import { hostyAppConfig } from "@/lib/host-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createInstallationRouteHandler(hostyAppConfig, {
  publicOrigin: process.env.HOSTY_PUBLIC_ORIGIN_HTTP,
});
export const POST = GET;
