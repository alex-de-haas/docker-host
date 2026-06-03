import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { getDemoConfig } from "@/lib/demo-config";
import {
  readDemoModuleRoleAssignments,
  resolveDemoModulePermissions,
  type DemoModulePermissionSnapshot,
} from "@/lib/module-roles";

const identityHeaderName = "x-docker-host-identity";
export const moduleIdentityCookieName = "docker_host_module_identity";
const hostSessionCookieName = "docker_host_session";
const discoveryPath = "/.well-known/docker-host/module-identity.json";
const directoryTimeoutMs = 1_500;
const identityTimeoutMs = 1_500;
const defaultIssuer = "docker-host";

export type HeaderReader = {
  get(name: string): string | null;
};

export interface DemoAuthSnapshot {
  generatedAt: string;
  gateway: GatewayRequestSnapshot;
  identity: ModuleIdentitySnapshot;
  directory: ModuleDirectorySnapshot;
  modulePermissions: DemoModulePermissionSnapshot;
}

export interface GatewayRequestSnapshot {
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  forwardedForPresent: boolean;
  hostSessionCookieForwarded: boolean;
  dockerHostHeaders: string[];
}

export type ModuleIdentityStatus = "not-present" | "verified" | "invalid" | "not-configured";

export interface ModuleIdentitySnapshot {
  status: ModuleIdentityStatus;
  tokenPresent: boolean;
  headerName: string;
  audience: string;
  protectedHeader: {
    alg: string | null;
    kid: string | null;
    typ: string | null;
  } | null;
  discovery: {
    issuer: string;
    jwksUri: string;
    tokenTtlSeconds: number | null;
  } | null;
  claims: NormalizedModuleIdentityClaims | null;
  error: string | null;
}

export interface NormalizedModuleIdentityClaims {
  subject: string;
  issuer: string;
  audience: string;
  expiresAt: string | null;
  issuedAt: string | null;
  jwtId: string | null;
  email: string | null;
  name: string | null;
  hostRole: string | null;
  moduleAccess: string | null;
  moduleExposurePolicy: string | null;
  gatewayExposureId: string | null;
  hostname: string | null;
  portKey: string | null;
}

export type ModuleDirectoryStatus = "not-configured" | "ok" | "unavailable" | "forbidden" | "error";

