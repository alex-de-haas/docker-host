import { NextResponse } from "next/server";
import { getDemoAuthSnapshot } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const snapshot = await getDemoAuthSnapshot(request.headers);

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
