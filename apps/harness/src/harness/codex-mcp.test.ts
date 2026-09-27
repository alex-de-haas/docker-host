import { describe, expect, it } from "vitest";
import { toCodexMcpConfig, tokenEnvVar } from "./codex-mcp.js";

const server = (url: string, bearer?: string) => ({
  type: "http",
  url,
  ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
});

describe("toCodexMcpConfig", () => {
  it("writes the shape Codex itself produces", () => {
    // Asserted against what `codex mcp add --url … --bearer-token-env-var …` wrote to config.toml on
    // 0.147.0, not against documentation: `url` and `bearer_token_env_var` under `mcp_servers.<name>`.
    const { args, env } = toCodexMcpConfig({ "demo-app": server("http://127.0.0.1:7100/mcp", "proxy-key") });

    expect(args).toEqual([
      "-c",
      'mcp_servers.demo-app.url="http://127.0.0.1:7100/mcp"',
      "-c",
      `mcp_servers.demo-app.bearer_token_env_var="${tokenEnvVar("demo-app")}"`,
    ]);
    // The token is in the environment, never in an argument: arguments are world-readable in a
    // process listing, and `codex mcp list` prints the config.
    expect(env).toEqual({ [tokenEnvVar("demo-app")]: "proxy-key" });
    expect(tokenEnvVar("demo-app")).toBe("HOSTY_MCP_BEARER_DEMO_APP_529260");
    expect(args.join(" ")).not.toContain("proxy-key");
  });

  it("skips a credential Codex cannot express, rather than passing it through", () => {
    // Codex always sends `Authorization: Bearer <value>`, so forwarding a Basic credential as the
    // value registers a server that fails on its first call — which looks like the app being broken.
    const { args, env } = toCodexMcpConfig({
      basic: { type: "http", url: "http://x/mcp", headers: { authorization: "Basic dXNlcjpwdw==" } },
    });
    expect(args).toEqual([]);
    expect(env).toEqual({});
  });

  it("skips a server it could only configure half of", () => {
    // Registering a server that fails on its first call is worse than not registering it: the model
    // sees a tool, tries it, and the failure looks like the app being broken.
    const { args, env } = toCodexMcpConfig({
      "no-bearer": server("http://127.0.0.1:7100/mcp"),
      "no-url": { type: "http", headers: { authorization: "Bearer k" } },
    });
    expect(args).toEqual([]);
    expect(env).toEqual({});
  });

  it("skips a name that `-c` would read as a nested table", () => {
    // `-c` splits on dots, so `mcp_servers.com.haas.app.url` would nest rather than name one server.
    // The gateway's own `serverName` already replaces dots; this guards a future caller.
    const { args } = toCodexMcpConfig({ "com.haas.demo-app": server("http://x/mcp", "k") });
    expect(args).toEqual([]);
  });

  it("names the variable from the server, so it survives a restart unchanged", () => {
    // A counter would renumber servers when one is toggled off, pointing a stale variable at another
    // app's token.
    expect(tokenEnvVar("demo-app")).toBe(tokenEnvVar("demo-app"));
    // Server names legally contain both, and sanitizing collapses them: without a digest one app's
    // token would silently become another's, which is the whole point of the per-app scoping.
    expect(tokenEnvVar("a-b")).not.toBe(tokenEnvVar("a_b"));
    expect(tokenEnvVar("plain")).toBe("HOSTY_MCP_BEARER_PLAIN");
  });

  it("is empty for a harness started with no providers", () => {
    expect(toCodexMcpConfig(undefined)).toEqual({ args: [], env: {} });
  });
});
