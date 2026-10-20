import type { HarnessEvent, HarnessStartOptions } from "../harness/adapter.js";
import type { ConnectionBinding } from "../connections/registry.js";

export const WORKER_PROTOCOL = 1;
export const MAX_COMMAND_BYTES = 1024 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024 * 1024;
export const REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
export type ExecutionSelection = { model: string | null; reasoningEffort: string | null };
export type ModelChoice = { id: string; label: string; efforts: Array<{ id: string; label: string }>; defaultEffort?: string; suggested?: boolean };
export type ModelCatalog = { revision: string; models: ModelChoice[]; defaultModel?: string; unavailableReason?: string };
export type ResourceReference = { kind: "conversation"; id: string } | { kind: "worktree"; id: string; revision: string; path?: string };
export type WorkerRunRequest = {
  operation?: "chat" | "translation";
  conversationId: string;
  binding: ConnectionBinding;
  selection: ExecutionSelection;
  resource: ResourceReference;
  input: string;
  options: Pick<HarnessStartOptions, "autonomy" | "systemPrompt" | "resumeHarnessSessionId" | "mcpServers">;
  autoAllowedPrefixes: string[];
};
export type RunState = "accepted" | "running" | "awaiting_input" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkerEvent = { runId: string; generation: string; sequence: number; event: HarnessEvent };
export type WorkerReceipt = {
  runId: string; conversationId: string; generation: string; state: RunState; revision: number;
  boundary?: "container" | "local"; exitConfirmed?: boolean;
  pending?: WorkerEvent[];
  selection: ExecutionSelection; snapshot?: { text?: string; nativeSessionId?: string; result?: HarnessEvent }; createdAt: string; updatedAt: string; error?: string;
};
export type WorkerControl = { controlId: string; eventId: number; expectedRevision: number } & (
  { kind: "approval"; id: string; decision: "allow" | "deny"; message?: string }
  | { kind: "question"; id: string; answers: Record<string, string> }
);
export class WorkerApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export const safeIdentity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value);
export const terminal = (state: RunState): boolean => ["completed", "failed", "cancelled", "interrupted"].includes(state);

export function validateRun(value: unknown): asserts value is WorkerRunRequest {
  const r = value as WorkerRunRequest;
  if (!r || ![undefined, "chat", "translation"].includes(r.operation) || !safeIdentity(r.conversationId) || !r.binding || !safeIdentity(r.binding.connectionId)
    || !Number.isSafeInteger(r.binding.connectionRevision) || r.binding.connectionRevision < 1
    || !["codex", "claude"].includes(r.binding.harnessKind) || typeof r.input !== "string" || !r.input.trim()
    || !r.selection || ![r.selection.model, r.selection.reasoningEffort].every(v => v === null || typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(v))
    || !r.resource || !safeIdentity(r.resource.id) || !["conversation", "worktree"].includes(r.resource.kind)
    || !r.options || ![undefined, "normal", "autonomous"].includes(r.options.autonomy)
    || !Array.isArray(r.autoAllowedPrefixes) || r.autoAllowedPrefixes.some(p => typeof p !== "string" || !/^mcp__[A-Za-z0-9_-]+__$/.test(p)))
    throw new WorkerApiError(400, "invalid_run", "Invalid worker run request.");
  if (Object.keys(r.options).some(key => !["autonomy", "systemPrompt", "resumeHarnessSessionId", "mcpServers"].includes(key))
    || r.options.systemPrompt !== undefined && typeof r.options.systemPrompt !== "string"
    || r.options.resumeHarnessSessionId !== undefined && !safeIdentity(r.options.resumeHarnessSessionId)
    || r.options.mcpServers !== undefined && (!r.options.mcpServers || typeof r.options.mcpServers !== "object" || Array.isArray(r.options.mcpServers)))
    throw new WorkerApiError(400, "invalid_options", "Invalid provider options.");
  if (r.options.mcpServers !== undefined) validateMcpServers(r.options.mcpServers);
  if (r.resource.kind === "conversation" && r.resource.id !== r.conversationId)
    throw new WorkerApiError(400, "invalid_resource", "Conversation resource does not match the run.");
  if (r.resource.kind === "worktree" && (!/^[a-f0-9]{64}$/.test(r.resource.id) || typeof r.resource.revision !== "string"))
    throw new WorkerApiError(400, "invalid_resource", "A versioned worktree reference is required.");
}

export function validateMcpServers(servers: unknown): asserts servers is Record<string, unknown> {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new WorkerApiError(400, "invalid_configuration", "MCP servers must be an object.");
  for (const [name, value] of Object.entries(servers)) {
    const server = value as { type?: unknown; url?: unknown; headers?: unknown };
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !server || typeof server !== "object" || Array.isArray(server)
      || Object.keys(server).some(key => !["type", "url", "headers", "hostyPolicy"].includes(key))
      || server.type !== "http" || typeof server.url !== "string") throw new WorkerApiError(400, "invalid_configuration", "Only declared HTTP MCP callbacks are supported.");
    let url: URL; try { url = new URL(server.url); } catch { throw new WorkerApiError(400, "invalid_configuration", "Invalid MCP callback URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash
      || server.headers !== undefined && (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers)
        || Object.values(server.headers).some(value => typeof value !== "string" || /[\r\n]/.test(value))))
      throw new WorkerApiError(400, "invalid_configuration", "Invalid MCP callback configuration.");
  }
}
