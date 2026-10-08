import type { AppSessionStatus, AppSessionFailureStatus, SessionRecoveryParams } from "./session-types";
export type { AppSessionStatus, AppSessionFailureStatus, SessionRecoveryParams } from "./session-types";

// Core slice: pure TypeScript, safe in any runtime (browser, Node, edge, solitaire's
// server.mjs). No React, no Next, no environment reads — everything is passed in.
//
// This is the single source of truth for the Hosty app-session contract described in
// docker-host docs/features/hosty-app-sdk/feature.md and docs/features/auth-session-lifecycle/feature.md.

/**
 * The postMessage type for an embedded app's authentication-required intent.
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
 * The postMessage types of the delegated-token handshake: an embedded app page asks its embedder
 * for a short-TTL token scoped to itself, and the embedder answers with one it minted from Core.
 * Minting a delegated token uses the embedder's first-party Core session. The app's own identity
 * sign-in is separate: it navigates directly to Core or opens its own popup.
 *
 * The request carries no secret, so it is safe to broadcast; the answer does, so an embedder must
 * post it to the frame's own origin and never to `*`. Answering is a decision, not a reflex: the
 * token is a user-scoped credential, so an embedder answers only for apps it deliberately grants
 * one (Hosty Shell: the assistant gateway, which it already mints tokens for).
 */
/**
 * An embedded app handing text to the selected assistant through its embedder.
 * The receiving assistant applies its own draft/immediate-start setting. Authentication
 * and tool permissions still apply; the message does not prove prompt authorship.
 * This small embedded channel carries plain text and has no execution-result reply.
 */
export const ASK_ASSISTANT_TYPE = "hosty:ask-assistant";

/**
 * How many of an embedded assistant's sessions are waiting for the operator.
 *
 * Published by the page that holds them, not asked for on a timer: one source, so a shell's badge and
 * the list behind it can never disagree.
 */
export const ATTENTION_TYPE = "hosty:assistant-attention";

/** Longer than a prompt fragment is a page dumping itself into someone's draft. */
export const ASK_ASSISTANT_MAX_CHARS = 4000;

export interface AskAssistantMessage {
  type: typeof ASK_ASSISTANT_TYPE;
  /** Trimmed and capped by the embedder's parser; the app need not pre-truncate. */
  text: string;
}

/**
 * Asks the embedder to hand `text` to the operator's selected assistant.
 *
 * Safe to call unconditionally: standalone there is no embedder to hear it, and an embedder that
 * does not offer an assistant simply ignores it. Returns whether the message could be posted at
 * all — never whether anyone acted on it, which is the operator's business and not the app's.
 */
export function askAssistant(text: string): boolean {
  if (typeof window === "undefined" || window.parent === window) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  // Broadcast: the message carries no secret, and the embedder verifies the sender against its own
  // DOM rather than trusting anything claimed here.
  //
  // Capped on the way out too. The parser remains where the contract is enforced — an app is not
  // trusted to have done this — but there is no reason to structure-clone a megabyte across the
  // boundary just to have the embedder discard it.
  const capped = trimmed.slice(0, ASK_ASSISTANT_MAX_CHARS);
  window.parent.postMessage({ type: ASK_ASSISTANT_TYPE, text: capped } satisfies AskAssistantMessage, "*");
  return true;
}

export const DELEGATED_TOKEN_REQUEST_TYPE = "hosty:request-delegated-token";
export const DELEGATED_TOKEN_TYPE = "hosty:delegated-token";

export interface DelegatedTokenRequest {
  type: typeof DELEGATED_TOKEN_REQUEST_TYPE;
  /**
   * Set when the app is asking because the token it holds was refused. Only the app learns that —
   * it is the one calling the API — so without this flag an embedder that caches its mints would
   * keep answering with the very token that just came back 401, and the app could not recover until
   * the embedder's own copy aged out. Absent rather than false on an ordinary request.
   */
  refresh?: true;
}

export interface DelegatedTokenGrant {
  type: typeof DELEGATED_TOKEN_TYPE;
  token: string;
  /** ISO-8601 expiry, so the page can reuse the token instead of asking once per request. */
  expiresAt: string;
}

export function createDelegatedTokenRequest(options: { refresh?: boolean } = {}): DelegatedTokenRequest {
  return options.refresh
    ? { type: DELEGATED_TOKEN_REQUEST_TYPE, refresh: true }
    : { type: DELEGATED_TOKEN_REQUEST_TYPE };
}

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

