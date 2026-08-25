import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpFacade } from "./facade.js";
import { ProviderDirectory } from "../settings/providers.js";
import { SettingsStore } from "../settings/store.js";

// Driven over real sockets against a fake Core and a fake app, for the reason the proxy's suite
// records: what matters here is transport-level — which credential each hop actually receives, and
// what a client sees when a hop refuses. A mocked fetch would assert the shape of calls nobody makes.

const APP = "com.example.notes";
const GATEWAY = "hosty.ai-gateway";
const SERVICE_TOKEN = "hosty_app_service.1.a.b";

interface CoreCall {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

describe("MCP facade", () => {
  let core: Server;
  let coreOrigin: string;
  let coreCalls: CoreCall[];
  /** Whether Core says the presented credential is live. */
  let credentialActive: boolean;
  /** Whether Core will mint an on-behalf-of token for the app. */
  let mintAllowed: boolean;
  /** The interface key the fake Core reports for the app's `mcp` declaration. */
  let interfaceKey: string;

  let app: Server;
  let appUrl: string;
  let appCalls: Array<{ method: string; authorization: string | undefined; params: unknown }>;

  let facadeServer: Server;
  let facadeOrigin: string;
  let dataDir: string;
  let settings: SettingsStore;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  function json(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  }

  /** One JSON-RPC request to the facade. */
  function rpc(method: string, params?: unknown, token: string | null = "hostyat_client"): Promise<Response> {
    return fetch(`${facadeOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
  }

  beforeEach(async () => {
    coreCalls = [];
    appCalls = [];
    credentialActive = true;
    mintAllowed = true;
    interfaceKey = "default";

    core = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://core.local").pathname;
        const body = request.method === "POST" ? await readJson(request) : {};
        coreCalls.push({ path, authorization: request.headers.authorization, body });

        if (path.endsWith("/token/introspect")) {
          json(response, 200, credentialActive
            ? { active: true, sub: "user_1", role: "host.admin", scopes: ["mcp:read"] }
            : { active: false, sub: null, role: null, scopes: [] });
          return;
        }
        if (path.endsWith("/delegated-token")) {
          if (!mintAllowed) {
            json(response, 403, { code: "app_access_denied" });
            return;
          }
          json(response, 200, {
            token: `delegated-for-${String(body.targetAppId)}`,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
          return;
        }
        if (path.endsWith("/app-directory")) {
          json(response, 200, {
            apps: [
              {
                id: APP,
                displayName: "Notes",
                runtimeState: "running",
                interfaces: [{ name: "mcp", key: interfaceKey, url: `${appUrl}/api/mcp` }],
              },
            ],
          });
          return;
        }
        json(response, 404, { code: "not_found" });
      })();
    });
    coreOrigin = await listen(core);

    app = createServer((request, response) => {
      void (async () => {
        const body = await readJson(request);
        appCalls.push({
          method: String(body.method),
          authorization: request.headers.authorization,
          params: body.params,
        });

        if (body.method === "initialize") {
          json(response, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
          return;
        }
        if (body.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (body.method === "tools/list") {
          json(response, 200, {
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                {
                  name: "list_people",
                  description: "Lists people.",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
                // No hint at all: possibly mutating, so it must not be offered.
                { name: "delete_person", description: "Deletes.", inputSchema: { type: "object" } },
              ],
            },
          });
          return;
        }
        json(response, 200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"people\":[]}" }] } });
      })();
    });
    appUrl = await listen(app);

    dataDir = await mkdtemp(join(tmpdir(), "hosty-facade-test-"));
    settings = new SettingsStore(dataDir);
    await settings.update({ mcpProviders: { [APP]: true } });

    const facade = new McpFacade(
      { coreOrigin, serviceToken: SERVICE_TOKEN, appId: GATEWAY, coreMcpUrl: null },
      new ProviderDirectory(coreOrigin, SERVICE_TOKEN, GATEWAY),
      settings,
    );
    facadeServer = createServer((request, response) => {
      void facade.handle(request, response, new URL(request.url ?? "/", "http://f.local").pathname).then((handled) => {
        if (!handled) {
          response.writeHead(404).end();
        }
      });
    });
    facadeOrigin = await listen(facadeServer);
  });

  afterEach(async () => {
    for (const server of [core, app, facadeServer]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("offers only the tools an app declares read-only, named as the connector names them", async () => {
    const response = await rpc("tools/list");
    const body = (await response.json()) as { result: { tools: Array<{ name: string; description: string }> } };

    // `delete_person` declares no hint, which means "we do not know what this does" — and an unknown
    // tool is not offered while external clients are read-only.
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["com_dexample_dnotes__list_people"]);
    // The app it belongs to travels with it: a model choosing between similar tools from two apps
    // has nothing else to go on.
    expect(body.result.tools[0]?.description).toContain("[Notes]");
  });

  it("carries the client's credential to Core and the minted one to the app, never the other way", async () => {
    const response = await rpc("tools/call", { name: "com_dexample_dnotes__list_people", arguments: {} });
    expect(response.status).toBe(200);

    // Core saw the client's own credential, with the tool named so the call lands in Hosty's audit.
    const introspection = coreCalls.filter((call) => call.path.endsWith("/token/introspect"));
    expect(introspection.length).toBeGreaterThan(0);
    expect(introspection[0]?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect((introspection[0]?.body as { token: string }).token).toBe("hostyat_client");
    expect(introspection.some((call) => (call.body as { tool?: string }).tool === "com_dexample_dnotes__list_people")).toBe(true);

    // The app saw a delegated token minted for it, and never the client's credential.
    const call = appCalls.find((entry) => entry.method === "tools/call");
    expect(call?.authorization).toBe(`Bearer delegated-for-${APP}`);
    expect(appCalls.every((entry) => entry.authorization !== "Bearer hostyat_client")).toBe(true);
    // Called by the app's own name for the tool, not the namespaced one the client used.
    expect((call?.params as { name: string }).name).toBe("list_people");
  });

  it("refuses a name the catalog does not carry, so a cached list cannot reach a filtered tool", async () => {
    const response = await rpc("tools/call", { name: "com_dexample_dnotes__delete_person", arguments: {} });
    const body = (await response.json()) as { error?: { message: string } };

    expect(body.error?.message).toContain("read-only");
    // Nothing reached the app at all: the refusal is the facade's, not a hope that the app declines.
    expect(appCalls.some((entry) => entry.method === "tools/call")).toBe(false);
  });

  it("distinguishes a credential Core rejected from a Core it could not reach", async () => {
    // The pair a client turns into two different behaviours: re-authenticate, or retry later.
    credentialActive = false;
    expect((await rpc("tools/list")).status).toBe(401);

    await new Promise<void>((resolve) => core.close(() => resolve()));
    expect((await rpc("tools/list")).status).toBe(503);
  });

  it("requires a credential at all, and says so the way an MCP client expects", async () => {
    const response = await rpc("tools/list", undefined, null);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("a catalog that has gone stale can offer a name, and can never make a refused call succeed", async () => {
    // The exact hazard the per-user catalog cache introduces, asserted rather than argued: the
    // listing is remembered for a few seconds, so a user who loses access in that window is still
    // *offered* the tool. What must not happen is the call going through — every call re-mints, and
    // that is where Core says no.
    await rpc("tools/list");
    mintAllowed = false;

    const response = await rpc("tools/call", { name: "com_dexample_dnotes__list_people", arguments: {} });
    const body = (await response.json()) as { error?: { message: string } };

    // Named, because "this app would not have you" and "no such tool" call for different responses
    // from a model.
    expect(body.error?.message).toContain(APP);
    expect(appCalls.some((entry) => entry.method === "tools/call")).toBe(false);
  });

  it("answers initialize with instructions that speak for the host before any app does", async () => {
    const response = await rpc("initialize");
    const body = (await response.json()) as { result: { instructions?: string; serverInfo: { name: string } } };

    expect(body.result.serverInfo.name).toBe(GATEWAY);
    expect(body.result.instructions).toContain("read-only");
    // No app skill is approved here, so nothing but the host's own text is present — an app must
    // never be able to appear above it.
    expect(body.result.instructions?.startsWith("You are connected to a Hosty host.")).toBe(true);
  });

  it("names a non-default interface the way the connector does", async () => {
    // The key is part of the exported name for anything but `default`. Discovery dropped it, so
    // every tool of an `admin` interface was offered as `app__tool` — a name no client rule written
    // against `hosty mcp` would match, which defeats the whole point of porting the scheme.
    interfaceKey = "admin";
    const response = await rpc("tools/list");
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };

    expect(body.result.tools.map((tool) => tool.name)).toEqual(["com_dexample_dnotes__admin__list_people"]);
  });

  it("keeps Core's tools when app discovery fails", async () => {
    // A transient app-directory failure costs the apps. Core's URL is configured independently and
    // its tools stay reachable — collapsing the two emptied the catalog over one timeout.
    const facade = new McpFacade(
      { coreOrigin, serviceToken: SERVICE_TOKEN, appId: GATEWAY, coreMcpUrl: `${appUrl}/api/mcp` },
      // A directory pointed at nothing: read() answers null, exactly as an unreachable Core does.
      new ProviderDirectory("http://127.0.0.1:1", SERVICE_TOKEN, GATEWAY),
      settings,
    );
    const server = createServer((request, response) => {
      void facade.handle(request, response, "/mcp");
    });
    const origin = await listen(server);

    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer hostyat_client" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.length).toBeGreaterThan(0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers 413 for an oversized body rather than calling it a parse error", async () => {
    // Well-formed bytes, too many of them. A client fixes that differently from malformed JSON, and
    // cannot tell the two apart if both come back as -32700.
    const response = await fetch(`${facadeOrigin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer hostyat_client" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } }),
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("exceeds");
  });

  it("refuses a flood before it reaches Core, so a junk credential is cheap to refuse", async () => {
    // This endpoint is meant to be publicly exposed, and Core writes an audit line for every
    // inactive credential presented — so an unauthenticated flood would spend the host's disk and
    // I/O. The limiter has to sit ahead of introspection for that to be true, which is what the
    // call count asserts.
    credentialActive = false;
    let refused = 0;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await rpc("tools/list", undefined, "hostyat_junk");
      if (response.status === 429) {
        refused += 1;
      }
    }

    expect(refused).toBeGreaterThan(0);
    // The refused ones never became Core round trips.
    expect(coreCalls.filter((call) => call.path.endsWith("/token/introspect")).length).toBeLessThan(80);
  });

  it("serves its resource metadata when published, and challenges with it on a bare 401", async () => {
    // The facade's whole OAuth role: a pointer at Core. Without a public origin the pointer would
    // name a URL nothing serves, so its absence is a 404 and the challenge stays bare.
    const withoutOrigin = await fetch(`${facadeOrigin}/.well-known/oauth-protected-resource/mcp`);
    expect(withoutOrigin.status).toBe(404);

    process.env.HOSTY_PUBLIC_ORIGIN_HTTP = "https://assistant.example.test";
    process.env.HOSTY_CORE_PUBLIC_ORIGIN = "https://core.example.test";
    try {
      const published = await fetch(`${facadeOrigin}/.well-known/oauth-protected-resource/mcp`);
      expect(published.status).toBe(200);
      const body = (await published.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe("https://assistant.example.test/mcp");
      expect(body.authorization_servers).toEqual(["https://core.example.test"]);

      const challenged = await rpc("tools/list", undefined, null);
      expect(challenged.status).toBe(401);
      expect(challenged.headers.get("www-authenticate")).toContain(
        "https://assistant.example.test/.well-known/oauth-protected-resource/mcp",
      );
    } finally {
      delete process.env.HOSTY_PUBLIC_ORIGIN_HTTP;
      delete process.env.HOSTY_CORE_PUBLIC_ORIGIN;
    }
  });

  it("offers nothing from a provider the operator has not enabled", async () => {
    await settings.update({ mcpProviders: {} });
    // A fresh facade, because the catalog is cached per user for a few seconds by design.
    const facade = new McpFacade(
      { coreOrigin, serviceToken: SERVICE_TOKEN, appId: GATEWAY, coreMcpUrl: null },
      new ProviderDirectory(coreOrigin, SERVICE_TOKEN, GATEWAY),
      settings,
    );
    const server = createServer((request, response) => {
      void facade.handle(request, response, "/mcp");
    });
    const origin = await listen(server);

    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer hostyat_client" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
