import { NextResponse } from "next/server";
import { getDemoConfig, inspectStorage, moduleStartedAt } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const config = getDemoConfig();
  const storage = await inspectStorage({ writeProbe: true });
  const requiredStorageReady = storage
    .filter(item => item.key === "data" || item.key === "logs")
    .every(item => item.exists && item.error === null);

  return NextResponse.json(
    {
      status: requiredStorageReady ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      startedAt: moduleStartedAt,
      uptimeSeconds: Math.round(process.uptime()),
      module: {
        id: config.moduleId,
        version: config.moduleVersion,
        releaseChannel: config.releaseChannel,
      },
      checks: {
        requiredStorageReady,
        storage,
      },
    },
    { status: requiredStorageReady ? 200 : 503 }
  );
}
