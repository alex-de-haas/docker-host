// Core-authorized MCP access. An app session identifies the user; the assistant's service token
// identifies the caller. Core's explicit assistant-target relationship supplies authority and
// yields a distinct MCP-only target token. Legacy seeds can renew themselves but Core refuses
// cross-app branching through the old delegated endpoint.

import { createHash } from "node:crypto";
import { CORE_PROVIDER_ID, type McpProvider } from "../settings/providers.js";
import { PROXY_PATH_PREFIX } from "./proxy.js";

/** The server Core's tools appear under, so a call reads as `mcp__hosty-core__list_apps`. */
export const CORE_SERVER_NAME = "hosty-core";

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

export class CoreTemporarilyUnavailable extends Error {
  constructor() { super("Core is temporarily unavailable; retry after it reconnects."); }
}

export class TokenExchange {
  constructor(
    private readonly coreOrigin: string | null,
    private readonly appId: string,
    private readonly serviceToken: string | null = null,
  ) {}

  get available(): boolean {
    return this.coreOrigin !== null;
  }

  /**
   * Trades `presented` for a token scoped to `targetAppId`. Returns null on a credential or policy refusal. A transient
   * Core outage throws CoreTemporarilyUnavailable so callers retain the credential and routes.
   */
  async exchange(presented: string, targetAppId: string, sessionId?: string): Promise<IssuedToken | null> {
    const appSession = presented.startsWith("hostyg_");
    if (sessionId && !appSession) return null;
    if (!this.coreOrigin || (appSession && !this.serviceToken)) {
      return null;
    }

    try {
      const response = await fetch(
        appSession ? `${this.coreOrigin}/api/internal/apps/${encodeURIComponent(this.appId)}/mcp/token`
          : `${this.coreOrigin}/api/apps/${encodeURIComponent(targetAppId)}/delegated-token`,
        {
          method: "POST",
          headers: appSession ? { authorization: `Bearer ${this.serviceToken}`, "X-Hosty-User-Token": presented, "content-type": "application/json" }
            : { authorization: `Bearer ${presented}` },
          ...(appSession ? { body: JSON.stringify({ targetAppId, sessionId }) } : {}),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.status === 429 || response.status >= 500) throw new CoreTemporarilyUnavailable();
      if (!response.ok) return null;
      const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
      return typeof body.token === "string" && typeof body.expiresAt === "string"
        ? { token: body.token, expiresAt: body.expiresAt }
        : null;
    } catch {
      // A network outage is not a revoked delegation. Keep the session credential and tools;
      // the manager retries refresh and the proxy reports a retryable unavailable response.
      throw new CoreTemporarilyUnavailable();
    }
  }

  /** Revalidates the app session, or renews a same-audience legacy credential within its lifetime cap. */
  async refreshSelf(presented: string): Promise<IssuedToken | null> {
    if (!presented.startsWith("hostyg_")) return this.exchange(presented, this.appId);
    if (!this.coreOrigin || !this.serviceToken) return null;
    const response = await fetch(`${this.coreOrigin}/api/auth/apps/revalidate`, {
      method: "POST", headers: { authorization: `Bearer ${this.serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ accessToken: presented }), signal: AbortSignal.timeout(5_000),
    }).catch(() => { throw new CoreTemporarilyUnavailable(); });
    if (response.status === 429 || response.status >= 500) throw new CoreTemporarilyUnavailable();
    if (!response.ok) return null;
    const value = await response.json() as { active?: boolean; expiresAt?: string };
    return value.active === true ? { token: presented, expiresAt: value.expiresAt ?? new Date(Date.now() + 60_000).toISOString() } : null;
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
    sessionId?: string,
  ): Promise<ExchangedServer[]> {
    const wanted = providers.filter(
      (provider) => enabled[provider.appId] === true && provider.running && provider.url,
    );

    const issued = await Promise.all(
      wanted.map(async (provider) => {
        const token = await this.exchange(presented, provider.appId, sessionId);
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
  if (appId === CORE_PROVIDER_ID) {
    return CORE_SERVER_NAME;
  }
  const safe = appId.replace(/[^a-zA-Z0-9_-]/g, "-");
  // An already-safe id keeps its plain name — unless it spells the one name reserved above, which an
  // app id legally can and must not be able to take: the grant set is keyed on these names.
  if (safe === appId && safe !== CORE_SERVER_NAME) {
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
