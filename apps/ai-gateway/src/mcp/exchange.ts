// Turning enabled MCP providers into something a harness can call.
//
// The gateway holds a delegated token whose audience is itself. To reach another app it trades that
// token for one scoped to the target (docs/features/delegated-token-exchange/plan.md). Two properties
// of the exchange shape this file:
//
//   * **Branch, never refresh a branched token.** A token minted for a domain app cannot be exchanged
//     again — its audience is not a system app — so a fresh app credential always comes from
//     branching off the gateway's own token, not from renewing the app one.
//   * **The chain expires an hour after the human interaction it descends from.** Self-refresh keeps
//     the gateway's own credential alive inside that hour; past it, the operator has to say something
//     before the agent can reach apps again. That is the bound, not a bug to work around.

import { createHash } from "node:crypto";
import type { McpProvider } from "../settings/providers.js";
import { PROXY_PATH_PREFIX } from "./proxy.js";

/** Refreshed a little before the five-minute token actually expires, so no call lands on a dead one. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface ExchangedServer {
  appId: string;
  url: string;
  token: string;
  expiresAtMs: number;
}

interface IssuedToken {
  token: string;
  expiresAt: string;
}

export class TokenExchange {
  constructor(
    private readonly coreOrigin: string | null,
    private readonly appId: string,
  ) {}

  get available(): boolean {
    return this.coreOrigin !== null;
  }

  /**
   * Trades `presented` for a token scoped to `targetAppId`. Returns null on any refusal — an expired
   * chain, a target the actor may not reach, Core being unreachable — because every one of those
   * means the same thing to the caller: this provider is not available for this session right now.
   * The distinction is Core's to record in its audit, not the gateway's to reinterpret.
   */
  async exchange(presented: string, targetAppId: string): Promise<IssuedToken | null> {
    if (!this.coreOrigin) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.coreOrigin}/api/apps/${encodeURIComponent(targetAppId)}/delegated-token`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${presented}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
      return typeof body.token === "string" && typeof body.expiresAt === "string"
        ? { token: body.token, expiresAt: body.expiresAt }
        : null;
    } catch {
      return null;
    }
  }

  /** Keeps the gateway's own credential alive without branching, so it stays able to branch. */
  refreshSelf(presented: string): Promise<IssuedToken | null> {
    return this.exchange(presented, this.appId);
  }

  /**
   * Builds one entry per enabled, running provider that a token could be obtained for.
   *
   * A provider that is stopped, has no resolved URL, or whose exchange is refused is simply absent:
   * offering the model a tool that cannot work is worse than not offering it, because the failure
   * surfaces mid-task as a confusing error rather than as a capability the agent never had.
   */
  async buildServers(
    presented: string,
    providers: readonly McpProvider[],
    enabled: Readonly<Record<string, boolean>>,
  ): Promise<ExchangedServer[]> {
    const wanted = providers.filter(
      (provider) => enabled[provider.appId] === true && provider.running && provider.url,
    );

    const issued = await Promise.all(
      wanted.map(async (provider) => {
        const token = await this.exchange(presented, provider.appId);
        return token
          ? {
              appId: provider.appId,
              url: provider.url!,
              token: token.token,
              expiresAtMs: new Date(token.expiresAt).getTime(),
            }
          : null;
      }),
    );

    return issued.filter((entry): entry is ExchangedServer => entry !== null);
  }
}

/**
 * A readable, collision-free server name. App ids may legally contain both dots and hyphens, so
 * `com.example.notes` and `com-example-notes` sanitize to the same string — and one provider would
 * then silently overwrite the other, which is the worst possible failure for a security-relevant
 * toggle. A short digest of the original id is appended whenever sanitizing changed anything, so
 * distinct apps stay distinct while an already-safe id keeps its plain name.
 */
export function serverName(appId: string): string {
  const safe = appId.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (safe === appId) {
    return safe;
  }
  return `${safe}-${createHash("sha256").update(appId).digest("hex").slice(0, 6)}`;
}

/**
 * The harness-facing shape: server name to HTTP config. Names are the app id with dots replaced,
 * because a client namespaces tools by server name — a stock client turns `list_apps` on a server
 * called `hosty` into `mcp__hosty__list_apps`, so the name is what the model sees and it should read
 * as the app it belongs to.
 *
 * The URL is the gateway's own per-session proxy, never the app, and the header carries the session
 * key rather than a delegated token. MCP server headers are static for the life of a connection, so
 * a five-minute token placed here dies mid-session and cannot be replaced for a call already paused
 * on an approval — see mcp/proxy.ts. The key outlives the session; the token is minted per request
 * on the far side.
 */
export function toMcpServerConfig(
  servers: readonly ExchangedServer[],
  proxy: { baseUrl: string; sessionId: string; key: string },
): Record<string, { type: "http"; url: string; headers: Record<string, string> }> {
  const config: Record<string, { type: "http"; url: string; headers: Record<string, string> }> = {};
  for (const server of servers) {
    config[serverName(server.appId)] = {
      type: "http",
      url: proxyUrl(proxy.baseUrl, proxy.sessionId, server.appId),
      headers: { authorization: `Bearer ${proxy.key}` },
    };
  }
  return config;
}

/** Both segments are encoded: an app id may legally contain characters a path segment may not. */
export function proxyUrl(baseUrl: string, sessionId: string, appId: string): string {
  return `${baseUrl.replace(/\/$/, "")}${PROXY_PATH_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(appId)}`;
}
