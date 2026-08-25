import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenExchange, toMcpServerConfig, serverName } from "./exchange.js";
import type { McpProvider } from "../settings/providers.js";

// The gateway half of the delegated-token exchange: turning enabled providers into MCP servers the
// harness can actually call. Core is stubbed at `fetch`, because what is being tested here is the
// gateway's selection and shaping — Core's own bounds have their own HTTP suite.

const CORE = "http://core.test";
const GATEWAY = "hosty.ai-gateway";
const PROXY = { baseUrl: "http://gw.test", sessionId: "session-1", key: "session-key" };

function provider(appId: string, overrides: Partial<McpProvider> = {}): McpProvider {
  const url = `http://${appId}/api/mcp`;
  return { appId, displayName: appId, url, running: true, interfaces: [{ key: "default", url }], ...overrides };
}

function stubCore(handler: (targetAppId: string) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const target = decodeURIComponent(url.split("/api/apps/")[1]!.split("/")[0]!);
    return handler(target);
  });
}

function issued(token: string, expiresInMs = 300_000): Response {
  return new Response(
    JSON.stringify({ token, expiresAt: new Date(Date.now() + expiresInMs).toISOString() }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("token exchange", () => {
  it("builds one server per enabled provider, each with its own token", async () => {
    stubCore((target) => issued(`token-for-${target}`));
    const exchange = new TokenExchange(CORE, GATEWAY);

    const servers = await exchange.buildServers(
      "seed",
      [provider("com.example.notes"), provider("com.example.other")],
      { "com.example.notes": true, "com.example.other": true },
    );

    // Per-app tokens, not one shared credential: that is the entire point of the audience claim.
    expect(servers.map((s) => s.appId).sort()).toEqual(["com.example.notes", "com.example.other"]);
    expect(servers.find((s) => s.appId === "com.example.notes")?.token).toBe("token-for-com.example.notes");
    expect(servers.find((s) => s.appId === "com.example.other")?.token).toBe("token-for-com.example.other");
  });

  it("offers only what can actually be called", async () => {
    // Disabled, stopped, and URL-less providers are absent — and so is one whose exchange is refused.
    // Handing the model a tool that cannot work is worse than not handing it one: the failure then
    // surfaces mid-task as a confusing error instead of as a capability the agent never had.
    stubCore((target) =>
      target === "com.example.refused" ? new Response("no", { status: 403 }) : issued(`t-${target}`),
    );
    const exchange = new TokenExchange(CORE, GATEWAY);

    const servers = await exchange.buildServers(
      "seed",
      [
        provider("com.example.enabled"),
        provider("com.example.disabled"),
        provider("com.example.stopped", { running: false }),
        provider("com.example.nourl", { url: null }),
        provider("com.example.refused"),
      ],
      {
        "com.example.enabled": true,
        "com.example.disabled": false,
        "com.example.stopped": true,
        "com.example.nourl": true,
        "com.example.refused": true,
      },
    );

    expect(servers.map((s) => s.appId)).toEqual(["com.example.enabled"]);
  });

  it("self-refresh asks for its own audience, which is what keeps the right to branch", async () => {
    const targets: string[] = [];
    stubCore((target) => {
      targets.push(target);
      return issued("renewed");
    });

    const renewed = await new TokenExchange(CORE, GATEWAY).refreshSelf("seed");

    expect(renewed?.token).toBe("renewed");
    expect(targets).toEqual([GATEWAY]);
  });

  it("reports nothing rather than throwing when Core is unreachable", async () => {
    // A discovery or exchange failure must degrade the session, never end it: the agent keeps its
    // host tools and simply has no app MCP.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const exchange = new TokenExchange(CORE, GATEWAY);

    expect(await exchange.exchange("seed", "com.example.notes")).toBeNull();
    expect(await exchange.buildServers("seed", [provider("com.example.notes")], { "com.example.notes": true }))
      .toEqual([]);
  });

  it("is inert without a Core origin", async () => {
    const exchange = new TokenExchange(null, GATEWAY);
    expect(exchange.available).toBe(false);
    expect(await exchange.exchange("seed", "com.example.notes")).toBeNull();
  });

  it("names servers so the model can tell which app a tool belongs to", () => {
    // A client namespaces tools by server name — `list_apps` on a server called `hosty` arrives as
    // `mcp__hosty__list_apps` — so the name is what the model reads, and it must survive the
    // sanitizing that dots would otherwise break.
    const config = toMcpServerConfig(
      [{ appId: "com.example.notes", url: "http://notes/api/mcp", token: "t", expiresAtMs: 0 }],
      PROXY,
    );

    const [name] = Object.keys(config);
    expect(name).toMatch(/^com-example-notes-[0-9a-f]{6}$/);
    expect(config[name!]).toEqual({
      type: "http",
      url: "http://gw.test/internal/mcp/session-1/com.example.notes",
      headers: { authorization: "Bearer session-key" },
    });
  });

  it("points the harness at the proxy, never at the app, and carries no delegated token", () => {
    // The whole point of the proxy (docs/features/delegated-token-exchange/plan.md): MCP server
    // headers are static for the life of a connection, so a five-minute token placed here is dead
    // before a long turn ends and cannot be replaced for a call already paused on an approval.
    const config = toMcpServerConfig(
      [{ appId: "com.example.notes", url: "http://notes/api/mcp", token: "secret-token", expiresAtMs: 0 }],
      PROXY,
    );

    const entry = Object.values(config)[0]!;
    expect(entry.url).not.toContain("notes/api/mcp");
    expect(JSON.stringify(entry)).not.toContain("secret-token");
  });

  it("keeps two apps distinct when their ids sanitize to the same string", () => {
    // App ids may legally carry both dots and hyphens, so `com.example.notes` and
    // `com-example-notes` collide once dots are replaced. Silently dropping one provider is the worst
    // failure available to a security-relevant toggle: the operator enables it and nothing says no.
    expect(serverName("com.example.notes")).not.toBe(serverName("com-example-notes"));
    // An already-safe id keeps its plain, readable name — the model sees this string.
    expect(serverName("com-example-notes")).toBe("com-example-notes");

    const config = toMcpServerConfig(
      [
        { appId: "com.example.notes", url: "http://a/api/mcp", token: "a", expiresAtMs: 0 },
        { appId: "com-example-notes", url: "http://b/api/mcp", token: "b", expiresAtMs: 0 },
      ],
      PROXY,
    );
    expect(Object.keys(config)).toHaveLength(2);
  });
});
