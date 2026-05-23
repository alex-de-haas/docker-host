import { getDemoAuthSnapshot, type HeaderReader, type ModuleDirectoryUser } from "@/lib/host-auth";
import {
  getDemoModuleRoleCatalog,
  readDemoModuleRoleAssignments,
  resolveDemoDirectoryUserRole,
  roleSourceLabel,
  type DemoDirectoryUserRoleSnapshot,
  type DemoModuleRoleAssignment,
  type DemoModuleRoleDefinition,
  type DemoModulePermissionSnapshot,
} from "@/lib/module-roles";

export interface DemoRoleManagementUser extends ModuleDirectoryUser {
  moduleRole: DemoDirectoryUserRoleSnapshot;
}

export interface DemoRoleManagementSnapshot {
  generatedAt: string;
  canManage: boolean;
  current: DemoModulePermissionSnapshot;
  roles: DemoModuleRoleDefinition[];
  assignments: DemoModuleRoleAssignment[];
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
    readDemoModuleRoleAssignments(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    canManage: auth.modulePermissions.canManageRoles,
    current: auth.modulePermissions,
    roles: getDemoModuleRoleCatalog(),
    assignments,
    users: auth.directory.users.map(user => ({
      ...user,
      moduleRole: resolveDemoDirectoryUserRole(user, assignments),
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
