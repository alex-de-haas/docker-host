import { getDemoConfig } from "@/lib/demo-config";
import {
  readDemoAppRoleAssignments,
  resolveDemoAppPermissions,
  type DemoAppPermissionSnapshot,
} from "@/lib/app-roles";

const identityHeaderName = "x-docker-host-identity";
const hostSessionCookieName = "docker_host_session";
const directoryTimeoutMs = 1_500;
const identityTimeoutMs = 1_500;

export const appIdentityCookieName = "hosty_demo_app_identity";

export type HeaderReader = {
  get(name: string): string | null;
};

export interface DemoAuthSnapshot {
  generatedAt: string;
  appSession: AppSessionSnapshot;
  gateway: GatewayRequestSnapshot;
  directory: AppDirectorySnapshot;
  appPermissions: DemoAppPermissionSnapshot;
}

export interface GatewayRequestSnapshot {
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  forwardedForPresent: boolean;
  hostSessionCookieForwarded: boolean;
  dockerHostHeaders: string[];
}

export type AppSessionStatus = "not-present" | "active" | "expired" | "forbidden" | "unavailable" | "error";

export type AppIdentityTokenSource = "cookie" | "authorization-header" | "identity-header";

export interface AppSessionSnapshot {
  status: AppSessionStatus;
  tokenPresent: boolean;
  tokenSource: AppIdentityTokenSource | null;
  coreOrigin: string;
  appId: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  hostRole: string | null;
  expiresAt: string | null;
  error: {
    status: number | null;
    code: string;
    message: string;
  } | null;
}

export type AppDirectoryStatus = "not-configured" | "ok" | "unavailable" | "forbidden" | "error";

export interface AppDirectorySnapshot {
  status: AppDirectoryStatus;
  endpoint: string | null;
  coreOrigin: string;
  serviceTokenConfigured: boolean;
  users: AppDirectoryUser[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  } | null;
  updatedAt: string | null;
  error: {
    status: number | null;
    code: string;
    message: string;
  } | null;
}

export interface AppDirectoryUser {
  id: string;
  displayName: string | null;
  email: string | null;
  hostRole: string;
}

export async function getDemoAuthSnapshot(headersList: HeaderReader): Promise<DemoAuthSnapshot> {
  const [appSession, roleAssignments] = await Promise.all([
    getAppSessionSnapshot(headersList),
    readDemoAppRoleAssignments(),
  ]);
  const appPermissions = resolveDemoAppPermissions(appSession, roleAssignments);
  const directory = appPermissions.permissions.includes("demo.people.read")
    ? await getAppDirectorySnapshot()
    : forbiddenDirectorySnapshot();

  return {
    generatedAt: new Date().toISOString(),
    appSession,
    gateway: getGatewayRequestSnapshot(headersList),
    directory,
    appPermissions,
  };
}

function forbiddenDirectorySnapshot(): AppDirectorySnapshot {
  const config = getDemoConfig();
  return {
    status: "forbidden",
    endpoint: null,
    coreOrigin: config.host.coreOrigin,
    serviceTokenConfigured: config.host.appServiceTokenConfigured,
    users: [],
    pagination: null,
    updatedAt: null,
    error: {
      status: 403,
      code: "app_directory_forbidden",
      message: "Sign in through the host with an app role that includes demo.people.read to view the app directory.",
    },
  };
}

