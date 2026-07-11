import { NextResponse } from "next/server";
import { fetchInstalledAppIdsFromCore } from "@/lib/installed-apps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const result = await fetchInstalledAppIdsFromCore();
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
