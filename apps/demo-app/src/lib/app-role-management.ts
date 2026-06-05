import { getDemoAuthSnapshot, type AppDirectoryUser, type HeaderReader } from "@/lib/host-auth";
import {
  getDemoAppRoleCatalog,
  readDemoAppRoleAssignments,
  resolveDemoDirectoryUserRole,
  roleSourceLabel,
  type DemoAppPermissionSnapshot,
  type DemoAppRoleAssignment,
  type DemoAppRoleDefinition,
  type DemoDirectoryUserRoleSnapshot,
} from "@/lib/app-roles";

export interface DemoRoleManagementUser extends AppDirectoryUser {
  appRole: DemoDirectoryUserRoleSnapshot;
}

export interface DemoRoleManagementSnapshot {
  generatedAt: string;
  canManage: boolean;
  current: DemoAppPermissionSnapshot;
  roles: DemoAppRoleDefinition[];
  assignments: DemoAppRoleAssignment[];
  users: DemoRoleManagementUser[];
  roleSourceLabels: Record<string, string>;
  directory: {
    status: string;
    error: {
      code: string;
      message: string;
    } | null;
  };
}

export async function getDemoRoleManagementSnapshot(
  headersList: HeaderReader
): Promise<DemoRoleManagementSnapshot> {
  const [auth, assignments] = await Promise.all([
    getDemoAuthSnapshot(headersList),
    readDemoAppRoleAssignments(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    canManage: auth.appPermissions.canManageRoles,
    current: auth.appPermissions,
    roles: getDemoAppRoleCatalog(),
    assignments,
    users: auth.directory.users.map(user => ({
      ...user,
      appRole: resolveDemoDirectoryUserRole(user, assignments),
    })),
    roleSourceLabels: {
      stored: roleSourceLabel("stored"),
      "host-admin-bootstrap": roleSourceLabel("host-admin-bootstrap"),
      "host-assignment": roleSourceLabel("host-assignment"),
      "host-authenticated": roleSourceLabel("host-authenticated"),
      anonymous: roleSourceLabel("anonymous"),
    },
    directory: {
      status: auth.directory.status,
      error: auth.directory.error
        ? {
            code: auth.directory.error.code,
            message: auth.directory.error.message,
          }
        : null,
    },
  };
}
