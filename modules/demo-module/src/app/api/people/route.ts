import { NextResponse } from "next/server";
import { getModuleDirectorySnapshot } from "@/lib/host-auth";
import {
  readDemoModuleRoleAssignments,
  resolveDemoDirectoryUserRole,
} from "@/lib/module-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [directory, assignments] = await Promise.all([
    getModuleDirectorySnapshot(),
    readDemoModuleRoleAssignments(),
  ]);

  return NextResponse.json({
    people: directory.users.map(user => ({
      ...user,
      moduleRole: resolveDemoDirectoryUserRole(user, assignments),
    })),
    directory,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