async function getAppSessionSnapshot(headersList: HeaderReader): Promise<AppSessionSnapshot> {
  const config = getDemoConfig();
  const tokenInput = readAppIdentityToken(headersList);
  const baseSnapshot = {
    tokenPresent: Boolean(tokenInput.token),
    tokenSource: tokenInput.source,
    coreOrigin: config.host.coreOrigin,
    appId: config.host.appId,
  };

  if (!tokenInput.token) {
    return {
      ...baseSnapshot,
      status: "not-present",
      userId: null,
      email: null,
      displayName: null,
      hostRole: null,
      expiresAt: null,
      error: null,
    };
  }

  const endpoint = buildCoreEndpoint(config.host.coreOrigin, "/api/auth/apps/revalidate");
  if (!endpoint) {
    return {
      ...baseSnapshot,
      status: "error",
      userId: null,
      email: null,
      displayName: null,
      hostRole: null,
      expiresAt: null,
      error: {
        status: null,
        code: "core_origin_invalid",
        message: "HOSTY_CORE_ORIGIN is not a valid URL.",
      },
    };
  }

  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN;
  if (!serviceToken) {
    return {
      ...baseSnapshot,
      status: "error",
      userId: null,
      email: null,
      displayName: null,
      hostRole: null,
      expiresAt: null,
      error: {
        status: null,
        code: "app_service_token_missing",
        message: "HOSTY_APP_SERVICE_TOKEN is not configured. Core requires it to revalidate app identity tokens.",
      },
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ accessToken: tokenInput.token }),
      cache: "no-store",
      signal: AbortSignal.timeout(identityTimeoutMs),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ...baseSnapshot,
        // 401 is recoverable (token missing/expired/invalid/revoked) → the client re-authorizes;
        // 403 is terminal (disabled/unassigned/admin-only) → access denied, no auto-redirect.
        status: response.status === 401 ? "expired" : response.status === 403 ? "forbidden" : "error",
        userId: null,
        email: null,
        displayName: null,
        hostRole: null,
        expiresAt: null,
        error: {
          status: response.status,
          code: readErrorCode(body) || "app_session_revalidation_failed",
          message: readErrorMessage(body) || `Core revalidation returned HTTP ${response.status}.`,
        },
      };
    }

    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (readString(record.appId) !== config.host.appId) {
      return {
        ...baseSnapshot,
        status: "forbidden",
        userId: null,
        email: null,
        displayName: null,
        hostRole: null,
        expiresAt: null,
        error: {
          status: null,
          code: "app_identity_app_mismatch",
          message: "Identity token was issued for a different app.",
        },
      };
    }

    return {
      ...baseSnapshot,
      status: readBooleanField(record.active) ? "active" : "expired",
      userId: readString(record.userId),
      email: readString(record.email),
      displayName: readString(record.displayName),
      hostRole: readString(record.hostRole),
      expiresAt: readString(record.expiresAt),
      error: null,
    };
  } catch (error) {
    return {
      ...baseSnapshot,
      status: isAbortError(error) ? "unavailable" : "error",
      userId: null,
      email: null,
      displayName: null,
      hostRole: null,
      expiresAt: null,
      error: {
        status: null,
        code: isAbortError(error) ? "core_revalidation_timeout" : "app_session_revalidation_error",
        message: sanitizeError(error),
      },
    };
  }
}

export async function getAppDirectorySnapshot(): Promise<AppDirectorySnapshot> {
  const config = getDemoConfig();
  const endpoint = buildAppDirectoryEndpoint(config.host.coreOrigin, config.host.appId);
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN;

  if (!endpoint || !serviceToken) {
    return {
      status: "not-configured",
      endpoint,
      coreOrigin: config.host.coreOrigin,
      serviceTokenConfigured: Boolean(serviceToken),
      users: [],
      pagination: null,
      updatedAt: null,
      error: {
        status: null,
        code: "app_directory_not_configured",
        message: endpoint
          ? "HOSTY_APP_SERVICE_TOKEN is not configured."
          : "HOSTY_CORE_ORIGIN is not a valid URL.",
      },
    };
  }

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(directoryTimeoutMs),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      const error = readApiError(payload, response.status);
      return {
        status: response.status === 403 ? "forbidden" : "error",
        endpoint,
        coreOrigin: config.host.coreOrigin,
        serviceTokenConfigured: true,
        users: [],
        pagination: null,
        updatedAt: null,
        error,
      };
    }

    return {
      status: "ok",
      endpoint,
      coreOrigin: config.host.coreOrigin,
      serviceTokenConfigured: true,
      users: normalizeDirectoryUsers(payload),
      pagination: normalizePagination(payload),
      updatedAt: readString((payload as Record<string, unknown>).updatedAt),
      error: null,
    };
  } catch (error) {
    return {
      status: "unavailable",
      endpoint,
      coreOrigin: config.host.coreOrigin,
      serviceTokenConfigured: true,
      users: [],
      pagination: null,
      updatedAt: null,
      error: {
        status: null,
        code: "app_directory_unavailable",
        message: sanitizeError(error),
      },
    };
  }
}

