// Embedder slice: the shell half of the contracts an embedded app cannot serve itself, for
// anything that embeds Hosty apps in iframes (Hosty Shell or a third-party UI client). Pure
// functions plus a small rate limiter — the embedder wires them to its own DOM, its own "open
// this app" flow, and its own Core session.
//
// Recovery, in one sentence: on a VERIFIED `hosty:auth-required` from an app you embed,
// re-run your normal open flow for that app (which mints a fresh launch code), rate-limited.
// The re-open must take the full launch-code path — an "already open → reuse the URL
// without a code" optimization must not short-circuit recovery.
//
// Delegated tokens, in one sentence: on a VERIFIED `hosty:request-delegated-token` from an app
// you have decided to grant one, mint a token from Core with your own session and post it back
// to that frame's origin. Both requests are unauthenticated by design; what makes them safe is
// that the embedder answers from facts about its own DOM rather than from what the frame claims.

import { AUTH_REQUIRED_INTENT_TYPE, DELEGATED_TOKEN_REQUEST_TYPE } from "./index";

/** The three fields of a `message` event these parsers read. */
export interface EmbedderMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

export type AuthRequiredMessage = EmbedderMessage;

/**
 * Verifies that a `message` event is a genuine auth-required intent from the active app
 * frame. Every check is about facts only the embedder can know:
 * - `event.source` must be the active iframe's `contentWindow` (not some other frame);
 * - `event.origin` must match the frame URL's origin (the app itself, not an inner frame);
 * - the payload's `appId` must match the app the embedder actually mounted there.
 * No credential crosses the boundary in either direction: the payload is only the app id,
 * and the embedder answers by reissuing a code through its own authenticated Core call.
 */
export function parseActiveFrameAuthRequired(
  event: AuthRequiredMessage,
  activeFrameWindow: unknown,
  activeFrameUrl: string,
  expectedAppId: string,
): boolean {
  if (!isActiveFrameMessage(event, activeFrameWindow, activeFrameUrl)) {
    return false;
  }

  const candidate = event.data as { type?: unknown; appId?: unknown };
  return (
    candidate.type === AUTH_REQUIRED_INTENT_TYPE &&
    typeof candidate.appId === "string" &&
    candidate.appId === expectedAppId
  );
}

/**
 * Verifies that a `message` event is a delegated-token request from the active app frame, using
 * the same sender checks as `parseActiveFrameAuthRequired`. There is nothing app-specific in the
 * payload to check — and nothing to gain from one, since a frame's claim about which app it is
 * would be the weakest fact in the room next to the embedder's own DOM.
 *
 * A true result says only *who asked*, never *whether to answer*. Answering hands the frame a
 * user-scoped credential, so the embedder decides per app which ones it grants — Hosty Shell
 * answers for the assistant gateway alone, the app it already mints delegated tokens for, so the
 * handshake gives that app nothing it did not already hold. Wiring this responder to every frame
 * would silently widen the delegated-token trust story to whatever an operator installed.
 */
export function parseActiveFrameDelegatedTokenRequest(
  event: EmbedderMessage,
  activeFrameWindow: unknown,
  activeFrameUrl: string,
): boolean {
  if (!isActiveFrameMessage(event, activeFrameWindow, activeFrameUrl)) {
    return false;
  }

  return (event.data as { type?: unknown }).type === DELEGATED_TOKEN_REQUEST_TYPE;
}

/** The sender half both parsers share: right frame, right origin, object payload. */
function isActiveFrameMessage(
  event: EmbedderMessage,
  activeFrameWindow: unknown,
  activeFrameUrl: string,
): boolean {
  if (!activeFrameWindow || event.source !== activeFrameWindow) {
    return false;
  }

  try {
    if (event.origin !== new URL(activeFrameUrl).origin) {
      return false;
    }
  } catch {
    return false;
  }

  return Boolean(event.data) && typeof event.data === "object" && !Array.isArray(event.data);
}

/**
 * Per-app reissue throttle: a frame that keeps re-posting (e.g. it never accepts the new
 * code) must not drive an unbounded reissue storm. One reissue per app per interval is
 * plenty for recovery — Hosty Shell ships 3000ms.
 */
export function createReissueRateLimiter(minIntervalMs: number, now: () => number = Date.now) {
  const lastReissueAt = new Map<string, number>();
  return {
    /** True when a reissue for this app is allowed now; records the attempt when allowed. */
    tryAcquire(appId: string): boolean {
      const at = now();
      const last = lastReissueAt.get(appId);
      if (last !== undefined && at - last < minIntervalMs) {
        return false;
      }
      lastReissueAt.set(appId, at);
      return true;
    },
  };
}
