import { randomUUID } from "node:crypto";
import type { ConnectionService } from "../connections/service.js";
import { ConnectionError } from "../connections/errors.js";
import type { AgentConnections, ConnectionBinding } from "../connections/registry.js";
import type { HarnessAdapter } from "../harness/adapter.js";
import type { TranslationRuntime } from "../translation/native.js";
import { WorkerClient } from "./client.js";
import type { WorkerRunRequest } from "./contracts.js";

export class RemoteConnections implements ConnectionService {
  constructor(readonly client: WorkerClient) {}
  private call<T>(operation: string, args: unknown[] = []): Promise<T> {
    return this.client.request(`/v1/connections/operations/${operation}`, "POST", { args });
  }
  list(): ReturnType<AgentConnections["list"]> { return this.call("list"); }
  get(id: string): ReturnType<AgentConnections["get"]> { return this.call("get", [id]); }
  binding(id?: unknown): ReturnType<AgentConnections["binding"]> { return this.call("binding", id === undefined ? [] : [id]); }
  update(input: Record<string, unknown>, id?: string): ReturnType<AgentConnections["update"]> { return this.call("update", [input, id]); }
  setDefault(id: unknown): Promise<void> { return this.call("set-default", [id]); }
  remove(id: string): Promise<void> { return this.call("remove", [id]); }
  prepareDockerAuthorization(id: string): Promise<void> { return this.call("prepare-authorization", [id]); }
  adoptLegacySession(binding: ConnectionBinding, id: string): Promise<void> { return this.call("adopt-session", [binding, id]); }
  summary(): ReturnType<AgentConnections["summary"]> { return this.call("summary"); }
  health(binding?: ConnectionBinding | null): ReturnType<AgentConnections["health"]> { return this.call("health", binding === undefined ? [] : [binding]); }
  startLogin(id: string): ReturnType<AgentConnections["startLogin"]> { return this.call("start-login", [id]); }
  fetchLogin(id: string): ReturnType<AgentConnections["fetchLogin"]> { return this.call("login", [id]); }
  cancelLogin(id: string): Promise<void> { return this.call("cancel-login", [id]); }
  usage(id: string, refresh = false): ReturnType<AgentConnections["usage"]> { return this.call("usage", [id, refresh]); }
  models(id: string): ReturnType<AgentConnections["models"]> { return this.client.request(`/v1/connections/${encodeURIComponent(id)}/models`); }
  async reserve(binding: ConnectionBinding): Promise<() => void> {
    // Worker atomically claims the actual connection when it accepts execution.
    const current = await this.binding(binding.connectionId);
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new ConnectionError(409, "provider_credentials_changed", "Select the current provider connection.");
    return () => {};
  }
  async adapter(binding: ConnectionBinding): Promise<HarnessAdapter> {
    const health = await this.health(binding);
    if (!health.available) throw new ConnectionError(503, "provider_unavailable", health.reason ?? "Provider unavailable.");
    return this.client.adapter(binding, health.capabilities, health.name);
  }
  async withTranslationRuntime<T>(binding: ConnectionBinding, action: (runtime: TranslationRuntime) => Promise<T>): Promise<T> {
    if (binding.harnessKind === "ollama") throw new ConnectionError(400, "translation_unsupported", "Select Codex or Claude for translation.");
    return action({ kind: binding.harnessKind, home: "", cwd: "", env: {}, execute: async (input, signal, options) => {
      const id = randomUUID();
      const request: WorkerRunRequest = { operation: "translation", conversationId: id, binding,
        selection: { model: options.model ?? null, reasoningEffort: null }, resource: { kind: "conversation", id }, input, options: {}, autoAllowedPrefixes: [] };
      signal.throwIfAborted();
      await this.client.request(`/v1/runs/${id}`, "PUT", request, true);
      let text = "";
      const cancelId = randomUUID();
      const cancel = () => { void this.client.request(`/v1/runs/${id}/cancel`, "POST", { controlId: cancelId }, true).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) { cancel(); signal.throwIfAborted(); }
        const receipt = await this.client.events(id, frame => { if (frame.event.type === "assistant_text") text = frame.event.text; }, signal);
        if (receipt.state !== "completed") throw new ConnectionError(502, "translation_failed", receipt.error ?? "Translation failed.");
        return text;
      } finally { signal.removeEventListener("abort", cancel); }
    } });
  }
  async shutdown(): Promise<void> { /* Ordinary service lifecycle is owned by Core. */ }
}