export interface ModuleDirectorySnapshot {
  status: ModuleDirectoryStatus;
  endpoint: string | null;
  internalOrigin: string;
  serviceTokenConfigured: boolean;
  users: ModuleDirectoryUser[];
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

export interface ModuleDirectoryUser {
  id: string;
  displayName: string | null;
  email: string | null;
  hostRole: string;
}

interface ModuleIdentityDiscovery {
  issuer?: unknown;
  jwks_uri?: unknown;
  token_ttl_seconds?: unknown;
  algorithms?: unknown;
}

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function getDemoAuthSnapshot(headersList: HeaderReader): Promise<DemoAuthSnapshot> {
  const [identity, directory, roleAssignments] = await Promise.all([
    getModuleIdentitySnapshot(headersList),
    getModuleDirectorySnapshot(),
    readDemoModuleRoleAssignments(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    gateway: getGatewayRequestSnapshot(headersList),
    identity,
    directory,
    modulePermissions: resolveDemoModulePermissions(identity, roleAssignments),
  };
}

async function getModuleIdentitySnapshot(headersList: HeaderReader): Promise<ModuleIdentitySnapshot> {
  const config = getDemoConfig();
  const token = headersList.get(identityHeaderName) ?? readCookie(headersList.get("cookie"), moduleIdentityCookieName);
  const baseSnapshot = {
    tokenPresent: Boolean(token),
    headerName: "X-Docker-Host-Identity",
    audience: config.host.moduleId,
  };

  if (!token) {
    return {
      ...baseSnapshot,
      status: "not-present",
      protectedHeader: null,
      discovery: null,
      claims: null,
      error: null,
    };
  }

  const protectedHeader = decodeIdentityHeader(token);
  const discovery = await readModuleIdentityDiscovery(config.host.internalOrigin);
  if (!discovery.ok) {
    return {
      ...baseSnapshot,
      status: "not-configured",
      protectedHeader,
      discovery: null,
      claims: null,
      error: discovery.error,
    };
  }

  try {
    const verified = await jwtVerify(token, getRemoteJwks(discovery.value.jwksUri), {
      issuer: discovery.value.issuer,
      audience: config.host.moduleId,
      algorithms: discovery.value.algorithms,
    });

    return {
      ...baseSnapshot,
      status: "verified",
      protectedHeader,
      discovery: {
        issuer: discovery.value.issuer,
        jwksUri: discovery.value.jwksUri,
        tokenTtlSeconds: discovery.value.tokenTtlSeconds,
      },
      claims: normalizeIdentityClaims(verified.payload),
      error: null,
    };
  } catch (error) {
    return {
      ...baseSnapshot,
      status: "invalid",
      protectedHeader,
      discovery: {
        issuer: discovery.value.issuer,
        jwksUri: discovery.value.jwksUri,
        tokenTtlSeconds: discovery.value.tokenTtlSeconds,
      },
      claims: null,
      error: sanitizeError(error),
    };
  }
}

export async function getModuleDirectorySnapshot(): Promise<ModuleDirectorySnapshot> {
  const config = getDemoConfig();
  const endpoint = buildDirectoryEndpoint(config.host.internalOrigin, config.host.moduleId);
  const serviceToken = process.env.DOCKER_HOST_MODULE_SERVICE_TOKEN;

  if (!endpoint || !serviceToken) {
    return {
      status: "not-configured",
      endpoint,
      internalOrigin: config.host.internalOrigin,
      serviceTokenConfigured: Boolean(serviceToken),
      users: [],
      pagination: null,
      updatedAt: null,
      error: {
        status: null,
        code: "module_directory_not_configured",
        message: endpoint
          ? "DOCKER_HOST_MODULE_SERVICE_TOKEN is not configured."
          : "DOCKER_HOST_INTERNAL_ORIGIN is not a valid URL.",
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
        internalOrigin: config.host.internalOrigin,
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
      internalOrigin: config.host.internalOrigin,
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
      internalOrigin: config.host.internalOrigin,
      serviceTokenConfigured: true,
      users: [],
      pagination: null,
      updatedAt: null,
      error: {
        status: null,
        code: "module_directory_unavailable",
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

async function readModuleIdentityDiscovery(internalOrigin: string) {
  let discoveryUrl: URL;
  try {
    discoveryUrl = new URL(discoveryPath, internalOrigin);
  } catch {
    return {
      ok: false as const,
      error: "DOCKER_HOST_INTERNAL_ORIGIN is not a valid URL.",
    };
  }

  try {
    const response = await fetch(discoveryUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(identityTimeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: `Module identity discovery returned HTTP ${response.status}.`,
      };
    }

    const payload = await readJson(response) as ModuleIdentityDiscovery;
    const jwksUri = typeof payload.jwks_uri === "string" ? payload.jwks_uri : null;
    if (!jwksUri) {
      return {
        ok: false as const,
        error: "Module identity discovery did not include jwks_uri.",
      };
    }

    return {
      ok: true as const,
      value: {
        issuer: typeof payload.issuer === "string" ? payload.issuer : defaultIssuer,
        jwksUri,
        algorithms: normalizeAlgorithms(payload.algorithms),
        tokenTtlSeconds: typeof payload.token_ttl_seconds === "number" ? payload.token_ttl_seconds : null,
      },
    };
  } catch (error) {
    return {
      ok: false as const,
      error: sanitizeError(error),
    };
  }
}

function getRemoteJwks(jwksUri: string) {
  const existing = remoteJwksCache.get(jwksUri);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: identityTimeoutMs,
  });
  remoteJwksCache.set(jwksUri, jwks);
  return jwks;
}

function decodeIdentityHeader(token: string): ModuleIdentitySnapshot["protectedHeader"] {
  try {
    const header = decodeProtectedHeader(token);
    return {
      alg: typeof header.alg === "string" ? header.alg : null,
      kid: typeof header.kid === "string" ? header.kid : null,
      typ: typeof header.typ === "string" ? header.typ : null,
    };
  } catch {
    return null;
  }
}

function normalizeIdentityClaims(payload: JWTPayload): NormalizedModuleIdentityClaims {
  return {
    subject: payload.sub || "",
    issuer: payload.iss || "",
    audience: Array.isArray(payload.aud) ? payload.aud.join(", ") : payload.aud || "",
    expiresAt: secondsToIso(payload.exp),
    issuedAt: secondsToIso(payload.iat),
    jwtId: payload.jti || null,
    email: readString(payload.email),
    name: readString(payload.name),
    hostRole: readString(payload.hostRole),
    moduleAccess: readString(payload.moduleAccess),
    moduleExposurePolicy: readString(payload.moduleExposurePolicy),
    gatewayExposureId: readString(payload.gatewayExposureId),
    hostname: readString(payload.hostname),
    portKey: readString(payload.portKey),
  };
}

function buildDirectoryEndpoint(internalOrigin: string, moduleId: string) {
  try {
    return new URL(`/api/internal/modules/${encodeURIComponent(moduleId)}/directory/users`, internalOrigin).toString();
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

function readApiError(payload: unknown, status: number): ModuleDirectorySnapshot["error"] {
  if (!payload || typeof payload !== "object") {
    return {
      status,
      code: "module_directory_error",
      message: `App directory returned HTTP ${status}.`,
    };
  }

  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return {
      status,
      code: "module_directory_error",
      message: `App directory returned HTTP ${status}.`,
    };
  }

  const errorRecord = error as Record<string, unknown>;
  return {
    status,
    code: readString(errorRecord.code) || "module_directory_error",
    message: readString(errorRecord.message) || `App directory returned HTTP ${status}.`,
  };
}

function normalizeDirectoryUsers(payload: unknown): ModuleDirectoryUser[] {
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
    .filter((user): user is ModuleDirectoryUser => user !== null);
}

function normalizePagination(payload: unknown): ModuleDirectorySnapshot["pagination"] {
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

function normalizeAlgorithms(value: unknown) {
  if (!Array.isArray(value)) {
    return ["ES256"];
  }

  const algorithms = value.filter((algorithm): algorithm is string => typeof algorithm === "string");
  return algorithms.length > 0 ? algorithms : ["ES256"];
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

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function secondsToIso(value: number | undefined) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function sanitizeError(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Request timed out.";
  }

  if (error instanceof Error && error.name === "AbortError") {
    return "Request was aborted.";
  }

  return error instanceof Error ? error.message : "Unknown error.";
}
