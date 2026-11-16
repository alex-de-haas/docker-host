import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { durableMkdir, durableWriteFile } from "../persistence.js";
import { ConnectionError } from "../connections/errors.js";
import type { AgentConnectionSelection, AgentConsumerAuthority, AgentDirectoryBackend, DiscoveredAgentConnection } from "./types.js";

type Preferences = { version: 1; default: AgentConnectionSelection | null };
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
export function validAgentSelection(value: unknown): value is AgentConnectionSelection {
  const selection = value as AgentConnectionSelection | null;
  return Boolean(selection && [selection.provider?.appId, selection.provider?.installationId, selection.provider?.key,
    selection.connection?.id].every(validText) && typeof selection.connection?.revision === "string"
    && /^(0|[1-9][0-9]{0,39})$/.test(selection.connection.revision));
}

/** A selection identifies the exact installation/account revision, never a vendor or a native path. */
export function agentSelectionId(selection: AgentConnectionSelection): string {
  if (!validAgentSelection(selection)) throw new ConnectionError(400, "provider_invalid", "Choose a current provider connection.");
  return createHash("sha256").update(JSON.stringify([selection.provider.appId, selection.provider.installationId,
    selection.provider.key, selection.connection.id, selection.connection.revision])).digest("hex");
}

/** Harness owns only its preferred qualified selection; account CRUD and credentials belong elsewhere. */
export class AgentConnectionDirectory {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string, private readonly backend: AgentDirectoryBackend) {}
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
    providers: Array<{ appId: string; installationId: string; key: string; name: string; available: boolean; reason?: string }>;
  }> {
    const [providers, preferences] = await Promise.all([this.backend.providers(authority), this.preferences()]);
    const entries = await Promise.all(providers.map(async provider => {
      if (!provider.available) return [];
      try {
        return (await this.backend.connections(provider.ref, authority)).map(connection => {
          const selection: AgentConnectionSelection = { provider: provider.ref, connection: { id: connection.id, revision: connection.revision } };
          return { ...connection, id: agentSelectionId(selection), selection, providerName: provider.displayName,
            provider: { ...provider.ref, name: provider.displayName } };
        });
      } catch (error) {
        // An unavailable/denied provider never supplies accounts from an old directory cache.
        provider.available = false;
        provider.reason = error instanceof Error ? error.message : "Provider connections are unavailable.";
        return [];
      }
    }));
    return { connections: entries.flat(), defaultId: preferences.default ? agentSelectionId(preferences.default) : null,
      providers: providers.map(provider => ({ ...provider.ref, name: provider.displayName, available: provider.available,
        ...(provider.reason ? { reason: provider.reason } : {}) })) };
  }

  async get(id: string, authority: AgentConsumerAuthority): Promise<DiscoveredAgentConnection> {
    const connection = (await this.list(authority)).connections.find(candidate => candidate.id === id);
    if (!connection) throw new ConnectionError(409, "provider_connection_changed", "The selected provider installation or account changed. Select it again explicitly.");
    return connection;
  }

  async binding(id: string | null | undefined, authority: AgentConsumerAuthority): Promise<AgentConnectionSelection | null> {
    if (id === null) return null;
    const selected = id === undefined ? (await this.preferences()).default : null;
    const selectedId = id ?? (selected ? agentSelectionId(selected) : null);
    return selectedId ? (await this.get(selectedId, authority)).selection : null;
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
