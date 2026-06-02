import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDemoConfig } from "@/lib/demo-config";

export type DemoModuleRole = "viewer" | "operator" | "admin";
export type DemoModuleResolvedRole = "anonymous" | DemoModuleRole;
export type DemoModuleRoleSource =
  | "anonymous"
  | "stored"
  | "host-admin-bootstrap"
  | "host-assignment"
  | "host-authenticated";

export interface DemoModuleRoleDefinition {
  role: DemoModuleRole;
  label: string;
  description: string;
  permissions: string[];
}

export interface DemoModuleRoleAssignment {
  userId: string;
  role: DemoModuleRole;
  updatedAt: string;
  updatedBy: string;
}

export interface DemoModuleRoleStore {
  schemaVersion: "0.1";
  assignments: DemoModuleRoleAssignment[];
  updatedAt: string;
}

export interface DemoRoleIdentityInput {
  status: string;
  claims: {
    subject: string;
    hostRole: string | null;
    moduleAccess: string | null;
  } | null;
}

export interface DemoModulePermissionSnapshot {
  principal: string;
  role: DemoModuleResolvedRole;
  roleLabel: string;
  source: DemoModuleRoleSource;
  assignment: DemoModuleRoleAssignment | null;
  permissions: string[];
  canManageRoles: boolean;
}

export interface DemoDirectoryUserRoleSnapshot {
  userId: string;
  role: DemoModuleRole;
  roleLabel: string;
  source: Exclude<DemoModuleRoleSource, "anonymous" | "host-authenticated">;
  assignment: DemoModuleRoleAssignment | null;
  permissions: string[];
}

const roleStoreFileName = "module-roles.json";

const roleDefinitions: Record<DemoModuleRole, DemoModuleRoleDefinition> = {
  viewer: {
    role: "viewer",
    label: "Viewer",
    description: "Can read demo health, config, people, and role assignments.",
    permissions: [
      "demo.health.read",
      "demo.config.read",
      "demo.people.read",
      "demo.roles.read",
    ],
  },
  operator: {
    role: "operator",
    label: "Operator",
    description: "Can inspect Host directory data and settings previews.",
    permissions: [
      "demo.health.read",
      "demo.config.read",
      "demo.people.read",
      "demo.directory.read",
      "demo.roles.read",
      "demo.settings.preview",
    ],
  },
  admin: {
    role: "admin",
    label: "Admin",
    description: "Can manage module-owned demo roles.",
    permissions: [
      "demo.health.read",
      "demo.config.read",
      "demo.people.read",
      "demo.directory.read",
      "demo.roles.read",
      "demo.roles.manage",
      "demo.settings.preview",
    ],
  },
};

const anonymousPermissions = ["demo.health.read", "demo.config.read"];

export function getDemoModuleRoleCatalog() {
  return [roleDefinitions.viewer, roleDefinitions.operator, roleDefinitions.admin];
}

export function isDemoModuleRole(value: unknown): value is DemoModuleRole {
  return value === "viewer" || value === "operator" || value === "admin";
}

export async function readDemoModuleRoleStore(): Promise<DemoModuleRoleStore> {
  const filePath = getRoleStorePath();

  try {
    const content = await readFile(filePath, "utf8");
    return normalizeRoleStore(JSON.parse(content));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyRoleStore();
    }

    throw error;
  }
}

export async function readDemoModuleRoleAssignments() {
  return (await readDemoModuleRoleStore()).assignments;
}

export async function setDemoModuleRoleAssignment(input: {
  userId: string;
  role: DemoModuleRole;
  updatedBy: string;
}) {
  const userId = input.userId.trim();
  if (!userId) {
    throw new DemoModuleRoleError("invalid_user", "User id is required.", 400);
  }

  const now = new Date().toISOString();
  const assignment: DemoModuleRoleAssignment = {
    userId,
    role: input.role,
    updatedAt: now,
    updatedBy: input.updatedBy,
  };

  const store = await readDemoModuleRoleStore();
  const nextStore: DemoModuleRoleStore = {
    schemaVersion: "0.1",
    assignments: [
      ...store.assignments.filter(candidate => candidate.userId !== userId),
      assignment,
    ].sort(compareAssignments),
    updatedAt: now,
  };

  await writeDemoModuleRoleStore(nextStore);
  return assignment;
}

export async function deleteDemoModuleRoleAssignment(userId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new DemoModuleRoleError("invalid_user", "User id is required.", 400);
  }

  const store = await readDemoModuleRoleStore();
  const nextAssignments = store.assignments.filter(
    assignment => assignment.userId !== normalizedUserId
  );

  if (nextAssignments.length === store.assignments.length) {
    return null;
  }

  const nextStore: DemoModuleRoleStore = {
    schemaVersion: "0.1",
    assignments: nextAssignments,
    updatedAt: new Date().toISOString(),
  };

  await writeDemoModuleRoleStore(nextStore);
  return normalizedUserId;
}

