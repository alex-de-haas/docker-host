// Server slice: Next route-handler factories and Core revalidation. Never reaches a client
// bundle — the service token lives here.
import "server-only";

import {
  classifyRevalidationHttpStatus,
  type AppSessionFailureStatus,
  type AppSessionStatus,
  type SessionRecoveryParams,
} from "./index";

/** Per-app parameters: everything that legitimately diverges between apps stays a
 * parameter — cookie namespaces and role models are per-app by decision, never unified. */
export interface HostyAppConfig {
  /** Stable app id fallback for when HOSTY_APP_ID is not injected (mirrors the manifest). */
  appIdFallback: string;
  /** This app's identity cookie name (e.g. "hosty_marketplace_identity"). */
  identityCookieName: string;
  /** Optional host-role → app-role mapping hook; the raw role passes through when absent. */
  mapHostRole?: (hostRole: string | null) => string | null;
}

// Core runs on the same host as the app services, so a short budget is plenty; a stalled
// call must not hold a route open indefinitely.
const CORE_AUTH_TIMEOUT_MS = 1_500;

// Decision 9 (hosty-app-sdk.md): positive revalidations may be cached for 30s, clamped to
// the grant's expiry; negative results are never cached, so a stuck-unauthenticated state
// is impossible. Bounded so an attacker spraying tokens cannot grow the map unboundedly.
const REVALIDATION_CACHE_TTL_MS = 30_000;
const MAX_REVALIDATION_CACHE_ENTRIES = 256;

/** The inbound trusted-identity header the platform has always used (a frozen protocol
 * constant that survived the docker-host→hosty rename). */
export const HOSTY_APP_IDENTITY_HEADER = "x-docker-host-identity";

export interface HostIdentity {
  userId: string;
  email: string | null;
  displayName: string | null;
  hostRole: string | null;
  /** `mapHostRole(hostRole)` when the config provides the hook, else the raw host role. */
  appRole: string | null;
  expiresAt: string | null;
}

export type AppSessionResolution =
  | { status: "active"; identity: HostIdentity }
  | { status: AppSessionFailureStatus };

export function getAppId(config: HostyAppConfig): string {
  return process.env.HOSTY_APP_ID?.trim() || config.appIdFallback;
}

export function getCoreOrigin(): string | null {
  return process.env.HOSTY_CORE_ORIGIN?.trim() || null;
}

/** Browser-reachable Core origin. Core always injects it (falls back to its loopback
 * listen URL on localhost-only installs), so a missing value is a broken environment. */
export function getCorePublicOrigin(): string | null {
  return process.env.HOSTY_CORE_PUBLIC_ORIGIN?.trim() || null;
}

export function getServiceToken(): string | null {
  return process.env.HOSTY_APP_SERVICE_TOKEN?.trim() || null;
}

export function getRecoveryParams(config: HostyAppConfig): SessionRecoveryParams {
  return { appId: getAppId(config), corePublicOrigin: getCorePublicOrigin() };
}

export type HeaderReader = { get(name: string): string | null };

/**
 * Reads the app identity token from a request: the app-origin cookie first (authoritative
 * when present), then the Authorization bearer fallback the browser sends when the
 * cross-site cookie is blocked, then the legacy inbound identity header.
 */
export function readAppIdentityToken(headers: HeaderReader, config: HostyAppConfig): string | null {
  const cookieToken = readCookie(headers.get("cookie"), config.identityCookieName);
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = headers.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  return headers.get(HOSTY_APP_IDENTITY_HEADER)?.trim() || null;
}

/** True when the effective request protocol is https (honouring the forwarded proto). */
export function isSecureRequest(headers: HeaderReader, requestProtocol?: string): boolean {
  const forwarded = headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0].trim().toLowerCase() === "https";
  }
  return requestProtocol === "https:";
}

export interface IdentityCookieAttributes {
  httpOnly: true;
  secure: boolean;
  sameSite: "none" | "lax";
  path: "/";
  maxAge: number;
}

/**
 * Cookie attributes for the app-origin identity cookie. Cross-site Shell iframes need
 * `SameSite=None; Secure` over https; plain http (local dev) cannot use `Secure` and
 * falls back to `SameSite=Lax`. `maxAge` follows the grant's absolute lifetime.
 */
export function identityCookieAttributes(secure: boolean, maxAgeSeconds: number): IdentityCookieAttributes {
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  };
}

