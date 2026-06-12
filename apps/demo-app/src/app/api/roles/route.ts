import { NextResponse } from "next/server";
import { getDemoRoleManagementSnapshot } from "@/lib/app-role-management";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const snapshot = await getDemoRoleManagementSnapshot(request.headers);
  if (snapshot.current.role === "anonymous") {
    return roleError("app_identity_required", "Sign in through the host to read app role assignments.", 401);
  }

  if (!snapshot.current.permissions.includes("demo.roles.read")) {
    return roleError("app_role_forbidden", "Current app role cannot read app role assignments.", 403);
  }

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function roleError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
