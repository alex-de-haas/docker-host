import { NextResponse } from "next/server";
import { fetchUpdateStatusFromCore } from "@/lib/installed-apps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await fetchUpdateStatusFromCore(id);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
