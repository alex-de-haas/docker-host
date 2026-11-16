import type { AgentConnectionSelection } from "../agent-providers/types.js";
import type { HarnessAvailability, HarnessCapabilities } from "../harness/adapter.js";

/** Legacy kinds are retained for stored records; public routing uses the qualified selection. */
export type AgentKind = "codex" | "claude" | "ollama" | "agent";
export type ConnectionBinding = {
  connectionId: string;
  connectionRevision: string | number;
  harnessKind: AgentKind;
  connectionIdentity?: string;
  selection?: AgentConnectionSelection;
};
export type AgentConnection = {
  id: string;
  name: string;
  kind: AgentKind;
  revision: string | number;
  capabilities?: string[];
  provider?: AgentConnectionSelection["provider"] & { name?: string };
};
export type ConnectionDirectory = {
  connections: Array<AgentConnection & HarnessAvailability>;
  defaultId: string | null;
  ollamaDefaultUrl?: string;
  providers?: Array<AgentConnectionSelection["provider"] & { name: string; available: boolean; reason?: string }>;
};
export type ConnectionHealth = HarnessAvailability & { name: string; capabilities: HarnessCapabilities & { appContext: boolean } };
export type ConnectionLogin = {
  id: string; connectionId: string; status: "pending" | "complete" | "failed" | "cancelled";
  verificationUrl?: string; userCode?: string; message?: string;
};
export type ConnectionModelCatalog = {
  revision: string;
  models: Array<{ id: string; label: string; efforts: Array<{ id: string; label: string }>;
    defaultEffort?: string; suggested?: boolean; unavailableReason?: string }>;
  defaultModel?: string;
  unavailableReason?: string;
};
