"use client";

// The app half of the delegated-token handshake.
//
// The panel needs this even though the gateway serves the page and a session cookie already proves
// who the operator is. The reason is not authentication: the token the panel presents becomes the
// **session's delegation seed** (`SessionManager.postMessage`), which the gateway branches per
// enabled MCP provider. A cookie-only panel would leave `session.credential` null and every app-MCP
// call would be skipped — the chat would work and the agent would silently have no app tools.
//
// So the credential still belongs to the operator, minted by Core for their identity, and this app
// only ever holds a short-TTL copy. The alternative — the gateway minting user-scoped tokens for
// itself — is the "token, not proxy" rule the bridge design is built on.

const REQUEST_TYPE = "hosty:request-delegated-token";
const GRANT_TYPE = "hosty:delegated-token";
const REQUEST_TIMEOUT_MS = 5_000;
/** Re-asked this long before expiry, so a turn never starts on a token about to lapse. */
const RENEW_MARGIN_MS = 30_000;

type Grant = { token: string; expiresAt: number };

let cached: Grant | null = null;
let inflight: Promise<Grant | null> | null = null;

/**
 * Asks the embedder for a token, once per outstanding request.
 *
 * Answering is the embedder's decision, not this page's right: Shell answers only for apps it
 * deliberately grants one. A page opened standalone has no embedder to ask, and the timeout is what
 * makes that case finite rather than a hang.
 */
function request(refresh: boolean): Promise<Grant | null> {
  if (typeof window === "undefined" || window.parent === window) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Grant | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      // The answer carries a credential, so an embedder posts it to this origin specifically. Only
      // the parent that was asked may answer, and only with the expected shape.
      if (event.source !== window.parent || event.origin === "null") {
        return;
      }
      const data = event.data as { type?: unknown; token?: unknown; expiresAt?: unknown } | null;
      if (!data || data.type !== GRANT_TYPE || typeof data.token !== "string") {
        return;
      }
      const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
      finish({ token: data.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60_000 });
    };

    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    // Broadcast is safe: the request carries no secret. The answer is what must be targeted.
    window.parent.postMessage(refresh ? { type: REQUEST_TYPE, refresh: true } : { type: REQUEST_TYPE }, "*");
  });
}

/**
 * The operator's current delegated token, or null when nothing will grant one.
 *
 * `refresh` is passed through rather than inferred: only this page learns that a token was refused,
 * and without saying so an embedder that caches its mints would keep answering with the very token
 * that just came back 401.
 */
export async function getDelegatedToken(refresh = false): Promise<string | null> {
  if (!refresh && cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  if (refresh) {
    cached = null;
  }

  inflight ??= request(refresh).finally(() => {
    inflight = null;
  });

  const grant = await inflight;
  if (grant) {
    cached = grant;
  }
  return grant?.token ?? null;
}
