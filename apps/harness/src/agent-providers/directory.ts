import { providerIdentityParts } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { durableMkdir, durableWriteFile } from "../persistence.js";
import { ConnectionError } from "../connections/errors.js";
import type { AgentConnectionSelection, AgentConsumerAuthority, AgentDirectoryBackend, AgentProviderEntry, DiscoveredAgentConnection } from "./types.js";

type Preferences = { version: 1; default: AgentConnectionSelection | null };
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
export function validAgentSelection(value: unknown): value is AgentConnectionSelection {
  const selection = value as AgentConnectionSelection | null;
  return Boolean(selection && [selection.provider?.appId, selection.provider?.installationId, selection.provider?.key,
    selection.connection?.id].every(validText) && (selection.provider.implementationId == null || validText(selection.provider.implementationId) && selection.provider.implementationId.length <= 128)
    && typeof selection.connection?.revision === "string"
    && /^(0|[1-9][0-9]{0,39})$/.test(selection.connection.revision));
}

/** A selection identifies the exact installation/account revision, never a vendor or a native path. */
export function agentSelectionId(selection: AgentConnectionSelection): string {
  if (!validAgentSelection(selection)) throw new ConnectionError(400, "provider_invalid", "Choose a current provider connection.");
  return createHash("sha256").update(JSON.stringify([...providerIdentityParts(selection.provider), selection.connection.id, selection.connection.revision])).digest("hex");
}

/** Preferences follow the provider-owned account across installations and credential revisions. */
export function agentConnectionId(selection: AgentConnectionSelection): string {
  if (!validAgentSelection(selection)) throw new ConnectionError(400, "provider_invalid", "Choose a current provider connection.");
  const { appId, key, implementationId } = selection.provider;
  const identity = JSON.stringify([appId, key, implementationId ?? null, selection.connection.id]);
  return "agent-" + createHash("sha256").update(identity).digest("hex");
}

const legacyPreference = (id: string) => /^[0-9a-f]{64}$/.test(id);

/** Harness owns connection preferences. Each operation obtains its authority from Core. */
export class AgentConnectionDirectory {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string, private readonly backend: AgentDirectoryBackend,
    private readonly retainedSelections?: () => Promise<AgentConnectionSelection[]>) {}
  private get file(): string { return path.join(this.dataDir, "agent-provider-preferences.json"); }
  private async preferences(): Promise<Preferences> {
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as Preferences;
      if (stored.version !== 1 || stored.default !== null && !validAgentSelection(stored.default))
        throw new ConnectionError(409, "provider_preferences_invalid", "Review the saved Harness provider selection.");
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, default: null };
      throw error;
    }
  }

  async list(authority: AgentConsumerAuthority): Promise<{
    connections: DiscoveredAgentConnection[]; defaultId: string | null;
    providers: Array<AgentProviderEntry["ref"] & { name: string; available: boolean; reason?: string }>;
  }> {
    const [providers, preferences] = await Promise.all([this.backend.providers(authority), this.preferences()]);
    const entries = await Promise.all(providers.map(async provider => {
      if (!provider.available) return [];
      try {
        return (await this.backend.connections(provider.ref, authority)).map(connection => {
          const selection: AgentConnectionSelection = { provider: provider.ref, connection: { id: connection.id, revision: connection.revision } };
          return { ...connection, id: agentConnectionId(selection), selection, providerName: provider.displayName,
            provider: { ...provider.ref, name: provider.displayName } };
        });
      } catch (error) {
        // An unavailable/denied provider never supplies accounts from an old directory cache.
        provider.available = false;
        provider.reason = error instanceof Error ? error.message : "Provider connections are unavailable.";
        return [];
      }
    }));
    return { connections: entries.flat(), defaultId: preferences.default ? agentConnectionId(preferences.default) : null,
      providers: providers.map(provider => ({ ...provider.ref, name: provider.displayName, available: provider.available,
        ...(provider.reason ? { reason: provider.reason } : {}) })) };
  }

  /** An old hash alone cannot identify a replacement. Compare it with previously stored qualified selections. */
  private async legacyAliases(ids: string[], entries: DiscoveredAgentConnection[]): Promise<Map<string, string>> {
    const pending = new Set(ids.filter(legacyPreference)), aliases = new Map<string, string>();
    if (!pending.size || !entries.length) return aliases;
    const current = new Map<string, number>();
    for (const entry of entries) current.set(entry.id, (current.get(entry.id) ?? 0) + 1);
    const observe = (selection: AgentConnectionSelection) => {
      if (!validAgentSelection(selection)) return;
      const exact = agentSelectionId(selection);
      if (!pending.has(exact)) return;
      const logical = agentConnectionId(selection);
      if (current.get(logical) === 1) aliases.set(exact, logical);
      pending.delete(exact);
    };
    for (const entry of entries) observe(entry.selection);
    if (pending.size) {
      const preferred = (await this.preferences()).default;
      if (preferred) observe(preferred);
    }
    if (pending.size && this.retainedSelections)
      for (const selection of await this.retainedSelections()) observe(selection);
    return aliases;
  }

  async migratePreferences(ids: string[], authority: AgentConsumerAuthority): Promise<Map<string, string>> {
    if (!ids.some(legacyPreference)) return new Map();
    return this.legacyAliases(ids, (await this.list(authority)).connections);
  }

  async get(id: string, authority: AgentConsumerAuthority): Promise<DiscoveredAgentConnection> {
    const { connections } = await this.list(authority);
    const logical = legacyPreference(id) ? (await this.legacyAliases([id], connections)).get(id) : id;
    const matches = connections.filter(candidate => candidate.id === logical);
    if (matches.length !== 1) throw new ConnectionError(409, "provider_connection_changed", "The selected provider installation or account changed. Select it again explicitly.");
    return matches[0]!;
  }

  async currentSelection(saved: AgentConnectionSelection, authority: AgentConsumerAuthority): Promise<DiscoveredAgentConnection | null> {
    const { providers, connections } = await this.list(authority);
    const matches = providers.filter(p => p.appId === saved.provider.appId && p.key === saved.provider.key
      && (p.implementationId ?? null) === (saved.provider.implementationId ?? null));
    if (matches.length !== 1) return null;
    const provider = matches[0]!;
    if (!provider.available) throw new ConnectionError(503, "provider_unavailable", provider.reason ?? "Provider connections are unavailable.");
    const logical = agentConnectionId(saved);
    const accounts = connections.filter(entry => entry.id === logical);
    return accounts.length === 1 && accounts[0]!.available ? accounts[0]! : null;
  }

  async binding(id: string | null | undefined, authority: AgentConsumerAuthority): Promise<AgentConnectionSelection | null> {
    if (id === null) return null;
    const selected = id === undefined ? (await this.preferences()).default : null;
    const selectedId = id ?? (selected ? agentConnectionId(selected) : null);
    if (!selectedId) return null;
    const entry = await this.get(selectedId, authority);
    if (!entry.available) throw new ConnectionError(503, "provider_unavailable", entry.reason ?? "Choose an available provider connection.");
    return entry.selection;
  }

  async setDefault(id: string | null, authority: AgentConsumerAuthority): Promise<void> {
    const operation = this.tail.catch(() => {}).then(async () => {
      const selected = id === null ? null : await this.get(id, authority);
      if (selected && !selected.available) throw new ConnectionError(409, "provider_unavailable", selected.reason ?? "Choose an available provider connection.");
      await durableMkdir(this.dataDir);
      await durableWriteFile(this.file, JSON.stringify({ version: 1, default: selected?.selection ?? null } satisfies Preferences));
    });
    this.tail = operation;
    await operation;
  }
}
