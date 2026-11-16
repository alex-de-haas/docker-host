import type { AgentCapabilities, AgentConnectionUsage } from "@hosty-sdk/app/agent";
import type { ConnectionService } from "../connections/service.js";
import type { AgentConnection, ConnectionBinding, ConnectionDirectory, ConnectionHealth, ConnectionLogin, ConnectionModelCatalog } from "../connections/types.js";
import { ConnectionError } from "../connections/errors.js";
import type { HarnessAdapter, HarnessCapabilities } from "../harness/adapter.js";
import { absentUsage, type ProviderUsage } from "../harness/provider-usage.js";
import type { CoreAgentBackend } from "./core.js";
import { AgentConnectionDirectory, agentSelectionId, validAgentSelection } from "./directory.js";
import type { AgentConnectionSelection, AgentConsumerAuthority, DiscoveredAgentConnection } from "./types.js";

export type AgentConsumerConnectionsOptions = {
  directory: AgentConnectionDirectory;
  backend: Pick<CoreAgentBackend, "capabilities" | "models" | "usage">;
  authority: AgentConsumerAuthority;
  adapter: (selection: AgentConnectionSelection, capabilities: HarnessCapabilities, name: string) => HarnessAdapter;
};
const unavailableCapabilities = (): HarnessCapabilities => ({ questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false });
function consumerCapabilities(value: AgentCapabilities, entry: DiscoveredAgentConnection): HarnessCapabilities {
  const capabilities = new Set([...value.capabilities, ...(entry.capabilities ?? [])]);
  return {
    questions: capabilities.has("decisions.questions"),
    appMcp: capabilities.has("mcp.core") || capabilities.has("mcp.apps") || capabilities.has("mcp.external"),
    liveReconfigure: capabilities.has("runs.live-configure"),
    autoAllow: capabilities.has("decisions.auto-allow"),
    denyReason: capabilities.has("decisions.deny-reason"),
    promptSuggestions: capabilities.has("predictions"),
    ...(capabilities.has("connections.usage") ? { usage: { snapshots: true, events: false, kinds: ["quota", "credits", "rate_limit"] as const } } : {}),
  };
}
function view(entry: DiscoveredAgentConnection): AgentConnection & { available: boolean; reason?: string } {
  return { id: entry.id, name: entry.name, kind: "agent", revision: entry.revision, available: entry.available,
    ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.capabilities ? { capabilities: [...entry.capabilities] } : {}),
    provider: { ...entry.selection.provider, name: entry.providerName } };
}
function binding(entry: DiscoveredAgentConnection): ConnectionBinding {
  return { connectionId: entry.id, connectionRevision: entry.selection.connection.revision, harnessKind: "agent", selection: structuredClone(entry.selection) };
}
function providerOwned(): never {
  throw new ConnectionError(409, "provider_owned", "Manage this connection in its provider application's Settings entry in Shell.");
}
function usageProjection(value: AgentConnectionUsage): ProviderUsage {
  const data = value.data;
  // An optional telemetry endpoint can successfully explain that quotas do not apply or
  // this authentication mode cannot expose them without reporting available meter data.
  if (!value.available && !["unsupported", "not_applicable", "unavailable"].includes(String(data?.state)))
    return absentUsage("unavailable", "temporarily_unavailable");
  if (!data || !["available", "unavailable", "unsupported", "not_applicable"].includes(String(data.state))
    || !Array.isArray(data.rows) || data.observedAt !== null && typeof data.observedAt !== "string") return absentUsage();
  return structuredClone(data) as unknown as ProviderUsage;
}

/** Harness owns qualified preferences; provider applications own credentials, execution and capacity. */
export class AgentConsumerConnections implements ConnectionService {
  readonly remote = true;
  constructor(private readonly options: AgentConsumerConnectionsOptions) {}

