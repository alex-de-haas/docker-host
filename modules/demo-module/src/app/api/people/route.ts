import { NextResponse } from "next/server";
import { getModuleDirectorySnapshot } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const directory = await getModuleDirectorySnapshot();

  return NextResponse.json({
    people: directory.users,
    directory,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
