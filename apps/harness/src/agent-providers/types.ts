import type { ProviderRef } from "@hosty-sdk/app/agent-sessions";

/** Consumer-owned selection; the provider owns the account and its credentials. */
export type AgentConnectionSelection = {
  provider: ProviderRef;
  connection: { id: string; revision: string };
};

export type AgentProviderEntry = {
  ref: ProviderRef;
  displayName: string;
  available: boolean;
  reason?: string;
};

export type AgentConnectionEntry = {
  id: string;
  name: string;
  revision: string;
  available: boolean;
  reason?: string;
  capabilities?: string[];
};

export type DiscoveredAgentConnection = AgentConnectionEntry & {
  selection: AgentConnectionSelection;
  providerName: string;
  provider: ProviderRef & { name: string };
};

/** Authority is supplied to Core by the consumer, never forwarded to a provider. */
export type AgentTaskAuthority = { kind: "task"; dispatch: import("@hosty-sdk/app/providers").TaskDispatchRef; executionId: string };
export type AgentConsumerAuthority = () => Promise<string | AgentTaskAuthority>;

export interface AgentDirectoryBackend {
  providers(authority: AgentConsumerAuthority): Promise<AgentProviderEntry[]>;
  connections(provider: ProviderRef, authority: AgentConsumerAuthority): Promise<AgentConnectionEntry[]>;
}
