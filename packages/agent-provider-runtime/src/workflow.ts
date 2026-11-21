import { createHash, randomUUID } from "node:crypto";
import { AGENT_PROFILE_MANAGEMENT_WORKFLOW_TOOLS, AGENT_SESSION_WORKFLOW_TOOLS, AGENT_SUBAGENT_WORKFLOW_TOOLS, AgentApiError, type AgentSessionWorkflowBinding, type AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import type { ProviderAuthority } from "./core.js";
import { McpToolPolicy } from "./internal/mcp/policy.js";
import type { ProxyTarget } from "./internal/mcp/proxy.js";
import { PROTOCOL_VERSION } from "./internal/mcp/upstream.js";
import type { AssistantSettings } from "./internal/settings/store.js";
import { workflowTools } from "@hosty-sdk/app/agent/workflow-tools";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const chatTools: ReadonlySet<string> = new Set([...AGENT_SUBAGENT_WORKFLOW_TOOLS, ...AGENT_PROFILE_MANAGEMENT_WORKFLOW_TOOLS]);
const workflowNames: ReadonlySet<string> = new Set([...AGENT_SESSION_WORKFLOW_TOOLS, ...chatTools]);
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
type Registration = { admissionRef: string; binding: AgentSessionWorkflowBinding; identity: string; key: string; target: ProxyTarget; clients: Map<string, AbortController> };
type LocalRequest = Parameters<NonNullable<ProxyTarget["local"]>>[0];

/** The local protocol adapter accepts only the bounded schemas it advertises. */
function matches(schema: unknown, value: unknown, depth = 0): boolean {
  if (depth > 40 || !object(schema)) return false;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(part => matches(part, value, depth + 1)).length === 1;
  if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "null" && value !== null || schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "string" && (typeof value !== "string" || typeof schema.maxLength === "number" && value.length > schema.maxLength
    || schema.format === "uuid" && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))) return false;
  if (schema.type === "integer" && (!Number.isSafeInteger(value) || typeof schema.minimum === "number" && (value as number) < schema.minimum || typeof schema.maximum === "number" && (value as number) > schema.maximum)) return false;
  if (schema.type === "array") {
    if (!Array.isArray(value) || typeof schema.maxItems === "number" && value.length > schema.maxItems || typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (schema.items && value.some(item => !matches(schema.items, item, depth + 1))) return false;
  }
  if (schema.type === "object") {
    if (!object(value)) return false;
    const properties = object(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    if (Object.entries(value).some(([key, entry]) => Object.hasOwn(properties, key) ? !matches(properties[key], entry, depth + 1) : schema.additionalProperties === false)) return false;
  }
  return true;
}

/** Consumer business operations have their own explicit admission; they never mint Core MCP access. */
export class ProviderWorkflow {
  readonly policy: McpToolPolicy;
  private registrations = new Map<string, Registration>();
  private preferences: AssistantSettings = { systemPrompt: "", mcpProviders: {}, mcpAutoAllow: {}, mcpSkillDigests: {} };
  constructor(private readonly authority: ProviderAuthority,
    notify: ConstructorParameters<typeof McpToolPolicy>[1], settled: ConstructorParameters<typeof McpToolPolicy>[2],
    autonomous: (runId: string) => boolean) {
    // Explicitly selected chat operations can inherit session mode when no tool rule overrides it.
    this.policy = new McpToolPolicy({ read: async () => structuredClone(this.preferences), transform: async change => {
      this.preferences = { ...this.preferences, ...await change(structuredClone(this.preferences)) }; return structuredClone(this.preferences);
    } }, notify, settled, 24 * 60 * 60 * 1000, (runId, tool) => autonomous(runId)
      && chatTools.has(tool)
      && this.registrations.get(runId)?.binding.tools?.some(name => name === tool) === true);
  }
  async configure(runId: string, admissionRef: string, binding: AgentSessionWorkflowBinding | undefined): Promise<void> {
    if (!binding) { this.close(runId); return; }
    if (!object(binding) || !object(binding.executor) || ![binding.executor.appId, binding.executor.installationId, binding.executor.key, binding.sessionId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
      || binding.tools && (!Array.isArray(binding.tools) || binding.tools.length > workflowNames.size || new Set(binding.tools).size !== binding.tools.length || binding.tools.some(name => !workflowNames.has(name))))
      throw new AgentApiError("workflow_binding_invalid", "Core returned an invalid explicit workflow binding.", 502);
    const existing = this.registrations.get(runId);
    if (existing) { if (existing.admissionRef !== admissionRef || hash(existing.binding) !== hash(binding)) throw new AgentApiError("workflow_binding_changed", "The admitted consumer workflow is immutable.", 409); return; }
    const identity = hash(binding), key = "workflow_" + hash(runId).slice(0, 24);
    const tools = workflowTools(binding.tools);
    (this.preferences.mcpDefaults ??= {})[key] = { identity, mode: binding.policy?.default ?? "ask" };
    this.preferences.mcpAutoAllow[key] = binding.policy?.autoAllowReadOnly === true;
    for (const [name, rule] of Object.entries(binding.policy?.tools ?? {})) {
      (this.preferences.mcpToolRules ??= {})[JSON.stringify([key, name])] = { identity, mode: rule.mode === "run" && !rule.definition ? "ask" : rule.mode, definition: rule.definition };
    }
    await this.policy.catalog(key, identity, tools);
    const registration: Registration = { admissionRef, binding: structuredClone(binding), identity, key, clients: new Map(),
      target: { appId: "hosty-workflow", url: "local:hosty-workflow",
        ...(binding.tools?.some(name => name === "skill_install" || name === "skill_discover") ? { nativeToolTimeoutMs: 240_000 } : {}),
        local: request => this.handle(runId, registration, request) } };
    this.registrations.set(runId, registration);
  }
  target(runId: string): ProxyTarget | undefined { return this.registrations.get(runId)?.target; }
  resolve(runId: string, decisionId: string, allowed: boolean): boolean { return this.policy.resolve(runId, decisionId, allowed); }
  close(runId: string): void {
    const registration = this.registrations.get(runId); this.registrations.delete(runId);
    if (registration) { for (const client of registration.clients.values()) client.abort(); this.policy.cancel(runId, registration.key); }
  }
  private async handle(runId: string, registration: Registration, request: LocalRequest): Promise<{ status: number; body?: unknown; headers?: { "mcp-session-id": string } }> {
    if (request.requestId && !registration.clients.has(request.requestId)) return { status: 404, body: { error: "Unknown native workflow client." } };
    if (request.method === "DELETE" && request.requestId) { registration.clients.get(request.requestId)!.abort(); registration.clients.delete(request.requestId); return { status: 202 }; }
    if (request.method !== "POST") return { status: 405, body: { error: "Use an MCP POST request." } };
    const clientSignal = registration.clients.get(request.requestId)?.signal;
    const signal = clientSignal ? AbortSignal.any([request.signal, clientSignal]) : request.signal;
    let rpc: Record<string, unknown>;
    try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)); if (!object(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") throw new Error(); rpc = value; }
    catch { return { status: 400, body: { error: "A single UTF-8 JSON-RPC request is required." } }; }
    if (rpc.id === undefined && rpc.method === "notifications/initialized") return { status: 202 };
    if (!(typeof rpc.id === "string" && rpc.id.length <= 256 || typeof rpc.id === "number" && Number.isSafeInteger(rpc.id))) return { status: 400, body: { error: "A bounded MCP request ID is required." } };
    const result = (value: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: value } });
    const guard = async () => {
      await request.guard();
      if (this.registrations.get(runId) !== registration || signal.aborted || request.requestId && !registration.clients.has(request.requestId)) throw new Error("The consumer workflow ended before dispatch.");
      await this.authority.renew(registration.admissionRef);
    };
    try {
      await guard();
      if (rpc.method === "initialize") {
        if (registration.clients.size >= 128) throw new Error("This run reached its bounded native workflow client limit.");
        const id = randomUUID(); registration.clients.set(id, new AbortController());
        return { ...result({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "hosty-workflow", version: "1" } }), headers: { "mcp-session-id": id } };
      }
      if (rpc.method === "ping") return result({});
      const tools = workflowTools(registration.binding.tools);
      const available = await this.policy.catalog(registration.key, registration.identity, tools);
      if (rpc.method === "tools/list") return result({ tools: available });
      if (rpc.method !== "tools/call" || !object(rpc.params) || typeof rpc.params.name !== "string") throw new Error("Use a declared workflow tool.");
      const name = rpc.params.name, tool = available.find(tool => tool.name === name);
      if (!tool) throw new Error("This workflow tool is disabled or outside the admitted selection.");
      const args = rpc.params.arguments ?? {};
      if (!matches(tool.inputSchema, args) || !object(args) || !fields(args, ["input", "source"]) || !object(args.input)) throw new Error("Workflow arguments must match the declared bounded input and optional qualified source schema.");
      const dispatch = await this.policy.authorize(runId, registration.key, registration.identity, JSON.stringify([request.requestId, rpc.id]), tool.name, args, signal, guard);
      await dispatch();
      const value = await this.authority.workflow(registration.admissionRef, tool.name.replaceAll("_", "-"), args.input, args.source as AgentSessionWorkflowRequest["source"]);
      const text = JSON.stringify(value); if (text === undefined || Buffer.byteLength(text) > 1024 * 1024) throw new Error("The workflow response exceeds its supported byte allowance.");
      return result({ content: [{ type: "text", text }] });
    } catch (error) { return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: error instanceof Error ? error.message : "Consumer workflow refused." } } }; }
  }
}
