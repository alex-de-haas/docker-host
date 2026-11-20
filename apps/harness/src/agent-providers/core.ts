import { AgentApiError, type AgentCapabilities, type AgentConnectionUsage, type AgentModelCatalog,
  type AgentOperationAuthorization, type AgentProviderRef } from "@hosty-sdk/app/agent";
import { AgentClient, readAgentHistoryPage, readAgentHistoryRange, readAgentHistoryStates, watchAgentHistory, watchLiveAgentHistory } from "@hosty-sdk/app/agent/client";

import type { AgentConsumerAuthority, AgentDirectoryBackend, AgentProviderEntry } from "./types.js";

export type CoreAgentOptions = {
  coreOrigin: string; appId: string; serviceToken: string; runningInContainer?: boolean; fetch?: typeof fetch;
};

/** Core sees the consumer credential; the provider sees only an exact-operation credential. */
export class CoreAgentBackend implements AgentDirectoryBackend {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: CoreAgentOptions) { this.fetcher = options.fetch ?? globalThis.fetch; }

  private async core<T>(suffix: string, authority: AgentConsumerAuthority | null, body?: unknown, signal?: AbortSignal): Promise<T> {
    const actor = await authority?.();
    if (authority && !actor) throw new AgentApiError("actor_required", "Sign in through Core before using an agent provider.", 401);
    const task = typeof actor === "string" ? undefined : actor;
    const input = task && body !== undefined ? { ...body as Record<string, unknown>, authority: task } : body;
    const response = await this.fetcher(new URL(`/api/internal/apps/${encodeURIComponent(this.options.appId)}${suffix}`, this.options.coreOrigin), {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${this.options.serviceToken}`, ...(typeof actor === "string" ? { "X-Hosty-User-Token": actor } : {}),
        "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!authority && response.status === 404 && !response.headers.get("content-type")?.includes("json")) {
      await response.body?.cancel();
      throw new AgentApiError("history_unsupported", "Core does not expose installation history.", 404);
    }
    const result = await response.json() as T & { error?: { code?: string; message?: string }; code?: string; message?: string };
    if (!response.ok) throw new AgentApiError(result.error?.code ?? result.code ?? "core_agent_unavailable",
      result.error?.message ?? result.message ?? "Core could not authorize this provider operation.", response.status, response.status >= 500);
    return result;
  }

  async providers(authority: AgentConsumerAuthority): Promise<AgentProviderEntry[]> {
    const result = await this.core<{ providers: Array<{ appId: string; installationId?: string | null; key: string;
      displayName: string; available: boolean; version: number | null }> }>("/providers/agent", authority);
    return result.providers.filter(provider => Boolean(provider.installationId)).map(provider => ({
      ref: { appId: provider.appId, installationId: provider.installationId!, key: provider.key },
      displayName: provider.displayName, available: provider.available && provider.version === 1,
      ...(provider.version !== 1 ? { reason: "This provider does not support agent interface v1." } : {}),
    }));
  }

  client(provider: AgentProviderRef, authority: AgentConsumerAuthority, conversation?: { sessionId: string; viewerPath: string; title: string }): AgentClient {
    return new AgentClient({ provider, fetch: this.fetcher, authorize: async (request, signal) => {
      const authorization = await this.core<AgentOperationAuthorization>("/agent/authorize", authority, { provider, ...request,
        ...(request.operation === "runs.start" && conversation ? { conversation } : {}) }, signal);
      const url = new URL(authorization.baseUrl);
      if (this.options.runningInContainer && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        url.hostname = "host.docker.internal";
      return { ...authorization, baseUrl: url.href.replace(/\/$/, "") };
    } });
  }

  async historyOptions(provider: AgentProviderRef, signal: AbortSignal) {
    const grant = await this.core<{ token: string; endpoint: string }>("/agent/history/token", null, { provider }, signal);
    const base = new URL(grant.endpoint);
    if (this.options.runningInContainer && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
      base.hostname = "host.docker.internal";
    base.pathname = base.pathname.replace(/\/$/, "") + "/history/events";
    return { url: base.href, provider, token: grant.token, fetch: this.fetcher };
  }

  async liveHistory(provider: AgentProviderRef, signal: AbortSignal, grant?: Awaited<ReturnType<CoreAgentBackend["historyOptions"]>>) {
    const options = grant ?? await this.historyOptions(provider, signal);
    const pageSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    return {
      observe: (cursor: string | undefined, onReady: (boundary: string) => Promise<void>, streamSignal: AbortSignal) =>
        watchLiveAgentHistory({ ...options, cursor, onReady, signal: streamSignal }),
      states: (through: string, afterSession?: string) =>
        readAgentHistoryStates({ ...options, through, afterSession, limit: 64, signal: pageSignal() }),
      range: (through: string, sessionId: string, epoch: string, from: number, to: number) =>
        readAgentHistoryRange({ ...options, through, sessionId, epoch, from, to, limit: 64, signal: pageSignal() }),
    };
  }

  async *history(provider: AgentProviderRef, cursor: string | undefined, signal: AbortSignal, onCatchUp: () => void,
    onOpen: () => Promise<void>, grant?: Awaited<ReturnType<CoreAgentBackend["historyOptions"]>>) {
    const options = grant ?? await this.historyOptions(provider, signal);
    try {
      let through: string | undefined, position = cursor;
      do {
        const page = await readAgentHistoryPage({ ...options, cursor: position, through, limit: 64,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        through = page.through;
        for (const observation of page.observations) yield { ...observation, replayed: true };
        position = page.nextCursor ?? undefined;
      } while (position);
      onCatchUp(); // The installation supports history and its stable page boundary has committed.
      signal.throwIfAborted();
      const handshake = new AbortController();
      const timer = setTimeout(() => handshake.abort(new DOMException("Provider stream handshake timed out.", "TimeoutError")), 15000);
      try {
        yield* watchAgentHistory({ ...options, cursor: through, signal: AbortSignal.any([signal, handshake.signal]),
          onOpen: async () => { clearTimeout(timer); await onOpen(); } });
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error instanceof AgentApiError && (error.status === 404 && ["provider_failed", "route_not_found", "unknown_route"].includes(error.code)
        || error.status === 422 && error.code === "unsupported_operation"))
        throw new AgentApiError("history_unsupported", "The selected provider does not expose installation history.", 404);
      throw error;
    }
  }

  async connections(provider: AgentProviderRef, authority: AgentConsumerAuthority) {
    const client = this.client(provider, authority), capabilities = await client.capabilities();
    const connections = []; let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.connections({ cursor, limit: 100 });
      for (const connection of page.connections) connections.push({
        id: connection.id, revision: connection.revision, name: connection.name, available: connection.ready,
        ...(connection.reason ? { reason: connection.reason } : {}),
        capabilities: [...new Set([...capabilities.capabilities, ...(connection.capabilities ?? [])])],
      });
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new AgentApiError("provider_response_invalid", "Provider account pagination did not advance.", 502);
      if (cursor) cursors.add(cursor);
      if (connections.length > 10000) throw new AgentApiError("provider_budget_exceeded", "Provider account inventory exceeds the supported budget.", 413);
    } while (cursor);
    return connections;
  }
  capabilities(provider: AgentProviderRef, authority: AgentConsumerAuthority): Promise<AgentCapabilities> {
    return this.client(provider, authority).capabilities();
  }
  models(provider: AgentProviderRef, id: string, authority: AgentConsumerAuthority): Promise<AgentModelCatalog> {
    return this.client(provider, authority).models(id);
  }
  usage(provider: AgentProviderRef, id: string, authority: AgentConsumerAuthority): Promise<AgentConnectionUsage> {
    return this.client(provider, authority).connectionUsage(id);
  }

}