function getGatewayRequestSnapshot(headersList: HeaderReader): GatewayRequestSnapshot {
  const cookie = headersList.get("cookie");
  const headerNames = getHeaderNames(headersList);

  return {
    host: headersList.get("host"),
    forwardedHost: headersList.get("x-forwarded-host"),
    forwardedProto: headersList.get("x-forwarded-proto"),
    forwardedForPresent: Boolean(headersList.get("x-forwarded-for")),
    hostSessionCookieForwarded: Boolean(cookie?.includes(`${hostSessionCookieName}=`)),
    dockerHostHeaders: headerNames
      .filter(name => name.toLowerCase().startsWith("x-docker-host-"))
      .sort(),
  };
}

function readAppIdentityToken(headersList: HeaderReader): {
  token: string | null;
  source: AppIdentityTokenSource | null;
} {
  const cookieToken = readCookie(headersList.get("cookie"), appIdentityCookieName);
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" };
  }

  const authorization = headersList.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return { token: authorization.slice("Bearer ".length).trim(), source: "authorization-header" };
  }

  const identityHeader = headersList.get(identityHeaderName);
  if (identityHeader) {
    return { token: identityHeader, source: "identity-header" };
  }

  return { token: null, source: null };
}

function buildAppDirectoryEndpoint(coreOrigin: string, appId: string) {
  try {
    return new URL(`/api/internal/apps/${encodeURIComponent(appId)}/directory/users`, coreOrigin).toString();
  } catch {
    return null;
  }
}

function buildCoreEndpoint(coreOrigin: string, path: string) {
  try {
    return new URL(path, coreOrigin).toString();
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function readApiError(payload: unknown, status: number): AppDirectorySnapshot["error"] {
  if (!payload || typeof payload !== "object") {
    return {
      status,
      code: "app_directory_error",
      message: `App directory returned HTTP ${status}.`,
    };
  }

  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return {
      status,
      code: "app_directory_error",
      message: `App directory returned HTTP ${status}.`,
    };
  }

  const errorRecord = error as Record<string, unknown>;
  return {
    status,
    code: readString(errorRecord.code) || "app_directory_error",
    message: readString(errorRecord.message) || `App directory returned HTTP ${status}.`,
  };
}

function normalizeDirectoryUsers(payload: unknown): AppDirectoryUser[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const users = (payload as Record<string, unknown>).users;
  if (!Array.isArray(users)) {
    return [];
  }

  return users
    .map(user => {
      if (!user || typeof user !== "object") {
        return null;
      }

      const record = user as Record<string, unknown>;
      const id = readString(record.id);
      const hostRole = readString(record.hostRole);
      if (!id || !hostRole) {
        return null;
      }

      return {
        id,
        displayName: readString(record.displayName),
        email: readString(record.email),
        hostRole,
      };
    })
    .filter((user): user is AppDirectoryUser => user !== null);
}

function normalizePagination(payload: unknown): AppDirectorySnapshot["pagination"] {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const pagination = (payload as Record<string, unknown>).pagination;
  if (!pagination || typeof pagination !== "object") {
    return null;
  }

  const record = pagination as Record<string, unknown>;
  return {
    limit: readNumber(record.limit, 0),
    offset: readNumber(record.offset, 0),
    total: readNumber(record.total, 0),
  };
}

function getHeaderNames(headersList: HeaderReader) {
  const withForEach = headersList as HeaderReader & {
    forEach?: (callback: (value: string, key: string) => void) => void;
  };
  const names: string[] = [];

  if (typeof withForEach.forEach === "function") {
    withForEach.forEach((_value, key) => names.push(key));
  }

  return [...new Set(names.map(name => name.toLowerCase()))];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBooleanField(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }

  const cookie = cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function readErrorCode(payload: unknown) {
  return readErrorField(payload, "code");
}

function readErrorMessage(payload: unknown) {
  return readErrorField(payload, "message");
}

function readErrorField(payload: unknown, field: "code" | "message") {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as Record<string, unknown>).error;
  if (error && typeof error === "object") {
    return readString((error as Record<string, unknown>)[field]);
  }

  return readString((payload as Record<string, unknown>)[field]);
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
