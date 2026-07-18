const identityHeaderName = "x-docker-host-identity";
const identityTimeoutMs = 1_500;

export const appIdentityCookieName = "hosty_telemetry_identity";

export type HeaderReader = {
  get(name: string): string | null;
};

export type TelemetryIdentityStatus =
  | "not-present"
  | "active"
  | "expired"
  | "forbidden"
  | "unavailable"
  | "error";

export type TelemetryIdentity = {
  status: TelemetryIdentityStatus;
  tokenPresent: boolean;
  appId: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  hostRole: string | null;
  expiresAt: string | null;
  error: { code: string; message: string; status: number | null } | null;
};

export type RecoveryParams = {
  appId: string;
  corePublicOrigin: string;
};

/**
 * App id + browser-reachable Core origin for client session recovery. These ride in the
 * force-dynamic identity response — not in a server-component prop — because pages can be
 * prerendered at image build time, where the HOSTY_* environment does not exist yet; a route
 * handler reads them on the machine that actually runs the app. Neither value is secret: both
 * are addressed to the browser by design.
 */
export function getRecoveryParams(): RecoveryParams {
  return {
    appId: readEnvironmentString("HOSTY_APP_ID") ?? "hosty.telemetry",
    corePublicOrigin:
      readEnvironmentString("HOSTY_CORE_PUBLIC_ORIGIN") ??
      readEnvironmentString("HOSTY_CORE_ORIGIN") ??
      "http://localhost:7070",
  };
}

export async function getTelemetryIdentity(headersList: HeaderReader): Promise<TelemetryIdentity> {
  const appId = readEnvironmentString("HOSTY_APP_ID") ?? "hosty.telemetry";
  const token = readIdentityToken(headersList);
  const base = { tokenPresent: Boolean(token), appId };

  if (!token) {
    return emptyIdentity(base, "not-present", null);
  }

  const endpoint = buildCoreEndpoint("/api/auth/apps/revalidate");
  if (!endpoint) {
    return emptyIdentity(base, "error", {
      code: "core_origin_invalid",
      message: "HOSTY_CORE_ORIGIN is not a valid URL.",
      status: null,
    });
  }

  const serviceToken = readEnvironmentString("HOSTY_APP_SERVICE_TOKEN");
  if (!serviceToken) {
    return emptyIdentity(base, "error", {
      code: "app_service_token_missing",
      message: "HOSTY_APP_SERVICE_TOKEN is not configured.",
      status: null,
    });
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ accessToken: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(identityTimeoutMs),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // 401 is recoverable (token missing/expired/invalid/revoked) → the client re-authorizes;
      // 403 is terminal (disabled/unassigned/admin-only) → access denied, no auto-redirect.
      return emptyIdentity(base, response.status === 401 ? "expired" : response.status === 403 ? "forbidden" : "error", {
        code: readErrorField(payload, "code") ?? "app_session_revalidation_failed",
        message: readErrorField(payload, "message") ?? `Core revalidation returned HTTP ${response.status}.`,
        status: response.status,
      });
    }

    const record = asRecord(payload);
    if (readString(record?.appId) !== appId) {
      return emptyIdentity(base, "forbidden", {
        code: "app_identity_app_mismatch",
        message: "Identity token was issued for a different app.",
        status: null,
      });
    }

    return {
      ...base,
      status: record?.active === true ? "active" : "expired",
      userId: readString(record?.userId),
      email: readString(record?.email),
      displayName: readString(record?.displayName),
      hostRole: readString(record?.hostRole),
      expiresAt: readString(record?.expiresAt),
      error: null,
    };
  } catch (error) {
    const timeout = isAbortError(error);
    return emptyIdentity(base, timeout ? "unavailable" : "error", {
      code: timeout ? "core_revalidation_timeout" : "app_session_revalidation_error",
      message: error instanceof Error ? error.message : "Core identity revalidation failed.",
      status: null,
    });
  }
}

export function buildCoreEndpoint(path: string): string | null {
  try {
    return new URL(path, readEnvironmentString("HOSTY_CORE_ORIGIN") ?? "http://localhost:7070").toString();
  } catch {
    return null;
  }
}

function readIdentityToken(headersList: HeaderReader): string | null {
  const cookieToken = readCookie(headersList.get("cookie"), appIdentityCookieName);
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = headersList.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return readString(authorization.slice("Bearer ".length));
  }

  return readString(headersList.get(identityHeaderName));
}

function emptyIdentity(
  base: { tokenPresent: boolean; appId: string },
  status: TelemetryIdentityStatus,
  error: TelemetryIdentity["error"],
): TelemetryIdentity {
  return {
    ...base,
    status,
    userId: null,
    email: null,
    displayName: null,
    hostRole: null,
    expiresAt: null,
    error,
  };
}

function readCookie(header: string | null, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) {
      continue;
    }

    try {
      return readString(decodeURIComponent(entry.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

function readErrorField(payload: unknown, field: "code" | "message"): string | null {
  const record = asRecord(payload);
  const error = asRecord(record?.error);
  return readString(error?.[field]) ?? readString(record?.[field]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readEnvironmentString(name: string): string | null {
  return readString(process.env[name]);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
