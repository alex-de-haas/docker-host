import type { IncomingMessage } from "node:http";

// Validating this app's own Hosty session, for the settings page.
//
// Deliberately not `@hosty-sdk/app/server`: that entry is the SDK's **Next** server slice — it opens
// with `import "server-only"`, which throws outside a React server environment, and it is written
// for bundler module resolution. This gateway is a plain Node process, so importing it pulls a
// framework contract into a service that has no framework. What is actually needed is one POST.
//
// The endpoint and its classification are Core's contract, shared with the SDK rather than invented
// here: `POST /api/auth/apps/revalidate` with the app service token, and the status taxonomy below
// keyed on HTTP status only — never on error-code strings, so a new Core code cannot break this app.

export const identityCookieName = "hosty_ai_gateway_identity";

export type AppSessionIdentity = { userId: string; hostRole: string | null };

export type AppSessionResult =
  | { status: "active"; identity: AppSessionIdentity }
  | { status: "not-present" | "expired" | "forbidden" | "unavailable" | "misconfigured" };

export function readIdentityCookie(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === identityCookieName) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim()) || null;
      } catch {
        // A Cookie header is untrusted input, and `decodeURIComponent` throws on malformed
        // percent-encoding. A value this app could not have written is no credential, so it reads
        // as absent rather than crashing the request.
        return null;
      }
    }
  }

  return null;
}

export async function resolveAppSession(token: string | null): Promise<AppSessionResult> {
  if (!token) {
    return { status: "not-present" };
  }

  const coreOrigin = process.env.HOSTY_CORE_ORIGIN?.trim();
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!coreOrigin || !serviceToken) {
    // An operator problem, not a caller problem: the app was started outside Core, or by a Core too
    // old to inject these. Reported as its own status so the page can say which.
    return { status: "misconfigured" };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/apps/revalidate", coreOrigin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ accessToken: token }),
    });
  } catch {
    // Core unreachable is transient and must not read as "refused": the difference decides whether
    // the operator waits or goes looking for a permissions problem.
    return { status: "unavailable" };
  }

  if (!response.ok) {
    return { status: classifyRevalidationStatus(response.status) };
  }

  // Core's shape, flattened — `AppSessionValidationResult` in AppIdentityService.cs, serialized with
  // `JsonSerializerDefaults.Web`. `active` is checked rather than assumed from the 2xx: it is the
  // field that carries the answer, and reading only the identity would let a future negative result
  // pass as a session.
  const payload = (await response.json().catch(() => null)) as
    | { active?: unknown; userId?: unknown; hostRole?: unknown }
    | null;
  const userId = typeof payload?.userId === "string" ? payload.userId : "";
  if (payload?.active !== true || !userId) {
    return { status: "unavailable" };
  }

  return {
    status: "active",
    identity: { userId, hostRole: typeof payload.hostRole === "string" ? payload.hostRole : null },
  };
}

/** Core's normative table, by status code only. */
function classifyRevalidationStatus(status: number): Exclude<AppSessionResult["status"], "active"> {
  if (status === 401) {
    return "expired";
  }
  if (status === 403) {
    return "forbidden";
  }
  return status >= 500 ? "unavailable" : "expired";
}

/**
 * Trades a Hosty launch code for this app's session cookie.
 *
 * Shell hands the page a `code` on the launch URL; this exchanges it with Core and returns the
 * `Set-Cookie` the browser needs. `sameSite` follows `secure` because an embedded page is
 * cross-site to Shell whenever Hosty is served over https — a lax cookie would simply not be sent
 * from inside the frame, which looks exactly like "the app refused me".
 */
export async function exchangeLaunchCode(
  code: string,
  secure: boolean,
): Promise<{ ok: true; setCookie: string } | { ok: false; status: number; code: string; message: string }> {
  const coreOrigin = process.env.HOSTY_CORE_ORIGIN?.trim();
  if (!coreOrigin) {
    return { ok: false, status: 503, code: "core_origin_missing", message: "HOSTY_CORE_ORIGIN is not configured." };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/apps/token", coreOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, status: 503, code: "core_unreachable", message: "Hosty Core could not be reached." };
  }

  const payload = (await response.json().catch(() => null)) as
    | { accessToken?: unknown; expiresInSeconds?: unknown; message?: unknown }
    | null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: "app_code_rejected",
      message: typeof payload?.message === "string" ? payload.message : "Hosty Core rejected the launch code.",
    };
  }

  const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : null;
  if (!accessToken) {
    return { ok: false, status: 502, code: "app_identity_token_missing", message: "Core returned no usable identity token." };
  }

  const maxAge = typeof payload?.expiresInSeconds === "number" ? Math.max(0, Math.floor(payload.expiresInSeconds)) : 3600;
  const attributes = [
    `${identityCookieName}=${encodeURIComponent(accessToken)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    `SameSite=${secure ? "None" : "Lax"}`,
    ...(secure ? ["Secure"] : []),
  ];
  return { ok: true, setCookie: attributes.join("; ") };
}
