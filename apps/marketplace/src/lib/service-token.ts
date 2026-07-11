import crypto from "node:crypto";

export const SERVICE_TOKEN_HEADER = "x-hosty-app-service-token";

export type TokenDecision =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: string; message: string };

// Shared-secret check for every non-health route: the caller must present the exact app service
// token Core minted for this app. Fails closed when no token was injected (standalone run), so a
// tokenless loopback API can never mutate sources or leak diagnostics.
export function authorizeServiceToken(presented: string | null, configured: string | null): TokenDecision {
  if (!configured || !configured.trim()) {
    return {
      ok: false,
      status: 503,
      code: "marketplace_token_unconfigured",
      message: "The marketplace app has no service token configured; requests cannot be authorized.",
    };
  }

  const candidate = presented?.trim() ?? "";
  if (!candidate || !fixedTimeEquals(configured, candidate)) {
    return {
      ok: false,
      status: 401,
      code: "marketplace_token_invalid",
      message: "App service token is missing or invalid.",
    };
  }

  return { ok: true };
}

function fixedTimeEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) {
    // timingSafeEqual requires equal lengths; a length mismatch is not a comparable secret. Compare
    // the expected buffer against itself to keep the work roughly constant before rejecting.
    crypto.timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }

  return crypto.timingSafeEqual(expectedBytes, actualBytes);
}
