import { startAgentProvider } from "@hosty/agent-provider-runtime";
import { claudeEngine } from "./provider.js";
await startAgentProvider({ engine: claudeEngine, defaultPort: 3521 });