type CacheEntry = { identity: HostIdentity; expiresAtMs: number; cachedAt: number };
const revalidationCache = new Map<string, CacheEntry>();
const pendingRevalidations = new Map<string, Promise<AppSessionResolution>>();

/** Test hook: the cache is process-global by design (route handlers are stateless). */
export function clearRevalidationCache(): void {
  revalidationCache.clear();
  pendingRevalidations.clear();
}

/**
 * Revalidates an app identity token against Core with the app service token and
 * classifies the outcome. Core identity tokens are opaque (`hostyg_` grants), so this
 * round-trip is the only trustworthy validation; policy (disabled / unassigned / role
 * downgrade) is re-checked online by Core on every call, which is why caching stays short.
 */
export async function resolveAppSession(
  token: string | null,
  config: HostyAppConfig,
): Promise<AppSessionResolution> {
  if (!token) {
    return { status: "not-present" };
  }

  const serviceToken = getServiceToken();
  const coreOrigin = getCoreOrigin();
  if (!serviceToken || !coreOrigin) {
    return { status: "misconfigured" };
  }

  const now = Date.now();
  const cached = revalidationCache.get(token);
  if (cached) {
    if (now - cached.cachedAt < REVALIDATION_CACHE_TTL_MS && now < cached.expiresAtMs) {
      return { status: "active", identity: cached.identity };
    }
    revalidationCache.delete(token);
  }

  const pending = pendingRevalidations.get(token);
  if (pending) {
    return pending;
  }

  const revalidation = revalidateWithCore(token, coreOrigin, serviceToken, config);
  pendingRevalidations.set(token, revalidation);
  try {
    return await revalidation;
  } finally {
    pendingRevalidations.delete(token);
  }
}

async function revalidateWithCore(
  token: string,
  coreOrigin: string,
  serviceToken: string,
  config: HostyAppConfig,
): Promise<AppSessionResolution> {
  let endpoint: string;
  try {
    endpoint = new URL("/api/auth/apps/revalidate", coreOrigin).toString();
  } catch {
    return { status: "misconfigured" };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ accessToken: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(CORE_AUTH_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout — transient either way; never cached.
    return { status: "unavailable" };
  }

  if (!response.ok) {
    return { status: classifyRevalidationHttpStatus(response.status) };
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = (await response.json()) as Record<string, unknown> | null;
  } catch {
    // A non-JSON / truncated body means the session is unverifiable, not proof it is invalid.
    return { status: "unavailable" };
  }

  const appId = readString(payload?.appId);
  if (appId && appId !== getAppId(config)) {
    // A token minted for a different app is Core's token_app_mismatch — terminal, like 403.
    return { status: "forbidden" };
  }

  const userId = readString(payload?.userId);
  // An "active" grant without a subject is unusable; classify it as recoverable so a probe
  // and the real auth path can never disagree about the same token.
  if (!payload || payload.active !== true || !userId) {
    return { status: "expired" };
  }

  const hostRole = readString(payload.hostRole);
  const expiresAt = readString(payload.expiresAt);
  const identity: HostIdentity = {
    userId,
    email: readString(payload.email),
    displayName: readString(payload.displayName),
    hostRole,
    appRole: config.mapHostRole ? config.mapHostRole(hostRole) : hostRole,
    expiresAt,
  };

  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
    pruneRevalidationCache();
    revalidationCache.set(token, { identity, expiresAtMs, cachedAt: Date.now() });
  }

  return { status: "active", identity };
}

function pruneRevalidationCache(): void {
  if (revalidationCache.size < MAX_REVALIDATION_CACHE_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [token, entry] of revalidationCache) {
    if (now - entry.cachedAt >= REVALIDATION_CACHE_TTL_MS || now >= entry.expiresAtMs) {
      revalidationCache.delete(token);
    }
  }
  while (revalidationCache.size >= MAX_REVALIDATION_CACHE_ENTRIES) {
    const oldest = revalidationCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    revalidationCache.delete(oldest);
  }
}

/**
 * Cookie-only probe classification for the client recovery bridge. Deliberately ignores
 * bearer/header tokens: probe routes are public, and honoring caller-supplied tokens would
 * turn them into an unauthenticated oracle that revalidates attacker-chosen tokens against
 * Core. The recovery contract only ever concerns *this browser's* session, which lives in
 * the HttpOnly app cookie.
 */
