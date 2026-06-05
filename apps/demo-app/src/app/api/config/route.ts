import { NextResponse } from "next/server";
import { getDemoConfig, inspectStorage, appStartedAt } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const config = getDemoConfig();
  const storage = await inspectStorage();

  return NextResponse.json({
    app: {
      id: config.appId,
      version: config.appVersion,
      startedAt: appStartedAt,
    },
    settings: {
      greeting: config.greeting,
      releaseChannel: config.releaseChannel,
      refreshSeconds: config.refreshSeconds,
      authPreview: config.authPreview,
      publicUrl: config.publicUrl,
    },
    hostIntegration: {
      coreOrigin: config.host.coreOrigin,
      appId: config.host.appId,
      appServiceTokenConfigured: config.host.appServiceTokenConfigured,
    },
    storage,
  });
}
