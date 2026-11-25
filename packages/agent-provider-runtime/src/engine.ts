import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCapabilities, AgentConfiguration, AgentAttachment } from "@hosty-sdk/app/agent";
import type { ProviderConnections } from "./internal/connections/registry.js";
import type { ConnectionSecrets } from "./internal/connections/secrets.js";
import type { ProviderSettingsDefinition, ProviderSettingsOptions } from "./settings.js";

export type NativeInputContext = {
  text: string;
  attachments: Array<AgentAttachment & { path: string }>;
  configuration: AgentConfiguration;
  skillPath: string;
};
export type NativeInputPreparer = (context: NativeInputContext) => Promise<{ text: string; instructions?: string }>;

/** The application chooses how its native engine receives user-provided attachments. */
export const prepareNativeInput: NativeInputPreparer = async ({ text, attachments }) => ({
  text: text + attachments.map(ref => `\n\nUser attachment ${JSON.stringify(ref.name ?? ref.id)}: ${JSON.stringify(ref.path)}`).join(""),
});

/** Engine identity, capabilities, accounts and native policy enter through the owning application. */
export type EngineConnections = ProviderConnections & ProviderSettingsOptions["connections"];
export type ProviderEngine<C extends EngineConnections = EngineConnections> = {
  capabilities: AgentCapabilities;
  /** Opts this adapter into the runtime's qualified and restricted native tool profiles. */
  managedNativeScopes?: true;
  createConnections: (context: { data: string; cache: string | null; secrets: ConnectionSecrets }) => C;
  /** Optional app-owned interfaces run beside agent routes under their own verified authority. */
  openInterfaces?: (connections: C, data: string) => {
    route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
    close(): void;
  };
  settings: ProviderSettingsDefinition;
  prepareInput?: NativeInputPreparer;
  /** Set only for native clients whose default MCP timeout cannot accommodate Git skill operations. */
  gitSkillWorkflowTimeoutMs?: number;
};
