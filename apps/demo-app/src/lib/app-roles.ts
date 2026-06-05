import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDemoConfig } from "@/lib/demo-config";

export type DemoAppRole = "viewer" | "operator" | "admin";
export type DemoAppResolvedRole = "anonymous" | DemoAppRole;
export type DemoAppRoleSource =
  | "anonymous"
  | "stored"
  | "host-admin-bootstrap"
  | "host-assignment"
  | "host-authenticated";

export interface DemoAppRoleDefinition {
  role: DemoAppRole;
  label: string;
  description: string;
  permissions: string[];
}

export interface DemoAppRoleAssignment {
  userId: string;
  role: DemoAppRole;
  updatedAt: string;
  updatedBy: string;
}

export interface DemoAppRoleStore {
  schemaVersion: "0.1";
  assignments: DemoAppRoleAssignment[];
  updatedAt: string;
}

export interface DemoRoleIdentityInput {
  status: string;
  userId: string | null;
  hostRole: string | null;
}

export interface DemoAppPermissionSnapshot {
  principal: string;
  role: DemoAppResolvedRole;
  roleLabel: string;
  source: DemoAppRoleSource;
  assignment: DemoAppRoleAssignment | null;
  permissions: string[];
  canManageRoles: boolean;
}

export interface DemoDirectoryUserRoleSnapshot {
  userId: string;
  role: DemoAppRole;
  roleLabel: string;
  source: Exclude<DemoAppRoleSource, "anonymous" | "host-authenticated">;
  assignment: DemoAppRoleAssignment | null;
  permissions: string[];
}

const roleStoreFileName = "app-roles.json";

const roleDefinitions: Record<DemoAppRole, DemoAppRoleDefinition> = {
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
    description: "Can manage app-owned demo roles.",
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

export function getDemoAppRoleCatalog() {
  return [roleDefinitions.viewer, roleDefinitions.operator, roleDefinitions.admin];
}

export function isDemoAppRole(value: unknown): value is DemoAppRole {
  return value === "viewer" || value === "operator" || value === "admin";
}

export async function readDemoAppRoleStore(): Promise<DemoAppRoleStore> {
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

export async function readDemoAppRoleAssignments() {
  return (await readDemoAppRoleStore()).assignments;
}

export async function setDemoAppRoleAssignment(input: {
  userId: string;
  role: DemoAppRole;
  updatedBy: string;
}) {
  const userId = input.userId.trim();
  if (!userId) {
    throw new DemoAppRoleError("invalid_user", "User id is required.", 400);
  }

  const now = new Date().toISOString();
  const assignment: DemoAppRoleAssignment = {
    userId,
    role: input.role,
    updatedAt: now,
    updatedBy: input.updatedBy,
  };

  const store = await readDemoAppRoleStore();
  const nextStore: DemoAppRoleStore = {
    schemaVersion: "0.1",
    assignments: [
      ...store.assignments.filter(candidate => candidate.userId !== userId),
      assignment,
    ].sort(compareAssignments),
    updatedAt: now,
  };

  await writeDemoAppRoleStore(nextStore);
  return assignment;
}

export async function deleteDemoAppRoleAssignment(userId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new DemoAppRoleError("invalid_user", "User id is required.", 400);
  }

  const store = await readDemoAppRoleStore();
  const nextAssignments = store.assignments.filter(
    assignment => assignment.userId !== normalizedUserId
  );

  if (nextAssignments.length === store.assignments.length) {
    return null;
  }

  const nextStore: DemoAppRoleStore = {
    schemaVersion: "0.1",
    assignments: nextAssignments,
    updatedAt: new Date().toISOString(),
  };

  await writeDemoAppRoleStore(nextStore);
  return normalizedUserId;
}

export function resolveDemoAppPermissions(
  identity: DemoRoleIdentityInput,
  assignments: DemoAppRoleAssignment[]
): DemoAppPermissionSnapshot {
  if (identity.status !== "active" || !identity.userId) {
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

  const assignment = findRoleAssignment(assignments, identity.userId);
  const role = assignment?.role ?? getDefaultRoleForIdentity(identity);
  const permissions = roleDefinitions[role].permissions;

  return {
    principal: identity.userId,
    role,
    roleLabel: roleDefinitions[role].label,
    source: assignment ? "stored" : getDefaultRoleSourceForIdentity(identity),
    assignment,
    permissions,
    canManageRoles:
      permissions.includes("demo.roles.manage") ||
      identity.hostRole === "host.admin",
  };
}

export function resolveDemoDirectoryUserRole(
  user: { id: string; hostRole: string },
  assignments: DemoAppRoleAssignment[]
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

export function getDemoRoleLabel(role: DemoAppResolvedRole) {
  return role === "anonymous" ? "Anonymous" : roleDefinitions[role].label;
}

export function getDemoRolePermissions(role: DemoAppResolvedRole) {
  return role === "anonymous" ? anonymousPermissions : roleDefinitions[role].permissions;
}

export function roleSourceLabel(source: DemoAppRoleSource) {
  switch (source) {
    case "stored":
      return "App store";
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

export function isDemoAppRoleError(error: unknown): error is DemoAppRoleError {
  return error instanceof DemoAppRoleError;
}

export class DemoAppRoleError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DemoAppRoleError";
    this.code = code;
    this.status = status;
  }
}

async function writeDemoAppRoleStore(store: DemoAppRoleStore) {
  const filePath = getRoleStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function getRoleStorePath() {
  return path.join(getDemoConfig().paths.data, roleStoreFileName);
}

function emptyRoleStore(): DemoAppRoleStore {
  return {
    schemaVersion: "0.1",
    assignments: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeRoleStore(value: unknown): DemoAppRoleStore {
  if (!isRecord(value)) {
    throw new DemoAppRoleError("invalid_role_store", "App role store must be an object.", 500);
  }

  const assignments = Array.isArray(value.assignments)
    ? value.assignments
        .map(normalizeRoleAssignment)
        .filter((assignment): assignment is DemoAppRoleAssignment => Boolean(assignment))
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
  if (!userId || !isDemoAppRole(value.role)) {
    return null;
  }

  return {
    userId,
    role: value.role,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : "unknown",
  } satisfies DemoAppRoleAssignment;
}

function getDefaultRoleForIdentity(identity: DemoRoleIdentityInput): DemoAppRole {
  if (identity.hostRole === "host.admin") {
    return "admin";
  }

  return "viewer";
}

function getDefaultRoleSourceForIdentity(identity: DemoRoleIdentityInput): DemoAppRoleSource {
  if (identity.hostRole === "host.admin") {
    return "host-admin-bootstrap";
  }

  return "host-authenticated";
}

function findRoleAssignment(assignments: DemoAppRoleAssignment[], userId: string) {
  return assignments.find(assignment => assignment.userId === userId) ?? null;
}

function compareAssignments(left: DemoAppRoleAssignment, right: DemoAppRoleAssignment) {
  return left.userId.localeCompare(right.userId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
