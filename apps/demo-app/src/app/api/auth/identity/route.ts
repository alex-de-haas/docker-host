import { NextResponse } from "next/server";
import { getDemoConfig } from "@/lib/demo-config";
import { getDemoAuthSnapshot } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const snapshot = await getDemoAuthSnapshot(request.headers);
  // Recovery parameters ride in this force-dynamic response — not in a server-component prop —
  // so they are read from the environment of the machine that runs the app, never baked into a
  // route prerendered at image build time.
  const { appId, corePublicOrigin } = getDemoConfig().host;

  return NextResponse.json({ ...snapshot, recovery: { appId, corePublicOrigin } }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
