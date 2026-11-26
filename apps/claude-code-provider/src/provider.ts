import type { ProviderEngine } from "@hosty/agent-provider-runtime";
import { ClaudeConnections, claudeCapabilities, claudeSettings } from "./connections.js";

export const claudeEngine: ProviderEngine = {
  managedNativeScopes: true,
  capabilities: claudeCapabilities,
  settings: claudeSettings,
  createConnections: ({ data, cache, secrets }) => new ClaudeConnections(data, cache, secrets, "native"),
};
