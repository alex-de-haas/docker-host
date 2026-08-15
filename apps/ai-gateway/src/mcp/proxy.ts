// A per-session MCP proxy, so a five-minute credential stops being visible to the harness.
//
// The problem it removes (docs/features/delegated-token-exchange/plan.md): an MCP server config
// carries *static* headers, so whichever token was baked in when the run started is the token every
// later call presents. Re-minting into the config was implemented and **verified live not to work** —
// a call paused on an approval is bound to the connection it was prepared on, so replacing server
// configuration reaches the next call and never that one. An operator who thinks for longer than five
// minutes then releases a call carrying a dead credential, which is exactly the pause an approval
// gate exists to allow.
//
// The shape: the harness is handed a loopback URL on the gateway itself plus a per-session key that
// does not expire while the session lives. Each request through it obtains a delegated token for the
// target app *at the moment the request goes out*, so the TTL becomes a property of the hop the
// gateway makes and never of the connection the harness holds.
//
// This is deliberately a transparent forwarder rather than a JSON-RPC re-implementation: an app may
// serve plain POST JSON-RPC (demo-app does) or full streamable HTTP with SSE and `Mcp-Session-Id`,
// and the proxy has no business knowing which.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Same ceiling the operator API uses; an MCP request body is orders of magnitude smaller. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How close to expiry a cached token may be and still be reused. Distinct from the exchange's own
 * refresh margin despite the equal value: this one asks "could the call this token is about to carry
 * outlive it", which is a question about one request rather than about a session's chain.
 */
const TOKEN_REUSE_MARGIN_MS = 60_000;

/** Upstream app hop. Generous: a tool call may legitimately do real work. */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** The path the harness is pointed at. */
export const PROXY_PATH_PREFIX = "/internal/mcp/";

/** Headers forwarded verbatim to the app. Everything else — above all the caller's own
 * `authorization` — is dropped, because the credential the app sees is minted here. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/** Headers copied back. `mcp-session-id` matters: a streamable-HTTP client correlates on it. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "mcp-session-id"];

export interface ProxyTarget {
  appId: string;
  /** The app's resolved MCP URL, as Core reported it. */
  url: string;
}

export interface MintedToken {
  token: string;
  expiresAtMs: number;
}

/** Obtains a token for `appId` on behalf of `sessionId`, or null when the chain has run out. */
export type TokenMinter = (sessionId: string, appId: string) => Promise<MintedToken | null>;

interface Registration {
  key: string;
  targets: Map<string, ProxyTarget>;
  tokens: Map<string, MintedToken>;
}

export class McpProxy {
  private readonly sessions = new Map<string, Registration>();

  constructor(private readonly mint: TokenMinter) {}

  /**
   * Points the session at `targets` and returns the key the harness will present.
   *
   * The key is stable for the life of the session: a provider toggle rewrites the target list, and
   * re-keying there would break every MCP connection the harness already holds for providers that
   * were not touched. Tokens already minted for targets that survive are kept for the same reason —
   * they are still valid, and discarding them would spend a Core round trip to learn that.
   */
  register(sessionId: string, targets: readonly ProxyTarget[], seed?: ReadonlyMap<string, MintedToken>): string {
    const existing = this.sessions.get(sessionId);
    const registration: Registration = existing ?? {
      key: randomBytes(32).toString("base64url"),
      targets: new Map(),
      tokens: new Map(),
    };

    registration.targets = new Map(targets.map((target) => [target.appId, target]));
    for (const appId of [...registration.tokens.keys()]) {
      if (!registration.targets.has(appId)) {
        registration.tokens.delete(appId);
      }
    }
    for (const [appId, token] of seed ?? []) {
      if (registration.targets.has(appId)) {
        registration.tokens.set(appId, token);
      }
    }

    this.sessions.set(sessionId, registration);
    return registration.key;
  }

