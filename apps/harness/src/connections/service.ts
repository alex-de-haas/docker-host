import type { AgentConnections } from "./registry.js";

/** The application boundary contains provider operations, never process or Docker commands. */
export type ConnectionService = Pick<AgentConnections, "list" | "get" | "binding" | "reserve" | "update" | "setDefault" | "remove"
  | "prepareDockerAuthorization" | "adapter" | "adoptLegacySession" | "summary" | "health" | "startLogin" | "fetchLogin"
  | "cancelLogin" | "withTranslationRuntime" | "models" | "shutdown">;