export async function classifyAppSessionFromCookie(
  headers: HeaderReader,
  config: HostyAppConfig,
): Promise<AppSessionStatus> {
  const token = readCookie(headers.get("cookie"), config.identityCookieName);
  const resolution = await resolveAppSession(token, config);
  return resolution.status;
}

// Follow the grant's absolute lifetime (expiresInSeconds). The bound is only a sanity
// ceiling against a malformed response: 400 days is the maximum cookie Max-Age browsers
// honor (RFC 6265bis), so it never truncates a configured absolute lifetime.
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

export type AppCodeExchange =
  | { ok: true; accessToken: string; expiresInSeconds: number | null }
  | { ok: false; status: number; code: string; message: string };

/** Exchanges a one-time Shell/Core launch code for an identity token at Core. The code is
 * the only credential — the endpoint is deliberately unauthenticated on Core's side. */
export async function exchangeAppCode(code: string): Promise<AppCodeExchange> {
  const coreOrigin = getCoreOrigin();
  let endpoint: string;
  try {
    endpoint = new URL("/api/auth/apps/token", coreOrigin ?? "").toString();
  } catch {
    return { ok: false, status: 503, code: "core_origin_invalid", message: "HOSTY_CORE_ORIGIN is not a valid URL." };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      cache: "no-store",
      signal: AbortSignal.timeout(CORE_AUTH_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      status: 503,
      code: timeout ? "core_token_exchange_timeout" : "core_token_exchange_unavailable",
      message: "Hosty Core could not be reached to exchange the authorization code.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 401,
      code: "app_auth_code_rejected",
      message: `Core rejected the authorization code (HTTP ${response.status}).`,
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { accessToken?: unknown; expiresInSeconds?: unknown }
    | null;
  const accessToken = readString(payload?.accessToken);
  if (!accessToken) {
    return { ok: false, status: 502, code: "app_identity_token_missing", message: "Core returned no usable identity token." };
  }

  // A missing/malformed lifetime is tolerated (the cookie falls back to the browser
  // Max-Age ceiling) — the server-side grant still expires on schedule regardless, and
  // recovery handles the eventual 401.
  const expiresInSeconds =
    typeof payload?.expiresInSeconds === "number" && payload.expiresInSeconds > 0
      ? payload.expiresInSeconds
      : null;
  return { ok: true, accessToken, expiresInSeconds };
}

/**
 * Route-handler factory for `POST /api/auth/app-code`: exchanges the one-time `code` for
 * an identity token, stores it in the app-origin HttpOnly cookie, and returns the token so
 * the browser can keep a bearer fallback for when the cross-site cookie is blocked.
 * Framework-agnostic (Web `Request`/`Response`), usable directly as a Next route handler.
 */
export function createAppCodeRouteHandler(config: HostyAppConfig) {
  return async function POST(request: Request): Promise<Response> {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      // Fall through to the missing-code response.
    }
    const code =
      body && typeof body === "object" ? readString((body as { code?: unknown }).code) : null;
    if (!code) {
      return jsonResponse({ code: "app_auth_code_required", message: "A Hosty app authorization code is required." }, 422);
    }

    const exchange = await exchangeAppCode(code);
    if (!exchange.ok) {
      return jsonResponse({ code: exchange.code, message: exchange.message }, exchange.status);
    }

    const secure = isSecureRequest(request.headers, safeProtocol(request.url));
    const attributes = identityCookieAttributes(
      secure,
      Math.min(exchange.expiresInSeconds ?? MAX_COOKIE_AGE_SECONDS, MAX_COOKIE_AGE_SECONDS),
    );
    const cookie = [
      `${config.identityCookieName}=${encodeURIComponent(exchange.accessToken)}`,
      `Path=${attributes.path}`,
      `Max-Age=${attributes.maxAge}`,
      `SameSite=${attributes.sameSite === "none" ? "None" : "Lax"}`,
      "HttpOnly",
      ...(attributes.secure ? ["Secure"] : []),
    ].join("; ");

    return jsonResponse(
      { accessToken: exchange.accessToken, expiresInSeconds: exchange.expiresInSeconds },
      200,
      { "set-cookie": cookie },
    );
  };
}

function safeProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const entry of cookieHeader?.split(";") ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
