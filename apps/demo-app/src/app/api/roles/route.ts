import { NextResponse } from "next/server";
import { getDemoRoleManagementSnapshot } from "@/lib/app-role-management";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const snapshot = await getDemoRoleManagementSnapshot(request.headers);

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
