import { NextResponse } from "next/server";
import { getDemoAuthSnapshot } from "@/lib/host-auth";
import {
  readDemoAppRoleAssignments,
  resolveDemoDirectoryUserRole,
} from "@/lib/app-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await getDemoAuthSnapshot(request.headers);
  if (auth.appPermissions.role === "anonymous") {
    return directoryError("app_identity_required", "Sign in through the host to read the app directory.", 401);
  }

  if (!auth.appPermissions.permissions.includes("demo.people.read")) {
    return directoryError("app_directory_forbidden", "Current app role cannot read the app directory.", 403);
  }

  const assignments = await readDemoAppRoleAssignments();

  return NextResponse.json({
    people: auth.directory.users.map(user => ({
      ...user,
      appRole: resolveDemoDirectoryUserRole(user, assignments),
    })),
    directory: auth.directory,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function directoryError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
