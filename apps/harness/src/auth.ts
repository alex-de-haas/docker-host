import type { IncomingMessage } from "node:http";
import { validateDelegatedToken, type DelegatedTokenClaims } from "@hosty-sdk/app/delegated";
import { readIdentityCookie, resolveAppSession } from "./app-session.js";

// Operator sessions are admin-only by decision (docs/features/ai-gateway/plan.md, Execution
// Profiles): the profile's enforcement boundary is who can hold a session at all, so every API
// route requires a delegated token whose actor carries the host.admin role. Validation is fully
// local (Core-injected public key); a missing key or a non-admin actor both read as "no access".
const ADMIN_ROLE = "host.admin";

/**
 * Who may call this gateway's API.
 *
 * Two shapes, because there are two clients and they are not interchangeable:
 *
 * - the **Shell assistant panel** presents a delegated token. It has always done so, and Shell mints
 *   these for it to run the chat — that is the panel's whole authentication story.
 * - the **settings page** presents this app's own Hosty session cookie, like every other embedded
 *   Hosty page. It used to use a delegated token too, which made this app the one that authenticated
 *   differently from all the others; the cost showed up as soon as the page was embedded somewhere
 *   the token handshake was not answered.
 *
 * Both must resolve to a host administrator. That is not re-decided here: Core refuses to mint
 * either credential for a non-admin on a system app, so this check is the app agreeing with a rule
 * it does not own.
 */
export async function resolveAdminActor(request: IncomingMessage): Promise<AdminActor | null> {
  const delegated = resolveAdmin(request);
  if (delegated) {
    return { userId: delegated.sub, expiresAtSeconds: delegated.exp, via: "delegated-token" };
  }

  // Only the "active" arm carries an identity, so a failed resolution cannot be mistaken for an
  // anonymous-but-present one. Narrowed in its own statement because the union discriminates on
  // `status` and TypeScript will not carry that through a compound condition here.
  const session = await resolveAppSession(readIdentityCookie(request));
  if (session.status !== "active") {
    return null;
  }

  return session.identity.hostRole === ADMIN_ROLE
    ? { userId: session.identity.userId, expiresAtSeconds: null, via: "app-session" }
    : null;
}

/**
 * Whether the browser says this request came from this app's own origin.
 *
 * Needed because an app session is an **ambient** credential: the browser attaches the cookie to
 * every request to this origin, including one a page on another site caused. The cookie is
 * deliberately `SameSite=None` — an embedded page is cross-site to Shell whenever Hosty is served
 * over https, and a lax cookie would simply not arrive — so the browser's own filter is not in
 * play here. CORS does not close the gap either: a plain HTML form post needs no permission to be
 * *sent*, and a caller who only wants the side effect never has to read the reply. A delegated
 * token is not ambient; it has to be read and attached, which a cross-site page cannot do.
 *
 * Either signal is enough, and accepting either is not a weakening: a cross-site caller can forge
 * neither. `Sec-Fetch-Site` is the browser's own comparison and survives a proxy that rewrote
 * `Host`; the `Origin`/`Host` match covers a browser too old to send it. Absent both, the answer is
 * no — a request carrying an ambient credential with no provenance at all is exactly the shape
 * being refused.
 */
export function isSameOriginRequest(request: IncomingMessage): boolean {
  const site = readHeader(request, "sec-fetch-site");
  if (site === "same-origin") {
    return true;
  }

  const origin = readHeader(request, "origin");
  const host = readHeader(request, "host");
  if (!origin || !host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first ? first.trim() : null;
}

export type AdminActor = {
  userId: string;
  /**
   * When the presented credential dies, for the event stream that must not outlive it. Null for an
   * app session, whose lifetime is the cookie's and is re-checked on every request rather than
   * pinned at stream start — so a stream opened on one has its own bound, below.
   */
  expiresAtSeconds: number | null;
  via: "delegated-token" | "app-session";
};

export function resolveAdmin(request: IncomingMessage): DelegatedTokenClaims | null {
  const authorization = request.headers.authorization;
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const claims = validateDelegatedToken(authorization.slice("bearer ".length).trim());
  if (!claims || claims.role !== ADMIN_ROLE) {
    return null;
  }

  return claims;
}