  async list(): Promise<ConnectionDirectory> {
    const directory = await this.options.directory.list(this.options.authority);
    return { ...directory, connections: directory.connections.map(view) };
  }
  async get(id: string): Promise<AgentConnection> {
    return view(await this.options.directory.get(id, this.options.authority));
  }
  async binding(id?: unknown): Promise<ConnectionBinding | null> {
    if (id !== undefined && id !== null && typeof id !== "string") throw new ConnectionError(400, "provider_invalid", "Choose a current provider connection.");
    const selected = await this.options.directory.binding(id, this.options.authority);
    if (!selected) return null;
    return { connectionId: agentSelectionId(selected), connectionRevision: selected.connection.revision, harnessKind: "agent", selection: selected };
  }
  async setDefault(id: unknown): Promise<void> {
    if (id !== null && typeof id !== "string") throw new ConnectionError(400, "provider_invalid", "Choose a current provider connection.");
    await this.options.directory.setDefault(id, this.options.authority);
  }
  private qualified(value: ConnectionBinding): AgentConnectionSelection {
    if (!validAgentSelection(value.selection) || agentSelectionId(value.selection) !== value.connectionId
      || value.connectionRevision !== value.selection.connection.revision || value.harnessKind !== "agent")
      throw new ConnectionError(409, "provider_cutover_required", "This legacy conversation cannot run. Complete the documented clean cutover and create a new conversation with a current provider connection.");
    return value.selection;
  }
  private async current(value: ConnectionBinding): Promise<DiscoveredAgentConnection> {
    const selected = this.qualified(value);
    const entry = await this.options.directory.get(value.connectionId, this.options.authority);
    if (agentSelectionId(entry.selection) !== agentSelectionId(selected))
      throw new ConnectionError(409, "provider_connection_changed", "Select the current provider installation and account revision.");
    if (!entry.available) throw new ConnectionError(503, "provider_unavailable", entry.reason ?? "Provider connection is unavailable.");
    return entry;
  }
  async reserve(value: ConnectionBinding): Promise<() => void> {
    await this.current(value);
    // The provider claims the real account/capacity atomically when it admits a run.
    return () => {};
  }
  async adapter(value: ConnectionBinding): Promise<HarnessAdapter> {
    const entry = await this.current(value);
    const capabilities = await this.options.backend.capabilities(entry.selection.provider, this.options.authority);
    return this.options.adapter(structuredClone(entry.selection), consumerCapabilities(capabilities, entry), entry.providerName);
  }
  async health(value?: ConnectionBinding | null): Promise<ConnectionHealth> {
    try {
      const selected = value === undefined ? await this.binding() : value;
      if (!selected) return this.missing();
      const adapter = await this.adapter(selected);
      return { name: adapter.name, capabilities: { ...adapter.capabilities, appContext: true }, ...await adapter.probe() };
    } catch (error) { return this.missing(error instanceof Error ? error.message : "Provider is unavailable."); }
  }
  private missing(reason = "Choose a provider for this chat. Install and configure provider applications through Shell."): ConnectionHealth {
    return { name: "Agent providers", available: false, reason, capabilities: { ...unavailableCapabilities(), appContext: true } };
  }
  async summary(): Promise<ConnectionHealth> {
    const selected = await this.health();
    if (selected.available) return selected;
    for (const entry of (await this.options.directory.list(this.options.authority)).connections) {
      if (!entry.available) continue;
      const candidate = await this.health(binding(entry));
      if (candidate.available) return { ...candidate, name: "Agent providers" };
    }
    return selected;
  }
  async models(id: string): Promise<ConnectionModelCatalog> {
    const entry = await this.options.directory.get(id, this.options.authority);
    if (!entry.available) throw new ConnectionError(503, "provider_unavailable", entry.reason ?? "Provider connection is unavailable.");
    const catalog = await this.options.backend.models(entry.selection.provider, entry.selection.connection.id, this.options.authority);
    if (catalog.nextCursor) throw new ConnectionError(503, "catalog_unavailable", "This provider model catalog requires unsupported pagination.");
    return { revision: catalog.revision, ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
      models: catalog.models.map(model => ({ id: model.id, label: model.name ?? model.id,
        efforts: model.reasoningEfforts.filter((effort): effort is string => effort !== null).map(effort => ({ id: effort, label: effort })),
        ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
        ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}) })) };
  }
  async usage(id: string): Promise<ProviderUsage> {
    const entry = await this.options.directory.get(id, this.options.authority);
    if (!entry.capabilities?.includes("connections.usage")) return absentUsage("unsupported", "unsupported_sdk");
    if (!entry.available) return absentUsage("unavailable", "temporarily_unavailable");
    const usage = await this.options.backend.usage(entry.selection.provider, entry.selection.connection.id, this.options.authority);
    // A diagnostic can finish after the account changes. Never relabel its newer
    // revision as the exact account selection that this conversation still holds.
    if (usage.data?.connectionRevision !== undefined && String(usage.data.connectionRevision) !== entry.selection.connection.revision)
      return { ...absentUsage("unavailable", "temporarily_unavailable"), connectionRevision: entry.selection.connection.revision };
    return { ...usageProjection(usage),
      connectionRevision: entry.selection.connection.revision };
  }
  async update(_input: Record<string, unknown>, _id?: string, _importSource?: string): Promise<AgentConnection> { return providerOwned(); }
  async remove(_id: string): Promise<void> { return providerOwned(); }
  async prepareDockerAuthorization(_id: string): Promise<void> { return providerOwned(); }
  async adoptLegacySession(_binding: ConnectionBinding, _id: string): Promise<void> { return providerOwned(); }
  async startLogin(_id: string): Promise<ConnectionLogin> { return providerOwned(); }
  async fetchLogin(_id: string): Promise<ConnectionLogin> { return providerOwned(); }
  async cancelLogin(_id: string): Promise<void> { return providerOwned(); }
  async shutdown(): Promise<void> { /* Detaching a consumer cannot stop provider-owned services. */ }
}
