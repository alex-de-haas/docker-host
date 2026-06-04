import { NextResponse } from "next/server";
import { getAppDirectorySnapshot } from "@/lib/host-auth";
import {
  readDemoAppRoleAssignments,
  resolveDemoDirectoryUserRole,
} from "@/lib/app-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [directory, assignments] = await Promise.all([
    getAppDirectorySnapshot(),
    readDemoAppRoleAssignments(),
  ]);

  return NextResponse.json({
    people: directory.users.map(user => ({
      ...user,
      appRole: resolveDemoDirectoryUserRole(user, assignments),
    })),
    directory,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
