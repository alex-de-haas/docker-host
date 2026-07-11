import { NextResponse } from "next/server";
import { appIdentityCookieName, buildCoreEndpoint } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TokenExchangeResponse = {
  accessToken?: unknown;
  expiresInSeconds?: unknown;
};

const maximumCookieAgeSeconds = 24 * 60 * 60;

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body
    ? (body as { code?: unknown }).code
    : null;
  if (typeof code !== "string" || !code.trim()) {
    return authError("app_auth_code_required", "A Hosty app authorization code is required.", 422);
  }

  const endpoint = buildCoreEndpoint("/api/auth/apps/token");
  if (!endpoint) {
    return authError("core_origin_invalid", "HOSTY_CORE_ORIGIN is not a valid URL.", 503);
  }

  let coreResponse: Response;
  try {
    coreResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
  } catch (error) {
    return authError(
      isAbortError(error) ? "core_token_exchange_timeout" : "core_token_exchange_unavailable",
      error instanceof Error ? error.message : "Core token exchange is unavailable.",
      503,
    );
  }

  const payload = await coreResponse.json().catch(() => null) as TokenExchangeResponse | null;
  if (!coreResponse.ok) {
    return authError(
      readErrorField(payload, "code") ?? "app_auth_code_exchange_failed",
      readErrorField(payload, "message") ?? `Core token exchange returned HTTP ${coreResponse.status}.`,
      coreResponse.status,
    );
  }

  const accessToken = readString(payload?.accessToken);
  if (!accessToken) {
    return authError("app_identity_token_missing", "Core token exchange did not return an app identity token.", 502);
  }

  const secure = isSecureRequest(request);
  const response = NextResponse.json({ ok: true }, {
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(appIdentityCookieName, accessToken, {
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
    path: "/",
    maxAge: readMaxAge(payload),
  });
  return response;
}

function readMaxAge(payload: TokenExchangeResponse | null): number {
  return typeof payload?.expiresInSeconds === "number" && Number.isFinite(payload.expiresInSeconds)
    ? Math.max(1, Math.min(Math.floor(payload.expiresInSeconds), maximumCookieAgeSeconds))
    : maximumCookieAgeSeconds;
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) {
    return forwarded === "https";
  }
  return new URL(request.url).protocol === "https:";
}

function authError(code: string, message: string, status: number) {
  // Flat { code, message } to match the shared ErrorResponse shape used by the other Marketplace
  // routes (route-auth), so clients handle every app error the same way.
  return NextResponse.json({ code, message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function readErrorField(payload: unknown, field: "code" | "message"): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : null;
  return readString(error?.[field]) ?? readString(record[field]);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
