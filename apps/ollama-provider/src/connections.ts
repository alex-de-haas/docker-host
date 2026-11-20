import type { ProviderSettingsDefinition } from "@hosty/agent-provider-runtime/settings";
import type { AgentCapabilities } from "@hosty-sdk/app/agent";
import { skillAdapter } from "@hosty/agent-provider-runtime/worker/skills";
import path from "node:path";
import { AgentConnections, ConnectionError, type AgentConnection, type ConnectionBinding, type AdapterPreparation } from "@hosty/agent-provider-runtime/connections/registry";
import type { ConnectionSecrets } from "@hosty/agent-provider-runtime/connections/secrets";
import type { HarnessAdapter } from "@hosty/agent-provider-runtime/harness/adapter";
import { absentUsage } from "@hosty/agent-provider-runtime/harness/provider-usage";
import { OllamaHarnessAdapter, OLLAMA_CAPABILITIES } from "./adapter/index.js";
import { ollamaUrl } from "./adapter/client.js";

export class OllamaConnections extends AgentConnections {
  constructor(data: string, cache: string | null, secrets: ConnectionSecrets, mode?: "native" | "docker") {
    super(data, cache, secrets, { kind: "ollama", name: "ollama", capabilities: OLLAMA_CAPABILITIES, authMethods: { none: { credential: "none" } } }, mode);
  }
  protected override validConnection(connection: AgentConnection): boolean { return connection.baseUrl === undefined || ollamaUrl(connection.baseUrl) === connection.baseUrl; }
  protected override connectionDefaults() { return { baseUrl: ollamaUrl(undefined, this.applicationMode === "docker") }; }
  protected override async connectionFields(input: Record<string, unknown>, previous: AgentConnection | null) {
    try { const value = input.baseUrl ?? previous?.baseUrl; return value === "" || value === undefined ? {} : { baseUrl: ollamaUrl(value) }; }
    catch (error) { throw new ConnectionError(400, "provider_url_invalid", (error as Error).message); }
  }
  protected override async createAdapter(connection: AgentConnection, _binding: unknown, docker: boolean): Promise<HarnessAdapter> {
    return new OllamaHarnessAdapter({ url: ollamaUrl(connection.baseUrl, docker), directory: path.join(this.dataDir, "provider-sessions", connection.id, String(connection.revision), "ollama") });
  }
  override async prepareAdapter(binding: ConnectionBinding, context: AdapterPreparation): Promise<HarnessAdapter> {
    const adapter = await this.adapter(binding); await this.executionHome(binding);
    return skillAdapter(adapter, { selected: context.skillPath, relativePath: ".agents/skills" });
  }
  protected override async unavailableUsage() { return absentUsage("not_applicable", "local"); }
}

export const ollamaCapabilities: AgentCapabilities = {
  version: 1, eventVersions: ["agent-event.1"],
  capabilities: ["session.resume", "configuration.resume-compatible", "configuration.approval-mode", "skills.catalog", "skills.exclusive-selection", "mcp.core", "mcp.apps", "mcp.policy-update", "workflow.consumer", "model.change-on-resume", "decisions.questions", "decisions.auto-allow", "connections.usage", "runs.park", "runs.barrier", "runs.reconcile", "runs.retire", "native-tools.none", "decisions.deny-reason", "runs.live-configure"],
  limits: { maxCommandBytes: 1024 * 1024, maxEventBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024, maxReplayBytes: 64 * 1024 * 1024, replayRetentionMs: 7 * 24 * 60 * 60 * 1000, maxControls: 10000, maxPageSize: 100, maxDurationMs: 24 * 60 * 60 * 1000 , maxSkillSnapshotBytes: 256 * 1024 },
  configuration: { resumeCompatible: ["instructions", "systemPrompt", "skills", "nativeTools", "approvalMode", "predictions"] },
  nativeTools: { default: "provider_default", none: true },
  subagents: { defaultEnabled: false, policy: "unavailable", observation: "unavailable" },
};

export const ollamaSettings: ProviderSettingsDefinition = {
  kind: "ollama", name: "Ollama", authentication: [{ id: "none", label: "No authentication" }],
  baseUrl: { label: "Ollama server URL", placeholder: "http://127.0.0.1:11434", description: "Connect to an existing Ollama server. Leave blank to use the local default. Models stay on that server; Hosty does not download them." },
};
