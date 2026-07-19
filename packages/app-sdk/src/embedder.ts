// Embedder slice: the shell half of the recovery contract, for anything that embeds Hosty
// apps in iframes (Hosty Shell or a third-party UI client). Pure functions plus a small
// rate limiter — the embedder wires them to its own DOM and its own "open this app" flow.
//
// The contract in one sentence: on a VERIFIED `hosty:auth-required` from an app you embed,
// re-run your normal open flow for that app (which mints a fresh launch code), rate-limited.
// The re-open must take the full launch-code path — an "already open → reuse the URL
// without a code" optimization must not short-circuit recovery.

import { AUTH_REQUIRED_INTENT_TYPE } from "./index.ts";

export interface AuthRequiredMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

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

  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
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
