// Core slice: pure TypeScript, safe in any runtime (browser, Node, edge, solitaire's
// server.mjs). No React, no Next, no environment reads — everything is passed in.
//
// This is the single source of truth for the Hosty app-session contract described in
// docker-host docs/ideas/hosty-app-sdk.md and docs/ideas/auth-session-lifecycle.md.

/**
 * The postMessage type an embedded app sends its parent to request a fresh launch code.
 * A frozen protocol constant: it deliberately does not track product branding (precedent:
 * the `x-docker-host-identity` header survived the docker-host→hosty rename untouched).
 * The payload carries no secret — the embedder verifies the sender before acting.
 */
export const AUTH_REQUIRED_INTENT_TYPE = "hosty:auth-required";

export interface AuthRequiredIntent {
  type: typeof AUTH_REQUIRED_INTENT_TYPE;
  appId: string;
}

export function createAuthRequiredIntent(appId: string): AuthRequiredIntent {
  return { type: AUTH_REQUIRED_INTENT_TYPE, appId };
}

/**
 * Recovery classification of an app session, per the platform identity error contract:
 * - `not-present`: no token at all (recoverable — same handling as `expired`).
 * - `active`: token revalidated OK.
 * - `expired`: Core 401 — recoverable; re-authorize via the Shell (embedded) or Core `/open`
 *   (standalone).
 * - `forbidden`: Core 403 or a token minted for a different app — terminal; never
 *   auto-redirect (it would loop).
 * - `unavailable`: Core unreachable, slow, or answering garbage — transient; keep the
 *   cookie and offer a retry.
 * - `misconfigured`: the app itself is broken (no service token / no Core origin) — an
 *   operator problem; signing in cannot fix it, so never offer a login.
 */
export type AppSessionStatus =
  | "not-present"
  | "active"
  | "expired"
  | "forbidden"
  | "unavailable"
  | "misconfigured";

/** Failure statuses (everything but `active`). */
export type AppSessionFailureStatus = Exclude<AppSessionStatus, "active">;

/**
 * Maps a Core revalidation HTTP status onto the session classification. Classification is
 * by status code only — never by error-code strings — so new Core codes cannot break an
 * app; `MapIdentityErrorStatus` in Core is the normative table behind these numbers.
 */
export function classifyRevalidationHttpStatus(status: number): AppSessionFailureStatus {
  if (status === 401) {
    return "expired";
  }
  if (status === 403) {
    return "forbidden";
  }
  return "unavailable";
}

/**
 * Recovery parameters an app's force-dynamic identity/session endpoint hands the browser.
 * They ride in a response — never in a server-component prop — because app pages are
 * prerendered at image build time, where the HOSTY_* environment does not exist yet
 * (docker-host PR #233 / media-server PR #63). Neither value is secret.
 */
export interface SessionRecoveryParams {
  appId: string | null;
  corePublicOrigin: string | null;
}

export function readRecoveryParams(body: unknown): SessionRecoveryParams {
  const recovery =
    body && typeof body === "object" ? (body as { recovery?: unknown }).recovery : null;
  if (!recovery || typeof recovery !== "object") {
    return { appId: null, corePublicOrigin: null };
  }
  const { appId, corePublicOrigin } = recovery as { appId?: unknown; corePublicOrigin?: unknown };
  return {
    appId: typeof appId === "string" && appId.length > 0 ? appId : null,
    corePublicOrigin:
      typeof corePublicOrigin === "string" && corePublicOrigin.length > 0
        ? corePublicOrigin
        : null,
  };
}

/** True for hosts that only resolve on the machine itself. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export interface PageLocation {
  origin: string;
  pathname: string;
  search: string;
  hostname: string;
}

/**
 * Builds the Core standalone re-auth URL (`/api/apps/{id}/open?redirectUri=…`) for the
 * current page, or null when the redirect is known to be impossible:
 * - no Core public origin at all, or an unparsable one;
 * - Core's origin is loopback while this page is not — an unset public origin falls back
 *   to Core's loopback listen URL, which only a same-machine browser can follow, and Core
 *   would reject the foreign redirect URI anyway (`redirect_uri_denied`).
 * The fragment is deliberately dropped: Core rejects redirect URIs carrying one
 * (`redirect_uri_invalid`), and it would not survive the server redirect anyway.
 */
export function buildCoreOpenUrl(
  corePublicOrigin: string | null,
  appId: string,
  location: PageLocation,
): string | null {
  if (!corePublicOrigin) {
    return null;
  }

  let target: URL;
  try {
    target = new URL(`/api/apps/${encodeURIComponent(appId)}/open`, corePublicOrigin);
  } catch {
    return null;
  }

  if (isLoopbackHost(target.hostname) && !isLoopbackHost(location.hostname)) {
    return null;
  }

  target.searchParams.set("redirectUri", `${location.origin}${location.pathname}${location.search}`);
  return target.toString();
}

/** Launch mode drives the logout affordance: embedded apps hide logout entirely (the
 * session belongs to the Shell), standalone apps may show one. `window.self !== window.top`
 * is the baseline signal; a Core-reported launch channel can replace it later without
 * changing callers. */
export type AppLaunchMode = "embedded" | "standalone";

export function detectLaunchMode(win: Pick<Window, "self" | "top">): AppLaunchMode {
  try {
    return win.self !== win.top ? "embedded" : "standalone";
  } catch {
    // A cross-origin `top` access can throw in exotic embeddings; being framed is the only
    // way that happens, so classify it as embedded.
    return "embedded";
  }
}

/**
 * The recovery decision: state × launch mode → what the app should do, per the UX
 * contract (Core `/login` is the only auth UI in the system; apps render no login UI and
 * no errors while recovery runs).
 */
export type RecoveryAction =
  | { kind: "none" }
  | { kind: "post-auth-required"; intent: AuthRequiredIntent }
  | { kind: "redirect"; openUrl: string }
  | { kind: "card"; card: "signin" | "denied" | "unavailable" | "misconfigured" };

export function decideRecoveryAction(input: {
  status: AppSessionStatus;
  mode: AppLaunchMode;
  appId: string;
  openUrl: string | null;
  redirectAlreadyAttempted: boolean;
}): RecoveryAction {
  const { status, mode, appId, openUrl, redirectAlreadyAttempted } = input;

  if (status === "active") {
    return { kind: "none" };
  }
  if (status === "forbidden") {
    return { kind: "card", card: "denied" };
  }
  if (status === "unavailable") {
    return { kind: "card", card: "unavailable" };
  }
  if (status === "misconfigured") {
    return { kind: "card", card: "misconfigured" };
  }

  // expired / not-present — the recoverable pair.
  if (mode === "embedded") {
    return { kind: "post-auth-required", intent: createAuthRequiredIntent(appId) };
  }
  if (openUrl && !redirectAlreadyAttempted) {
    return { kind: "redirect", openUrl };
  }
  return { kind: "card", card: "signin" };
}
