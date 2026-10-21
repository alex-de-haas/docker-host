import path from "node:path";
import { conversationDirectory, storeAttachment } from "./resources.js";
import { mkdir, realpath, stat, chown, chmod } from "node:fs/promises";
import { AgentConnections, type ConnectionBinding } from "../connections/registry.js";
import type { ConnectionSecrets } from "../connections/secrets.js";
import type { HarnessAdapter } from "../harness/adapter.js";
import { runTranslation } from "../translation/native.js";
import { WorkerEngine, type WorkerExecution } from "./engine.js";
import { WorkerJournal } from "./journal.js";
import { WorkerApiError, safeIdentity, type WorkerRunRequest } from "./contracts.js";
import { createWorkerServer } from "./http.js";
import { readServiceIdentity } from "./auth.js";
import { validateSelection } from "./models.js";
import { isolatedAdapter, prepareNativeProfile } from "./native.js";
import { WorkerClient } from "./client.js";

/** Hosty-specific composition lives here; the HTTP engine/client remain endpoint-only. */
export async function createProviderService(options: { data: string; cache: string; auth: string; mode: "native" | "docker"; trees?: string; files?: string }) {
  let coordinator: WorkerClient | undefined;
  const secrets: ConnectionSecrets = {
    get: async key => (await secret("get", key) as { value: string | null }).value,
    set: async (key, value) => { await secret("set", key, value); },
    delete: async key => { await secret("delete", key); },
  };
  async function secret(operation: string, key: string, value?: string): Promise<unknown> {
    if (!coordinator) throw new WorkerApiError(503, "coordinator_unavailable", "Harness has not connected to this worker.");
    return coordinator.request("/internal/worker/secrets", "POST", { operation, key, value });
  }
  const files = options.files ?? options.cache;
  const sourceUid = options.trees ? (await stat(options.trees)).uid : 0;
  const executionUid = sourceUid > 0 ? sourceUid : 1000;
  const directory = async (id: string) => {
    const result = await conversationDirectory(files, id);
    if (options.mode === "docker") { await chown(result, executionUid, executionUid); await chmod(result, 0o700); }
    return result;
  };
  const connections = new AgentConnections(options.data, options.cache, secrets, options.mode);
  const journal = new WorkerJournal(path.join(options.data, "runs"), undefined, undefined, options.mode === "docker" && process.ppid === 1 ? "container" : "local"); await journal.initialize();
  const capacity = options.mode === "docker" ? 1 : 32;
  const execution: WorkerExecution = {
    reserve: request => request.operation === "translation" ? Promise.resolve(() => {}) : connections.reserve(request.binding),
    validateSelection: async request => {
      const current = await connections.binding(request.binding.connectionId);
      if (JSON.stringify(current) !== JSON.stringify(request.binding)) throw new WorkerApiError(409, "connection_changed", "Select the current connection.");
      if (request.selection.model || request.selection.reasoningEffort)
        validateSelection(request.selection, await connections.models(request.binding.connectionId));
    },
    cwd: async request => {
      if (request.resource.kind === "worktree") {
        if (!options.trees) throw new WorkerApiError(503, "source_unavailable", "Managed source is not mounted.");
        const root = await realpath(options.trees), candidate = await realpath(path.join(root, request.resource.id));
        if (path.dirname(candidate) !== root) throw new WorkerApiError(400, "invalid_resource", "Worktree redirects outside the source collection.");
        return candidate;
      }
      return directory(request.conversationId);
    },
    adapter: async request => {
      if (request.operation === "translation") return translationAdapter(connections, request, options.mode === "docker" ? executionUid : undefined);
      const adapter = await connections.adapter(request.binding);
      if (options.mode !== "docker") return adapter;
      const health = await adapter.probe();
      if (!health.available) throw new Error(health.reason);
      return isolatedAdapter(adapter, await prepareNativeProfile(await connections.executionHome(request.binding), request.binding.harnessKind, executionUid));
    },
  };
  const engine = new WorkerEngine(journal, execution, capacity);
  const text = (value: unknown): string => { if (typeof value !== "string" || !safeIdentity(value)) throw new WorkerApiError(400, "invalid_arguments", "Invalid provider identity."); return value; };
  const binding = (value: unknown): ConnectionBinding => {
    const b = value as ConnectionBinding;
    if (!b || !safeIdentity(b.connectionId) || !Number.isSafeInteger(b.connectionRevision) || !["codex", "claude"].includes(b.harnessKind))
      throw new WorkerApiError(400, "invalid_arguments", "Invalid connection binding.");
    return b;
  };
  const server = createWorkerServer(engine, () => readServiceIdentity(options.auth), {
    attachment: async (id, name, request) => {
      await directory(id);
      const result = await storeAttachment(files, id, name, request);
      if (options.mode === "docker") await chown(result.path, executionUid, executionUid);
      return result;
    },
    capabilities: async () => ({ resources: { trees: options.trees }, providers: ["codex", "claude"], operations: ["chat", "translation"], modelSelection: true, reasoningEffort: true, capacity, ready: Boolean(coordinator) }),
    configure: async value => {
      const input = value as { callbackUrl?: unknown };
      if (typeof input?.callbackUrl !== "string") throw new WorkerApiError(400, "invalid_coordinator", "Coordinator callback URL required.");
      const candidate = new WorkerClient(input.callbackUrl, await readServiceIdentity(options.auth));
      await candidate.request("/internal/worker/health"); coordinator = candidate;
      return { ready: true };
    },
    models: id => connections.models(id),
    connection: async (operation, args) => {
      switch (operation) {
        case "list": return connections.list();
        case "get": return connections.get(text(args[0]));
        case "binding": return connections.binding(args[0]);
        case "update": {
          if (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) throw new WorkerApiError(400, "invalid_arguments", "Connection settings required.");
          return connections.update(args[0] as Record<string, unknown>, args[1] == null ? undefined : text(args[1]));
        }
        case "set-default": await connections.setDefault(args[0]); return null;
        case "remove": await connections.remove(text(args[0])); return null;
        case "prepare-authorization": await connections.prepareDockerAuthorization(text(args[0])); return null;
        case "adopt-session": await connections.adoptLegacySession(binding(args[0]), text(args[1])); return null;
        case "summary": return connections.summary();
        case "health": return connections.health(args.length ? args[0] === null ? null : binding(args[0]) : undefined);
        case "start-login": return connections.startLogin(text(args[0]));
        case "login": return connections.fetchLogin(text(args[0]));
        case "cancel-login": await connections.cancelLogin(text(args[0])); return null;
        default: throw new WorkerApiError(404, "unknown_operation", "Unknown provider operation.");
      }
    },
  });
  const prune = setInterval(() => { void journal.prune().catch(error => console.warn("Worker replay retention failed:", error)); }, 15 * 60000); prune.unref();
  return { server, engine, connections, close: async () => { clearInterval(prune); await engine.close(); await connections.shutdown(); } };
}

function translationAdapter(connections: AgentConnections, request: WorkerRunRequest, uid?: number): HarnessAdapter {
  return { name: "translation", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
    probe: async () => ({ available: true }), start: options => {
      const controller = new AbortController(); let finished: Promise<void> = Promise.resolve();
      const stop = async () => { controller.abort(); await finished; };
      return { send: input => {
        finished = connections.withTranslationRuntime(request.binding, async runtime => {
          if (uid === undefined) return runTranslation(runtime, input, controller.signal, { model: request.selection.model });
          const profile = await prepareNativeProfile(runtime.home, runtime.kind, uid);
          try { return await runTranslation({ ...runtime, home: profile.root, cwd: profile.root, processTransport: profile.transport }, input, controller.signal, { model: request.selection.model }); }
          finally { await profile.close(); }
        })
          .then(text => { options.onEvent({ type: "assistant_text", text }); options.onEvent({ type: "result", status: "success" }); })
          .catch(error => { if (!controller.signal.aborted) options.onEvent({ type: "error", message: error instanceof Error ? error.message : "Translation failed." }); });
      }, resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => false, interrupt: stop, stop, stopAndWait: stop };
    } };
}