export function resolveDemoModulePermissions(
  identity: DemoRoleIdentityInput,
  assignments: DemoModuleRoleAssignment[]
): DemoModulePermissionSnapshot {
  if (identity.status !== "verified" || !identity.claims) {
    return {
      principal: "anonymous",
      role: "anonymous",
      roleLabel: "Anonymous",
      source: "anonymous",
      assignment: null,
      permissions: anonymousPermissions,
      canManageRoles: false,
    };
  }

  const assignment = findRoleAssignment(assignments, identity.claims.subject);
  const role = assignment?.role ?? getDefaultRoleForIdentity(identity.claims);
  const permissions = roleDefinitions[role].permissions;

  return {
    principal: identity.claims.subject,
    role,
    roleLabel: roleDefinitions[role].label,
    source: assignment ? "stored" : getDefaultRoleSourceForIdentity(identity.claims),
    assignment,
    permissions,
    canManageRoles:
      permissions.includes("demo.roles.manage") ||
      identity.claims.hostRole === "host.admin" ||
      identity.claims.moduleAccess === "hostAdmin",
  };
}

export function resolveDemoDirectoryUserRole(
  user: { id: string; hostRole: string },
  assignments: DemoModuleRoleAssignment[]
): DemoDirectoryUserRoleSnapshot {
  const assignment = findRoleAssignment(assignments, user.id);
  const role = assignment?.role ?? (user.hostRole === "host.admin" ? "admin" : "operator");

  return {
    userId: user.id,
    role,
    roleLabel: roleDefinitions[role].label,
    source: assignment ? "stored" : user.hostRole === "host.admin" ? "host-admin-bootstrap" : "host-assignment",
    assignment,
    permissions: roleDefinitions[role].permissions,
  };
}

export function getDemoRoleLabel(role: DemoModuleResolvedRole) {
  return role === "anonymous" ? "Anonymous" : roleDefinitions[role].label;
}

export function getDemoRolePermissions(role: DemoModuleResolvedRole) {
  return role === "anonymous" ? anonymousPermissions : roleDefinitions[role].permissions;
}

export function roleSourceLabel(source: DemoModuleRoleSource) {
  switch (source) {
    case "stored":
      return "Module store";
    case "host-admin-bootstrap":
      return "Host admin bootstrap";
    case "host-assignment":
      return "Host assignment default";
    case "host-authenticated":
      return "Host login default";
    case "anonymous":
      return "Anonymous request";
  }
}

export function isDemoModuleRoleError(error: unknown): error is DemoModuleRoleError {
  return error instanceof DemoModuleRoleError;
}

export class DemoModuleRoleError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DemoModuleRoleError";
    this.code = code;
    this.status = status;
  }
}

async function writeDemoModuleRoleStore(store: DemoModuleRoleStore) {
  const filePath = getRoleStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function getRoleStorePath() {
  return path.join(getDemoConfig().paths.data, roleStoreFileName);
}

function emptyRoleStore(): DemoModuleRoleStore {
  return {
    schemaVersion: "0.1",
    assignments: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeRoleStore(value: unknown): DemoModuleRoleStore {
  if (!isRecord(value)) {
    throw new DemoModuleRoleError("invalid_role_store", "Module role store must be an object.", 500);
  }

  const assignments = Array.isArray(value.assignments)
    ? value.assignments
        .map(normalizeRoleAssignment)
        .filter((assignment): assignment is DemoModuleRoleAssignment => Boolean(assignment))
    : [];

  return {
    schemaVersion: "0.1",
    assignments: assignments.sort(compareAssignments),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeRoleAssignment(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  if (!userId || !isDemoModuleRole(value.role)) {
    return null;
  }

  return {
    userId,
    role: value.role,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : "unknown",
  } satisfies DemoModuleRoleAssignment;
}

function getDefaultRoleForIdentity(claims: NonNullable<DemoRoleIdentityInput["claims"]>): DemoModuleRole {
  if (claims.hostRole === "host.admin" || claims.moduleAccess === "hostAdmin") {
    return "admin";
  }

  if (claims.moduleAccess === "assigned") {
    return "operator";
  }

  return "viewer";
}

function getDefaultRoleSourceForIdentity(
  claims: NonNullable<DemoRoleIdentityInput["claims"]>
): DemoModuleRoleSource {
  if (claims.hostRole === "host.admin" || claims.moduleAccess === "hostAdmin") {
    return "host-admin-bootstrap";
  }

  if (claims.moduleAccess === "assigned") {
    return "host-assignment";
  }

  return "host-authenticated";
}

function findRoleAssignment(assignments: DemoModuleRoleAssignment[], userId: string) {
  return assignments.find(assignment => assignment.userId === userId) ?? null;
}

function compareAssignments(left: DemoModuleRoleAssignment, right: DemoModuleRoleAssignment) {
  return left.userId.localeCompare(right.userId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
