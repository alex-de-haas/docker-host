import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpProxy, type MintedToken } from "./proxy.js";

// The proxy is driven over real sockets against a real upstream, because the properties that matter
// are transport-level: which credential the app actually receives, when it is minted, and what a
// caller sees when the chain has run out. A mocked fetch would assert the shape of a call the
// harness never makes.

const APP = "com.example.notes";
const SESSION = "session-1";

interface UpstreamCall {
  authorization: string | undefined;
  method: string;
  body: string;
}

describe("per-session MCP proxy", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let calls: UpstreamCall[];
  let respond: (request: IncomingMessage, response: ServerResponse, body: string) => void;

  let proxyServer: Server;
  let proxyOrigin: string;

  /** Tokens the minter will hand out, in order; a null entry is a refused (lapsed) chain. */
  let minted: (MintedToken | null)[];
  let mintCalls: string[];
  let proxy: McpProxy;
  let sessionKey: string;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${proxyOrigin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      ...init,
    });
  }

  /** Registers the session and keeps the key `call()` will present. */
  function register(targets = [{ appId: APP, url: `${upstreamUrl}/api/mcp` }]): void {
    sessionKey = proxy.register(SESSION, targets);
  }

  beforeEach(async () => {
    calls = [];
    respond = (_request, response, body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    };
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({
          authorization: request.headers.authorization,
          method: request.method ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        respond(request, response, JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }));
      });
    });
    upstreamUrl = await listen(upstream);

    minted = [];
    mintCalls = [];
    proxy = new McpProxy(async (sessionId, appId) => {
      mintCalls.push(`${sessionId}:${appId}`);
      // Length-checked rather than `?? fallback`: a queued null IS the refusal under test, and `??`
      // would quietly turn it back into a working token.
      return minted.length > 0
        ? (minted.shift() ?? null)
        : { token: "fallback", expiresAtMs: Date.now() + 300_000 };
    });

    proxyServer = createServer((request, response) => {
      void proxy
        .handle(request, response, new URL(request.url ?? "/", "http://p.local").pathname)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404).end();
          }
        });
    });
    proxyOrigin = await listen(proxyServer);
  });

  afterEach(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => proxyServer.close(resolve));
  });

  it("mints at request time, so a call released long after it was prepared still carries a live token", async () => {
    // The defect this feature exists for: a call paused on an approval is bound to the connection it
    // was prepared on, so re-minting into the harness config reaches the next call and never that
    // one. Here the harness's credential never changes — the session key — while the token the app
    // receives is obtained as the request goes out.
    register();
    minted = [
      // Already stale when the second call is made, exactly as a five-minute token is after an
      // operator has thought about an approval for six minutes.
      { token: "token-at-connect", expiresAtMs: Date.now() + 300_000 },
      { token: "token-at-release", expiresAtMs: Date.now() + 300_000 },
    ];

    await call(`/internal/mcp/${SESSION}/${APP}`);
    // Age the cached token past the reuse margin without waiting: re-register with a seed that is
    // about to expire, which is what a real five-minute token looks like by release time.
    proxy.register(
      SESSION,
      [{ appId: APP, url: `${upstreamUrl}/api/mcp` }],
      new Map([[APP, { token: "token-at-connect", expiresAtMs: Date.now() + 1_000 }]]),
    );
    await call(`/internal/mcp/${SESSION}/${APP}`);

    expect(calls.map((entry) => entry.authorization)).toEqual([
      "Bearer token-at-connect",
      "Bearer token-at-release",
    ]);
  });

  it("reuses a token that is still comfortably alive", async () => {
    // The mint is a Core round trip; doing it per request when the cached token has minutes left
    // would put Core back in the data path this design keeps it out of.
    register();
    await call(`/internal/mcp/${SESSION}/${APP}`);
    await call(`/internal/mcp/${SESSION}/${APP}`);

    expect(mintCalls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("forwards the body and the response untouched", async () => {
    register();
    const response = await call(`/internal/mcp/${SESSION}/${APP}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    expect(JSON.parse(calls[0]!.body)).toEqual({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  });

  it("never forwards the caller's own credential", async () => {
    // The session key authorizes the hop into the proxy and must not travel onward: the app's
    // audience check is against a Core-signed delegated token, and passing anything else through
    // would be a second, unaudited credential arriving at an app endpoint.
    register();
    await call(`/internal/mcp/${SESSION}/${APP}`);

    expect(calls[0]!.authorization).toBe("Bearer fallback");
  });

  it("refuses an unknown session, an unknown app, and a wrong key identically", async () => {
    register();
    const wrongKey = await call(`/internal/mcp/${SESSION}/${APP}`, {
      headers: { authorization: "Bearer not-the-key", "content-type": "application/json" },
      body: "{}",
    });
    const unknownSession = await call(`/internal/mcp/other-session/${APP}`);
    const unknownApp = await call(`/internal/mcp/${SESSION}/com.example.other`);

    for (const response of [wrongKey, unknownSession, unknownApp]) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("proxy_unauthorized");
    }
    // Nothing reached the app, and nothing was minted for a caller that could not prove itself.
    expect(calls).toHaveLength(0);
    expect(mintCalls).toHaveLength(0);

    // The permitted call belongs in this test, not only in the ones above: a proxy that refused
    // every request would satisfy the three assertions above exactly as a working gate does.
    expect((await call(`/internal/mcp/${SESSION}/${APP}`)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("stops serving a session once it is unregistered", async () => {
    register();
    proxy.unregister(SESSION);

    expect((await call(`/internal/mcp/${SESSION}/${APP}`)).status).toBe(401);
  });

  it("answers a lapsed chain as a JSON-RPC error the model can act on", async () => {
    // Degradation is the point: the operator has not spoken for an hour, so no token can be minted.
    // A transport failure would reach the model as "the tool is broken"; a JSON-RPC error carries a
    // sentence telling it what to ask for.
    register();
    minted = [null];

    const response = await call(`/internal/mcp/${SESSION}/${APP}`);
    const body = (await response.json()) as { id: number; error: { code: number; message: string } };

    expect(response.status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/operator/i);
    expect(calls).toHaveLength(0);
  });

  it("reports an unreachable app as a bad gateway rather than as its own failure", async () => {
    // The gateway is fine and the session is fine; one hop is not. 502 keeps that distinction, so a
    // stopped app reads as a tool failing rather than as the assistant breaking.
    register([{ appId: APP, url: "http://127.0.0.1:1/api/mcp" }]);

    const response = await call(`/internal/mcp/${SESSION}/${APP}`);

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("proxy_upstream_unreachable");
  });

  it("keeps the key stable across a re-register, so a policy change does not drop live connections", async () => {
    const first = proxy.register(SESSION, [{ appId: APP, url: `${upstreamUrl}/api/mcp` }]);
    const second = proxy.register(SESSION, [
      { appId: APP, url: `${upstreamUrl}/api/mcp` },
      { appId: "com.example.other", url: `${upstreamUrl}/api/mcp` },
    ]);

    expect(second).toBe(first);
  });

  it("drops cached tokens for a target that is no longer offered", async () => {
    // A provider switched off must stop being callable immediately. Leaving its token cached would
    // keep it working until the token happened to expire.
    register();
    await call(`/internal/mcp/${SESSION}/${APP}`);
    proxy.register(SESSION, []);

    expect((await call(`/internal/mcp/${SESSION}/${APP}`)).status).toBe(401);
  });

  it("streams an SSE response instead of holding it until the stream closes", async () => {
    // A streamable-HTTP app answers tool calls over SSE. Buffering the body would delay every event
    // until the stream ended, which for a long-running tool is never.
    respond = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      // Left open on purpose: the assertion below must succeed before the stream ends.
      setTimeout(() => response.end(), 2_000).unref();
    };
    register();

    const response = await call(`/internal/mcp/${SESSION}/${APP}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("first");
    await reader.cancel();
  });

  it("answers malformed percent-encoding with a 404 rather than an unhandled 500", async () => {
    // This is a public HTTP surface and `decodeURIComponent` throws on an unpaired `%`, so an
    // ordinary bad request must not arrive as an internal error.
    register();

    const response = await fetch(`${proxyOrigin}/internal/mcp/%E0%A4%A/${APP}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionKey}` },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("proxy_not_found");
  });

  it("does not put a deadline on a stream that has already started", async () => {
    // The response timeout bounds getting headers out of the app, never the body: aborting after the
    // stream is established truncates a long tool result and drops a streamable-HTTP SSE channel on a
    // fixed cycle. Driven with a 100 ms timeout and a chunk sent well after it, which is the same
    // shape as a two-minute timeout and a five-minute tool call.
    proxy = new McpProxy(async () => ({ token: "t", expiresAtMs: Date.now() + 300_000 }), 100);
    register();
    respond = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: opened\n\n");
      setTimeout(() => {
        response.write("data: late\n\n");
        response.end();
      }, 300);
    };

    const response = await call(`/internal/mcp/${SESSION}/${APP}`);
    const received = await new Response(response.body).text();

    expect(received).toContain("data: late");
  });

  it("leaves a path that is not its own to the rest of the router", async () => {
    const response = await fetch(`${proxyOrigin}/api/sessions`);
    expect(response.status).toBe(404);
  });
});
