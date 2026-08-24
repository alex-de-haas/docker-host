// Scoped access tokens: the credential an external client presents directly to this app
// (docs/features/scoped-access-tokens/feature.md).
//
// In its own entry, like ./delegated, so a plain Node service can import it — an app's MCP endpoint
// is usually not a Next route, and the server slice pulls in "server-only", which throws outside a
// React server bundle.
//
// The contrast with ./delegated is the whole point of this credential. A delegated token is signed
// and checked locally: fast, but unrevocable, so it lives five minutes and cannot sit in a client's
// configuration file. A scoped token is opaque and worth nothing until Core says otherwise, which is
// why it can live in a config and still stop the moment an operator revokes it.

/** What Core says about a credential. `active` is sufficient on its own: a caller that reads
 * nothing else is not thereby insecure, because everything else is present only when it is true. */
export type ScopedTokenIntrospection =
  | { active: true; sub: string; role: string | null; scopes: string[] }
  | { active: false; error?: ScopedTokenError };

/** Why the answer could not be obtained. Present only when Core was never reached or answered
 * something unusable — an ordinary "this credential is not valid" is a plain `active: false` with
 * no error, because it is an answer rather than a failure. */
export interface ScopedTokenError {
  status: number | null;
  code: string;
  message: string;
}

export interface IntrospectScopedTokenOptions {
  /** The tool or method this call is about. Core records it as the audit line for the action, so an
   * external client's use of an app is visible to the host — pass it for a tool call, and leave it
   * out for protocol traffic that is not itself an action. */
  tool?: string;
  /** Audience to introspect for; defaults to HOSTY_APP_ID. An app introspects only for itself —
   * Core validates this against the service token regardless, so overriding it cannot widen reach. */
  appId?: string;
  /** Core origin; defaults to HOSTY_CORE_ORIGIN. */
  coreOrigin?: string;
  /** This app's service token; defaults to HOSTY_APP_SERVICE_TOKEN. */
  serviceToken?: string;
  /** Request budget. Core is on the same host, so the default is short. */
  timeoutMs?: number;
}

// Core is a loopback hop away, so a generous budget would only hold a request open while something
// is already wrong.
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Ask Core whether a bearer this app received is a live credential scoped to this app.
 *
 * Deliberately uncached, and callers must not add one: the credential's whole advantage over a
 * delegated token is that revocation takes effect on the next call, and a cache is exactly the
 * window that would take back.
 */
export async function introspectScopedToken(
  token: string,
  options: IntrospectScopedTokenOptions = {},
): Promise<ScopedTokenIntrospection> {
  const appId = options.appId?.trim() || process.env.HOSTY_APP_ID?.trim();
  const serviceToken = options.serviceToken?.trim() || process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  // No fallback origin is invented when the variable is missing. Core injects HOSTY_CORE_ORIGIN
  // already resolved for the runtime this app is in — a container reaches Core by a different
  // address than a host process does — so a guessed `localhost` would be right in one runtime and
  // silently wrong in the other. This is the same origin every other Core call in this SDK uses.
  const coreOrigin = options.coreOrigin?.trim() || process.env.HOSTY_CORE_ORIGIN?.trim();
  if (!token || !appId || !serviceToken || !coreOrigin) {
    return {
      active: false,
      error: {
        status: null,
        code: "introspection_unconfigured",
        message: !token
          ? "No credential was presented."
          : "HOSTY_APP_ID, HOSTY_APP_SERVICE_TOKEN, and HOSTY_CORE_ORIGIN must all be configured.",
      },
    };
  }

  let endpoint: string;
  try {
    endpoint = new URL(`/api/internal/apps/${encodeURIComponent(appId)}/token/introspect`, coreOrigin).toString();
  } catch {
    return {
      active: false,
      error: { status: null, code: "core_origin_invalid", message: "HOSTY_CORE_ORIGIN is not a valid URL." },
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, ...(options.tool ? { tool: options.tool } : {}) }),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // Core unreachable is a failure, never an inactive credential. The distinction matters to the
    // caller: this is a 503, not a 401, and answering "inactive" would tell a legitimate client its
    // credential is bad while the truth is that nothing could be checked.
    const timedOut = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      active: false,
      error: {
        status: null,
        code: timedOut ? "introspection_timeout" : "introspection_unavailable",
        message: error instanceof Error ? error.message : "The introspection request to Core failed.",
      },
    };
  }

  if (!response.ok) {
    return {
      active: false,
      error: {
        status: response.status,
        code: "introspection_failed",
        message: `Core answered ${response.status} for the introspection request.`,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      active: false,
      error: { status: response.status, code: "core_response_invalid", message: "Core returned an unreadable body." },
    };
  }

  // Fail closed on the shape: only a literal `true` is active. Anything else — absent, a string, the
  // wrong nesting — means the answer could not be read, and an unreadable answer is not a grant.
  const body = payload as { active?: unknown; sub?: unknown; role?: unknown; scopes?: unknown };
  if (body?.active !== true || typeof body.sub !== "string") {
    return { active: false };
  }

  return {
    active: true,
    sub: body.sub,
    role: typeof body.role === "string" ? body.role : null,
    scopes: Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string") : [],
  };
}

/** Whether an introspection result carries a scope. Exact match, because a scope is a protocol
 * constant rather than text a caller should normalize. */
export function hasScope(result: ScopedTokenIntrospection, scope: string): boolean {
  return result.active && result.scopes.includes(scope);
}

/** The scope every read-only MCP tool is gated on today. Mutation scopes arrive with the feature
 * that introduces mutations. */
export const SCOPE_MCP_READ = "mcp:read";