export function readRecoveryParams(body: unknown): SessionRecoveryParams {
  const recovery =
    body && typeof body === "object" ? (body as { recovery?: unknown }).recovery : null;
  if (!recovery || typeof recovery !== "object") {
    return { appId: null, corePublicOrigin: null, appAuthProtocol: null };
  }
  const { appId, corePublicOrigin, appAuthProtocol } = recovery as { appId?: unknown; corePublicOrigin?: unknown; appAuthProtocol?: unknown };
  return {
    appAuthProtocol: appAuthProtocol === 1 || appAuthProtocol === 2 ? appAuthProtocol : null,
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
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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

/**
 * How a shell is presenting this app.
 *
 * - `embedded` — framed by the browser Shell. The shell renders navigation for this app. The
 *   app restores its per-tab grant, tries a silent Core redirect on first load, then uses its
 *   own Core popup when interaction is required. No credential passes through the parent.
 * - `native` — the top frame inside a native shell's web view (`apps/shell-swift`). The shell
 *   renders navigation, but there is no parent to post to, so recovery takes the standalone
 *   redirect — which is exactly the navigation that client intercepts to re-mint a launch code.
 * - `standalone` — a plain browser tab on the app's own origin. Nothing else renders navigation
 *   for this app, so it keeps its own.
 *
 * Two independent decisions read this one value and they do not split it the same way: chrome
 * is hidden whenever the mode is not `standalone` (`hidesAppChrome`), while frame-local silent
 * sign-in and popup recovery belong to `embedded` alone (`AppIdentityBridge`). A native web
 * view keeps standalone recovery even though its app chrome is hidden.
 */
export type AppLaunchMode = "embedded" | "native" | "standalone";

/** The query parameter a shell appends to the launch URL to declare the mode. */
export const LAUNCH_MODE_PARAM = "hosty_launch";
/** Where a resolved mode is kept for the life of the tab or web view. */
export const LAUNCH_MODE_STORAGE_KEY = "hosty.launch.mode";
/** The root attribute the launch bridge writes; CSS hides duplicated chrome off it. */
export const LAUNCH_MODE_ATTRIBUTE = "data-hosty-launch";
/**
 * Marks an element that duplicates chrome a shell already renders — the app's own name and the
 * navigation between its manifest pages. Contextual controls and information a shell does not
 * render (a project picker, a refresh action, an identity badge) are not chrome in this sense
 * and must not carry it.
 */
export const SHELL_DUPLICATED_CHROME_CLASS = "hosty-shell-chrome";

export function normalizeLaunchMode(value: unknown): AppLaunchMode | null {
  return value === "embedded" || value === "native" || value === "standalone" ? value : null;
}

/**
 * The structural signal: is this document framed? It can only ever answer `embedded` or
 * `standalone` — a native shell's web view makes the app the top frame, so it reads as
 * `standalone`, which is why the declared `hosty_launch` parameter exists at all.
 *
 * This stays the input to the *recovery* decision, because framing is a structural fact a
 * declared value cannot override: a stale `embedded` must not select frame-only silent sign-in.
 */
export function detectLaunchMode(
  win: Pick<Window, "self" | "top">,
): Exclude<AppLaunchMode, "native"> {
  try {
    return win.self !== win.top ? "embedded" : "standalone";
  } catch {
    // A cross-origin `top` access can throw in exotic embeddings; being framed is the only
    // way that happens, so classify it as embedded.
    return "embedded";
  }
}

export interface LaunchModeResolution {
  mode: AppLaunchMode;
  /** True when the mode came from the URL parameter, and so is worth persisting for this tab. */
  fromParam: boolean;
}

/**
 * Resolves the launch mode with explicit precedence: the URL parameter a shell just sent, then
 * the value persisted for this tab, then the structural heuristic.
 *
 * An unrecognized parameter value is ignored rather than honoured or stored — a newer shell must
 * degrade an older app to its previous behavior, never to a mode it cannot render.
 */
export function resolveLaunchMode(input: {
  param?: string | null;
  stored?: string | null;
  heuristic: AppLaunchMode;
}): LaunchModeResolution {
  const declared = normalizeLaunchMode(input.param);
  if (declared) {
    return { mode: declared, fromParam: true };
  }

  const stored = normalizeLaunchMode(input.stored);
  return { mode: stored ?? input.heuristic, fromParam: false };
}

/**
 * True when a shell around this app already renders its name and page navigation, so the app's
 * own copies are duplication. False for `standalone`, where nothing else renders them.
 */
export function hidesAppChrome(mode: AppLaunchMode): boolean {
  return mode !== "standalone";
}

/**
 * The pre-hydration bootstrap: sets the root attribute from the same precedence
 * `resolveLaunchMode` implements, so chrome that a shell duplicates is never painted before
 * React can hide it. Mount it as an inline `<script>` in the document head.
 *
 * It deliberately does not clean the parameter out of the URL — that is `HostLaunchBridge`'s
 * job, on the same reasoning the theme bridges clean theirs from an effect rather than from
 * their bootstrap: a `history.replaceState` before hydration is a router's business, not a
 * paint-blocking script's.
 */
export const launchModeBootstrapScript = `
(() => {
  const attribute = ${JSON.stringify(LAUNCH_MODE_ATTRIBUTE)};
  const storageKey = ${JSON.stringify(LAUNCH_MODE_STORAGE_KEY)};
  const known = ["embedded", "native", "standalone"];
  const normalize = (value) => (known.indexOf(value) >= 0 ? value : null);
  try {
    const param = normalize(new URLSearchParams(window.location.search).get(${JSON.stringify(LAUNCH_MODE_PARAM)}));
    let stored = null;
    try {
      stored = normalize(window.sessionStorage.getItem(storageKey));
    } catch {}
    let heuristic;
    try {
      heuristic = window.self !== window.top ? "embedded" : "standalone";
    } catch {
      heuristic = "embedded";
    }
    document.documentElement.setAttribute(attribute, param || stored || heuristic);
    if (param) {
      try {
        window.sessionStorage.setItem(storageKey, param);
      } catch {}
    }
  } catch {}
})();
`;

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
  //
  // `embedded` selects app-owned interactive recovery after the bridge's silent first-load path.
  // `native` deliberately falls through to the
  // redirect beside `standalone`: a native shell's web view has no parent, and the redirect to
  // Core's `/open` is the navigation that client watches for to re-mint a launch code. Adding a
  // mode must never quietly add a case here — a mode that cannot reach a shell has to redirect.
  if (mode === "embedded") {
    return { kind: "post-auth-required", intent: createAuthRequiredIntent(appId) };
  }
  if (openUrl && !redirectAlreadyAttempted) {
    return { kind: "redirect", openUrl };
  }
  return { kind: "card", card: "signin" };
}
