import { startAgentProvider } from "@hosty/agent-provider-runtime";
import { ollamaEngine } from "./provider.js";
await startAgentProvider({ engine: ollamaEngine, defaultPort: 3522 });
