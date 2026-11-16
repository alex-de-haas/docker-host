import type { ProviderEngine } from "@hosty/agent-provider-runtime";
import { CodexConnections, codexCapabilities, codexSettings } from "./connections.js";

export const codexEngine: ProviderEngine = {
  capabilities: codexCapabilities,
  settings: codexSettings,
  createConnections: ({ data, cache, secrets }) => new CodexConnections(data, cache, secrets, "native"),
};