  /** Drops the session's routes and every token cached for it. */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Serves a proxy request. Returns false when the path is not ours, so the caller can carry on
   * routing — the proxy owns one prefix and nothing else.
   */
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith(PROXY_PATH_PREFIX)) {
      return false;
    }

    // Loopback only, and worth being precise about what that does and does not buy. The harness is a
    // child process of this gateway, so nothing else legitimately needs a route in, and this app's
    // endpoint is `public: true` — its port is reachable on the host's network. What it does NOT stop
    // is a request arriving through the Cloudflare tunnel: `cloudflared` runs on the host and routes a
    // public hostname straight at this port, so such a request presents as loopback. The per-session
    // key is therefore the gate; this check narrows the direct-network path, and nothing more.
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { code: "proxy_forbidden", message: "The MCP proxy is reachable from loopback only." });
      return true;
    }

    const segments = pathname.slice(PROXY_PATH_PREFIX.length).split("/");
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      sendJson(response, 404, { code: "proxy_not_found", message: "Unknown proxy route." });
      return true;
    }

    const sessionId = decodeURIComponent(segments[0]);
    const appId = decodeURIComponent(segments[1]);
    const registration = this.sessions.get(sessionId);
    const target = registration?.targets.get(appId);

    // One answer for an unknown session, an unknown app, and a wrong key. They are distinguishable
    // to an attacker only if the gateway distinguishes them, and the caller can act on none of them.
    if (!registration || !target || !keyMatches(registration.key, readBearer(request))) {
      sendJson(response, 401, { code: "proxy_unauthorized", message: "Unknown session, app, or key." });
      return true;
    }

    let body: Buffer | undefined;
    if (request.method === "POST") {
      body = await readBody(request);
      if (!body) {
        sendJson(response, 413, { code: "payload_too_large", message: `Body exceeds ${MAX_BODY_BYTES} bytes.` });
        return true;
      }
    }

    const token = await this.tokenFor(sessionId, registration, appId);
    if (!token) {
      sendChainExpired(response, body);
      return true;
    }

    await this.forward(request, response, target, token.token, body);
    return true;
  }

  /** Cached until it is close enough to expiry that a call could outlive it; re-minted otherwise. */
  private async tokenFor(
    sessionId: string,
    registration: Registration,
    appId: string,
  ): Promise<MintedToken | null> {
    const cached = registration.tokens.get(appId);
    if (cached && cached.expiresAtMs - TOKEN_REUSE_MARGIN_MS > Date.now()) {
      return cached;
    }

    const minted = await this.mint(sessionId, appId);
    if (!minted) {
      // Keep nothing: a refused mint means the chain lapsed, and a stale token would only turn a
      // clear "the delegation expired" into an authorization error from the app.
      registration.tokens.delete(appId);
      return null;
    }

    registration.tokens.set(appId, minted);
    return minted;
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    target: ProxyTarget,
    token: string,
    body: Buffer | undefined,
  ): Promise<void> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") {
        headers[name] = value;
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(target.url, {
        method: request.method ?? "POST",
        headers,
        ...(body && body.length > 0 ? { body } : {}),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      // The app is unreachable or too slow. 502 rather than 500: the gateway is fine, the hop is not,
      // and the harness should read this as the tool failing rather than the session breaking.
      sendJson(response, 502, {
        code: "proxy_upstream_unreachable",
        message: `The app ${target.appId} did not answer its MCP endpoint.`,
      });
      return;
    }

    const outgoing: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        outgoing[name] = value;
      }
    }
    response.writeHead(upstream.status, outgoing);

    if (!upstream.body) {
      response.end();
      return;
    }

    // Piped rather than buffered: a streamable-HTTP app answers with SSE, and buffering it would
    // hold every event until the stream closed — which for a long tool call is never.
    try {
      await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), response);
    } catch {
      // The client hung up, or the app's stream broke mid-flight. The status line is already out, so
      // there is nothing to report but the end of the body.
      response.end();
    }
  }
}

/**
 * The chain has run out: the operator has not spoken for an hour, so nothing can mint a token for
 * this app until they do.
 *
 * Answered as a JSON-RPC error when the request carried an id, so the model reads a sentence telling
 * it what to ask for instead of a transport failure it can only report as broken.
 */
function sendChainExpired(response: ServerResponse, body: Buffer | undefined): void {
  const message =
    "This agent session's delegation has expired. Ask the operator to send a message in the session, " +
    "which renews it, then retry.";
  const id = readRequestId(body);
  if (id === undefined) {
    sendJson(response, 503, { code: "delegation_expired", message });
    return;
  }

  sendJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32001, message } });
}

function readRequestId(body: Buffer | undefined): string | number | null | undefined {
  if (!body || body.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body.toString("utf8")) as { id?: unknown };
    // A notification has no id and must not be answered with a response object.
    return typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null
      ? (parsed.id as string | number | null)
      : undefined;
  } catch {
    return undefined;
  }
}

function keyMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) {
    return false;
  }

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  // Node reports an IPv4 loopback peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function readBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : undefined;
}

/** Returns undefined when the body exceeds the ceiling, which the caller reports as 413. */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
