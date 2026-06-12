import { NextResponse } from "next/server";
import { appIdentityCookieName } from "@/lib/host-auth";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TokenExchangeResponse = {
  accessToken?: unknown;
  expiresInSeconds?: unknown;
};

const appIdentityCookieMaxAgeSeconds = 24 * 60 * 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const code = body && typeof body === "object" && "code" in body
    ? (body as { code?: unknown }).code
    : null;

  if (typeof code !== "string" || !code.trim()) {
    return appAuthError(
      "app_auth_code_required",
      "A Hosty app authorization code is required.",
      422,
    );
  }

  const endpoint = buildTokenEndpoint();
  if (!endpoint) {
    return appAuthError(
      "core_origin_invalid",
      "HOSTY_CORE_ORIGIN is not a valid URL.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: code.trim() }),
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
  } catch (error) {
    return appAuthError(
      isAbortError(error) ? "core_token_exchange_timeout" : "core_token_exchange_unavailable",
      error instanceof Error ? error.message : "Core token exchange is unavailable.",
      503,
    );
  }
  const payload = await response.json().catch(() => null) as TokenExchangeResponse | null;

  if (!response.ok) {
    return appAuthError(
      readErrorCode(payload) || "app_auth_code_exchange_failed",
      readErrorMessage(payload) || `Core token exchange returned HTTP ${response.status}.`,
      response.status,
    );
  }

  const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken.trim() : "";
  if (!accessToken) {
    return appAuthError(
      "app_identity_token_missing",
      "Core token exchange did not return an app identity token.",
      502,
    );
  }

  const maxAge = readIdentityCookieMaxAgeSeconds(payload);
  const appResponse = NextResponse.json({ ok: true }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
  appResponse.cookies.set(appIdentityCookieName, accessToken, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge,
  });

  return appResponse;
}

function readIdentityCookieMaxAgeSeconds(payload: TokenExchangeResponse | null) {
  return typeof payload?.expiresInSeconds === "number" && Number.isFinite(payload.expiresInSeconds)
    ? Math.max(1, Math.min(Math.floor(payload.expiresInSeconds), appIdentityCookieMaxAgeSeconds))
    : appIdentityCookieMaxAgeSeconds;
}

function buildTokenEndpoint() {
  try {
    return new URL("/api/auth/apps/token", getDemoConfig().host.coreOrigin).toString();
  } catch {
    return null;
  }
}

function appAuthError(code: string, message: string, status: number) {
  return NextResponse.json({
    error: {
      code,
      message,
    },
  }, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
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

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
