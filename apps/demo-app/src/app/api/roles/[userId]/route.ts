import { NextResponse } from "next/server";
import { getDemoRoleManagementSnapshot } from "@/lib/app-role-management";
import {
  deleteDemoAppRoleAssignment,
  isDemoAppRole,
  isDemoAppRoleError,
  setDemoAppRoleAssignment,
} from "@/lib/app-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const snapshot = await getDemoRoleManagementSnapshot(request.headers);
    if (!snapshot.canManage) {
      return roleError("app_role_forbidden", "Current app role cannot manage roles.", 403);
    }

    const { userId } = await params;
    if (!snapshot.users.some(user => user.id === userId)) {
      return roleError("app_user_not_found", "User is not in this app directory.", 404);
    }

    const input = await readJson(request);
    const role = isRecord(input) ? input.role : null;
    if (!isDemoAppRole(role)) {
      return roleError("invalid_app_role", "Role must be viewer, operator, or admin.", 400);
    }

    const assignment = await setDemoAppRoleAssignment({
      userId,
      role,
      updatedBy: snapshot.current.principal,
    });
    const nextSnapshot = await getDemoRoleManagementSnapshot(request.headers);

    return NextResponse.json({ assignment, snapshot: nextSnapshot });
  } catch (error) {
    return roleExceptionResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const snapshot = await getDemoRoleManagementSnapshot(request.headers);
    if (!snapshot.canManage) {
      return roleError("app_role_forbidden", "Current app role cannot manage roles.", 403);
    }

    const { userId } = await params;
    if (!snapshot.users.some(user => user.id === userId)) {
      return roleError("app_user_not_found", "User is not in this app directory.", 404);
    }

    const removedUserId = await deleteDemoAppRoleAssignment(userId);
    const nextSnapshot = await getDemoRoleManagementSnapshot(request.headers);

    return NextResponse.json({ removedUserId, snapshot: nextSnapshot });
  } catch (error) {
    return roleExceptionResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function roleExceptionResponse(error: unknown) {
  if (isDemoAppRoleError(error)) {
    return roleError(error.code, error.message, error.status);
  }

  console.error("Error updating demo app role:", error);
  return roleError(
    "app_role_update_failed",
    error instanceof Error ? error.message : "Unknown app role update error.",
    500
  );
}

function roleError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
