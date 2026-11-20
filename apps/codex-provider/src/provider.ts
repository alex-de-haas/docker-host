import type { ProviderEngine } from "@hosty/agent-provider-runtime";
import { CodexConnections, codexCapabilities, codexSettings } from "./connections.js";

import { openSpeech } from "./speech.js";

export const codexEngine: ProviderEngine<CodexConnections> = {
  openInterfaces: openSpeech,
  capabilities: codexCapabilities,
  settings: codexSettings,
  createConnections: ({ data, cache, secrets }) => new CodexConnections(data, cache, secrets, "native"),
};
