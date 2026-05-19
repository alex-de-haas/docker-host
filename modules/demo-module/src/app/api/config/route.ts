import { NextResponse } from "next/server";
import { getDemoConfig, inspectStorage, moduleStartedAt } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const config = getDemoConfig();
  const storage = await inspectStorage();

  return NextResponse.json({
    module: {
      id: config.moduleId,
      version: config.moduleVersion,
      startedAt: moduleStartedAt,
    },
    settings: {
      greeting: config.greeting,
      releaseChannel: config.releaseChannel,
      refreshSeconds: config.refreshSeconds,
      authPreview: config.authPreview,
      publicUrl: config.publicUrl,
    },
    storage,
  });
}
