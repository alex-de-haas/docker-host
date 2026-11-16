import type { HarnessAdapter } from "../harness/adapter.js";
import type { ProviderUsage } from "../harness/provider-usage.js";
import type { AgentConnection, ConnectionBinding, ConnectionDirectory, ConnectionHealth, ConnectionLogin, ConnectionModelCatalog } from "./types.js";

/** The application boundary contains provider operations, never process or Docker commands. */
export interface ConnectionService {
  readonly remote?: boolean;
  list(): Promise<ConnectionDirectory>;
  get(id: string): Promise<AgentConnection>;
  binding(id?: unknown): Promise<ConnectionBinding | null>;
  reserve(binding: ConnectionBinding): Promise<() => void>;
  setDefault(id: unknown): Promise<void>;
  adapter(binding: ConnectionBinding, docker?: boolean): Promise<HarnessAdapter>;
  summary(): Promise<ConnectionHealth>;
  health(binding?: ConnectionBinding | null, docker?: boolean): Promise<ConnectionHealth>;
  models(id: string): Promise<ConnectionModelCatalog>;
  usage(id: string, refresh?: boolean): Promise<ProviderUsage>;
  shutdown(): Promise<void>;
  /** Deprecated compatibility methods; provider-owned connections reject these operations. */
  update(input: Record<string, unknown>, id?: string, importSource?: string): Promise<AgentConnection>;
  remove(id: string): Promise<void>;
  prepareDockerAuthorization(id: string): Promise<void>;
  adoptLegacySession(binding: ConnectionBinding, id: string): Promise<void>;
  startLogin(id: string): Promise<ConnectionLogin>;
  fetchLogin(id: string): Promise<ConnectionLogin>;
  cancelLogin(id: string): Promise<void>;
}
