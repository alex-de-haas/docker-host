// Translating the gateway's MCP server map into what Codex actually accepts.
//
// The shape is not inferred from documentation — it was read back out of the binary by letting
// `codex mcp add --url … --bearer-token-env-var …` write its own config (0.147.0, 2026-08-19):
//
//   [mcp_servers.<name>]
//   url = "http://…"
//   bearer_token_env_var = "SOME_ENV_VAR"
//
// Passed as `-c` overrides rather than written to a file, so the operator's own ~/.codex/config.toml
// is never touched: these servers belong to one session of one gateway, not to the machine.
//

// The token travels in the environment because that is the only place Codex will read it from —
// there is no arbitrary-header option as the Claude side has. That is also the better shape here: a
// per-session proxy key stays out of any config file, and out of `codex mcp list`.

import { createHash } from "node:crypto";

/** The Claude-shaped entry the gateway already builds for every harness. */
type HttpServer = { type?: unknown; url?: unknown; headers?: Record<string, unknown> };

export interface CodexMcpConfig {
  /** `-c key=value` pairs, in the order they must be passed. */
  args: string[];
  /** Bearer tokens, keyed by the env var each server's config names. */
  env: Record<string, string>;
}

/**
 * A deterministic, valid environment-variable name for one server.
 *
 * Derived from the server name rather than counted, so the same server keeps the same variable
 * across restarts — a counter would renumber servers when one is toggled off and make a stale
 * variable point at the wrong app.
 *
 * A digest is appended whenever sanitizing changed anything, for the same reason `serverName` does
 * it one level up: server names legally contain both `-` and `_`, so `a-b` and `a_b` would otherwise
 * share a variable and one app's token would silently become another's. That is the worst failure
 * available here, since the token is what scopes a call to one app.
 */
export function tokenEnvVar(serverName: string): string {
  const safe = serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const suffix = safe === serverName.toUpperCase()
    ? ""
    : `_${createHash("sha256").update(serverName).digest("hex").slice(0, 6).toUpperCase()}`;
  return `HOSTY_MCP_BEARER_${safe}${suffix}`;
}

/**
 * Builds Codex's MCP configuration, skipping anything it cannot express.
 *
 * A server is skipped rather than half-configured: Codex reads only `url` and a bearer from the
 * environment, so an entry with no usable URL or no bearer would register a server that fails on
 * first call. Absent is honest; broken is not.
 */
export function toCodexMcpConfig(servers: Record<string, unknown> | undefined): CodexMcpConfig {
  const args: string[] = [];
  const env: Record<string, string> = {};
  if (!servers) {
    return { args, env };
  }

  for (const [name, raw] of Object.entries(servers)) {
    const server = raw as HttpServer | null;
    const url = typeof server?.url === "string" ? server.url : null;
    if (!url) {
      continue;
    }

    // The gateway's own entries always carry one; a hand-written provider might not, and an
    // unauthenticated call to the proxy is refused rather than anonymous.
    const authorization = readHeader(server?.headers, "authorization");
    const bearer = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      continue;
    }

    // A dotted server name would be read as a nested table by `-c`'s dotted path. The gateway's
    // `serverName` already replaces dots, so this is a guard against a future caller rather than a
    // live case — and skipping is right, because quoting is not something the override parser is
    // documented to accept.
    if (name.includes(".") || name.includes("=")) {
      continue;
    }

    const variable = tokenEnvVar(name);
    args.push("-c", `mcp_servers.${name}.url=${toToml(url)}`);
    args.push("-c", `mcp_servers.${name}.bearer_token_env_var=${toToml(variable)}`);
    env[variable] = bearer;
  }

  return { args, env };
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** TOML basic strings and JSON strings agree for everything a URL or an identifier can contain. */
function toToml(value: string): string {
  return JSON.stringify(value);
}
