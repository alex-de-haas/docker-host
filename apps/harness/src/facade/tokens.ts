// The two Core calls the facade authenticates with.
//
// Both are ordinary app→Core requests carrying this app's service token, and both are made *per
// call* rather than cached: the credential an external client holds is long-lived precisely because
// it is re-validated every time, and caching either answer would hand back the revocation window
// the whole design exists to close.

import { introspectScopedToken, type ScopedTokenIntrospection } from "@hosty-sdk/app/scoped-token";

/** Core's own MCP endpoint, addressed as a delegation target. Not an app id — no app can hold this
 * value, because an app id admits only `[a-z0-9._-]`. */
export const CORE_TARGET = "hosty:core";

export interface DelegatedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Who Core says the caller is, from the scoped access token they presented.
 *
 * The SDK helper does the work — the same one every app uses, deliberately, so the facade is not a
 * second implementation of the contract it is meant to demonstrate.
 *
 * Every parameter is passed rather than left to the helper's environment defaults. They are the same
 * values in production, but the facade already holds them, and a component that half-reads its own
 * configuration from ambient state is one that behaves differently under test than in service.
 */
export function introspect(
  config: { coreOrigin: string; serviceToken: string; appId: string },
  token: string,
  tool?: string,
): Promise<ScopedTokenIntrospection> {
  return introspectScopedToken(token, {
    coreOrigin: config.coreOrigin,
    serviceToken: config.serviceToken,
    appId: config.appId,
    ...(tool ? { tool } : {}),
  });
}

/**
 * A delegated token letting this app act toward `targetAppId` as the user behind `clientToken`.
 *
 * Null on any refusal — an unreachable Core, a revoked credential, a target the user may not reach.
 * They mean the same thing to the caller (this tool is not available to this client right now), and
 * the distinction is Core's to record in its audit rather than the facade's to reinterpret.
 */
export async function mintOnBehalfOf(
  coreOrigin: string,
  serviceToken: string,
  appId: string,
  clientToken: string,
  targetAppId: string,
): Promise<DelegatedToken | null> {
  try {
    const response = await fetch(
      `${coreOrigin}/api/internal/apps/${encodeURIComponent(appId)}/delegated-token`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ token: clientToken, targetAppId }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
    return typeof body.token === "string" && typeof body.expiresAt === "string"
      ? { token: body.token, expiresAtMs: new Date(body.expiresAt).getTime() }
      : null;
  } catch {
    return null;
  }
}
