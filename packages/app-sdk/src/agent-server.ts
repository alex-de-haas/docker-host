import { AgentApiError, AGENT_EVENT_VERSION, type AgentAttachmentChunk, type AgentCancelInput, type AgentCapabilities, type AgentConfiguration,
  type AgentConfigurationCreate, type AgentControlReceipt, type AgentEvent, type AgentMcpSelection, type AgentOperation,
  type AgentPendingDecision, type AgentProviderRef, type AgentResponseInput, type AgentRunControlInput, type AgentRunInput,
  type AgentRunSnapshot, type AgentSession, type AgentSessionCreate } from "./agent.js";

export const AGENT_COMMAND_MAX_BYTES = 1024 * 1024;
type ObjectValue = Record<string, unknown>;
type AgentParsedBase = { method: string; path: string; sessionId?: string; runId?: string; requestId?: string; connectionId?: string; attachmentId?: string; chunkIndex?: number; query: { cursor?: string; limit?: number; after?: string } };
export type AgentParsedRequest = AgentParsedBase & (
  | { operation: "sessions.create"; input: AgentSessionCreate }
  | { operation: "sessions.configure"; input: AgentConfigurationCreate }
  | { operation: "runs.start"; input: AgentRunInput }
  | { operation: "runs.respond"; input: AgentResponseInput }
  | { operation: "runs.discard"; input: { requestId: string } }
  | { operation: "runs.cancel"; input: AgentCancelInput }
  | { operation: "runs.control"; input: AgentRunControlInput }
  | { operation: "attachments.write"; input: AgentAttachmentChunk }
  | { operation: Exclude<AgentOperation, "sessions.create" | "sessions.configure" | "runs.start" | "runs.respond" | "runs.cancel" | "runs.discard" | "runs.control" | "attachments.write">; input: undefined }
);
function fail(message: string, status = 400, code = "invalid_input"): never { throw new AgentApiError(code, message, status); }
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
function shape(value: unknown, keys: readonly string[], label: string): asserts value is ObjectValue {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Invalid ${label}; unknown fields are not supported.`);
}
const bounded = (value: unknown, max = 256, empty = false): value is string => typeof value === "string" && (empty || value.trim().length > 0) && Buffer.byteLength(value) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const decimal = (value: unknown, zero = false): value is string => typeof value === "string" && (zero ? /^(?:0|[1-9][0-9]{0,39})$/ : /^[1-9][0-9]{0,39}$/).test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function array(value: unknown, max: number, label: string): asserts value is unknown[] { if (!Array.isArray(value) || value.length > max) fail(`Invalid bounded ${label}.`); }
function strings(value: unknown, max = 128, width = 256): asserts value is string[] {
  array(value, max, "string selection"); if (value.some(v => !bounded(v, width)) || new Set(value).size !== value.length) fail("Selections require distinct bounded strings.");
}
function provider(value: unknown): asserts value is AgentProviderRef {
  shape(value, ["appId", "installationId", "key", "implementationId"], "provider reference");
  if (value.implementationId != null && !bounded(value.implementationId, 128)) fail("Invalid named implementation ID.");
  if (![value.appId, value.installationId, value.key].every(v => bounded(v))) fail("An installation-qualified provider reference is required.");
}
function qualified(value: unknown): void { shape(value, ["provider", "id"], "qualified reference"); provider(value.provider); if (!opaque(value.id)) fail("A bounded resource ID is required."); }
function instructions(value: unknown): void {
  array(value, 16, "instructions"); const ids = new Set<string>();
  for (const item of value) { shape(item, ["id", "text"], "instruction"); if (!bounded(item.id, 128) || !bounded(item.text, 256 * 1024, true) || ids.has(item.id)) fail("Instructions require distinct IDs and bounded text."); ids.add(item.id); }
}
const capabilityName = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
function required(value: unknown): void { if (value !== undefined) { strings(value); if (value.some(item => !capabilityName.test(item))) fail("Use lowercase capability contract keys."); } }
export function validateAgentMcpSelection(value: unknown): asserts value is AgentMcpSelection {
  shape(value, ["targets", "connections"], "MCP selection");
  if (value.targets !== undefined) {
    array(value.targets, 16, "MCP targets"); const seen = new Set<string>();
    for (const item of value.targets) {
      shape(item, ["target", "tools", "policy"], "MCP target selection");
      if (!object(item.target)) fail("A logical MCP target is required.");
      if (item.target.kind === "core") shape(item.target, ["kind"], "Core MCP target");
      else { shape(item.target, ["kind", "appId", "installationId", "key"], "app MCP target"); if (item.target.kind !== "app") fail("Unknown MCP target kind."); provider({ appId: item.target.appId, installationId: item.target.installationId, key: item.target.key }); }
      const key = item.target.kind === "core" ? "core" : JSON.stringify([item.target.appId, item.target.installationId, item.target.key]); if (seen.has(key)) fail("Duplicate MCP target."); seen.add(key);
      if (item.tools !== undefined) strings(item.tools, 512);
      if (item.policy !== undefined) {
        shape(item.policy, ["default", "autoAllowReadOnly", "tools"], "MCP execution policy");
        if (!["ask", "run"].includes(String(item.policy.default)) || item.policy.autoAllowReadOnly !== undefined && typeof item.policy.autoAllowReadOnly !== "boolean") fail("Invalid MCP execution policy.");
        if (item.policy.tools !== undefined) {
          if (!object(item.policy.tools) || Object.keys(item.policy.tools).length > 512) fail("Invalid bounded tool policies.");
          for (const [name, policy] of Object.entries(item.policy.tools)) {
            shape(policy, ["mode", "definition"], "tool execution policy");
            if (!bounded(name) || !["ask", "run", "disabled"].includes(String(policy.mode)) || (policy.mode === "run" ? !digest(policy.definition) : policy.definition !== undefined)) fail("Explicit run policy requires the exact tool definition digest.");
          }
        }
      }
    }
  }
  if (value.connections !== undefined) {
    array(value.connections, 16, "external MCP connections"); const seen = new Set<string>();
    for (const connection of value.connections) { shape(connection, ["id", "revision"], "external MCP connection"); if (!opaque(connection.id) || !decimal(connection.revision) || seen.has(connection.id)) fail("An exact external connection revision is required."); seen.add(connection.id); }
  }
}
export function validateAgentConfiguration(value: unknown): asserts value is AgentConfiguration {
  shape(value, ["connection", "instructions", "systemPrompt", "skills", "nativeTools", "approvalMode", "predictions", "subagents"], "agent configuration");
  shape(value.connection, ["id", "revision"], "connection"); if (!opaque(value.connection.id) || !decimal(value.connection.revision)) fail("An exact provider connection revision is required.");
  if (value.instructions !== undefined) instructions(value.instructions);
  if (value.systemPrompt !== undefined) { shape(value.systemPrompt, ["mode", "text"], "system prompt addition"); if (value.systemPrompt.mode !== "append" || !bounded(value.systemPrompt.text, 256 * 1024, true)) fail("Only a bounded append-mode system addition is supported."); }
  if (value.skills !== undefined) {
    array(value.skills, 202, "skill selection"); const seen = new Set<string>();
    for (const item of value.skills) { shape(item, ["skillId", "expectedDigest"], "skill reference"); if (!digest(item.skillId) || item.expectedDigest !== undefined && !digest(item.expectedDigest) || seen.has(item.skillId)) fail("Skills require distinct Core IDs and optional content digests."); seen.add(item.skillId); }
  }
  if (value.nativeTools !== undefined && !["provider_default", "none"].includes(String(value.nativeTools))) fail("Unsupported native tool selection.");
  if (value.approvalMode !== undefined && !["normal", "autonomous"].includes(String(value.approvalMode))) fail("Unsupported approval mode.");
  if (value.predictions !== undefined) { shape(value.predictions, ["enabled"], "prediction configuration"); if (typeof value.predictions.enabled !== "boolean") fail("Predictions require an explicit enabled flag."); }
  if (value.subagents !== undefined) { shape(value.subagents, ["enabled", "maxConcurrency"], "native subagent selection"); if (typeof value.subagents.enabled !== "boolean" || value.subagents.maxConcurrency !== undefined && !integer(value.subagents.maxConcurrency, 1, 128)) fail("Invalid native subagent policy."); }
}
export function validateAgentAttachmentChunk(value: unknown, index?: number): asserts value is AgentAttachmentChunk {
  shape(value, ["digest", "sizeBytes", "mediaType", "name", "count", "data"], "attachment chunk");
  if (!digest(value.digest) || !integer(value.sizeBytes, 0, 25 * 1024 * 1024) || !bounded(value.mediaType, 128) || value.name !== undefined && !bounded(value.name)
    || !integer(value.count, 1, 50) || value.count !== Math.max(1, Math.ceil(value.sizeBytes / (512 * 1024))) || typeof value.data !== "string"
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) fail("Invalid bounded attachment chunk.");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.byteLength > 512 * 1024 || bytes.toString("base64") !== value.data || index !== undefined && (!integer(index, 0, value.count - 1) || bytes.byteLength !== (index < value.count - 1 ? 512 * 1024 : value.sizeBytes - index * 512 * 1024))) fail("Attachment chunk size/index does not match its immutable file.");
}
export function validateAgentSessionCreate(value: unknown): asserts value is AgentSessionCreate {
  shape(value, ["configuration", "correlation", "requiredCapabilities"], "session creation"); validateAgentConfiguration(value.configuration); required(value.requiredCapabilities);
  if (value.correlation !== undefined) { shape(value.correlation, ["conversation", "task"], "optional correlation"); if (value.correlation.conversation !== undefined) qualified(value.correlation.conversation); if (value.correlation.task !== undefined) qualified(value.correlation.task); }
}
export function validateAgentConfigurationCreate(value: unknown): asserts value is AgentConfigurationCreate {
  shape(value, ["requestId", "expectedSessionRevision", "configuration", "requiredCapabilities"], "configuration change");
  if (!uuid(value.requestId) || !decimal(value.expectedSessionRevision)) fail("A configuration change requires its stable UUID and expected session revision."); validateAgentConfiguration(value.configuration); required(value.requiredCapabilities);
}
export function validateAgentRunInput(value: unknown): asserts value is AgentRunInput {
  shape(value, ["expectedSessionRevision", "configurationRevision", "continuation", "input", "context", "selection", "resources", "mcp", "requiredCapabilities", "limits"], "run input");
  if (!decimal(value.expectedSessionRevision) || !decimal(value.configurationRevision) || !["start", "resume"].includes(String(value.continuation))) fail("A run requires exact revisions and an explicit continuation mode.");
  if (!object(value.input)) fail("Run input is required.");
  if ("decisionResponseRef" in value.input) {
    shape(value.input, ["decisionResponseRef"], "decision continuation input"); shape(value.input.decisionResponseRef, ["runId", "requestId"], "decision response reference");
    if (value.continuation !== "resume" || !opaque(value.input.decisionResponseRef.runId) || !uuid(value.input.decisionResponseRef.requestId)) fail("A decision continuation requires the original response and resume mode.");
  } else {
    shape(value.input, ["text", "attachments"], "new turn input"); if (!bounded(value.input.text, AGENT_COMMAND_MAX_BYTES)) fail("A nonempty bounded input is required.");
    if (value.input.attachments !== undefined) {
      array(value.input.attachments, 20, "attachments");
      for (const item of value.input.attachments) { shape(item, ["owner", "id", "digest", "sizeBytes", "mediaType", "name"], "immutable attachment reference"); provider(item.owner); if (!opaque(item.id) || !digest(item.digest) || !integer(item.sizeBytes, 0) || !bounded(item.mediaType, 128) || item.name !== undefined && !bounded(item.name)) fail("An authorized immutable attachment reference is required."); }
    }
  }
  if (value.context !== undefined) instructions(value.context);
  if (value.selection !== undefined) { shape(value.selection, ["model", "reasoningEffort"], "model selection"); if (![value.selection.model, value.selection.reasoningEffort].every(v => v === null || bounded(v))) fail("Explicit model/effort values or null are required."); }
  if (value.resources !== undefined) {
    array(value.resources, 16, "resource references");
    for (const resource of value.resources) { shape(resource, ["kind", "id", "revision", "provider"], "resource reference"); if (!bounded(resource.kind, 64) || !opaque(resource.id) || !bounded(resource.revision)) fail("A qualified revisioned context reference is required."); if (resource.provider !== undefined) provider(resource.provider); }
  }
  if (value.mcp !== undefined) validateAgentMcpSelection(value.mcp);
  required(value.requiredCapabilities);
  if (value.limits !== undefined) { shape(value.limits, ["maxDurationMs", "maxOutputTokens", "maxToolCalls"], "execution limits"); if (Object.values(value.limits).some(v => !integer(v))) fail("Execution limits must be positive safe integers."); }
}
function controlBase(value: ObjectValue): void { if (!uuid(value.requestId) || !uuid(value.expectedGeneration) || !decimal(value.expectedRevision)) fail("Controls require a stable request UUID, exact attempt generation and revision."); }
export function validateAgentResponseInput(value: unknown): asserts value is AgentResponseInput {
  shape(value, ["requestId", "expectedGeneration", "expectedRevision", "decisionId", "decisionRevision", "response"], "pending response"); controlBase(value);
  if (!opaque(value.decisionId) || !decimal(value.decisionRevision) || !object(value.response)) fail("Select one exact pending decision.");
  decisionResponse(value.response);
}
function decisionResponse(value: unknown): void {
  if (!object(value)) fail("A decision response is required.");
  if (value.kind === "approval") { shape(value, ["kind", "decision", "message"], "approval response"); if (!["allow", "deny"].includes(String(value.decision)) || value.message !== undefined && !bounded(value.message, 65536, true)) fail("Invalid approval response."); }
  else {
    shape(value, ["kind", "answers"], "question response"); if (value.kind !== "question" || !object(value.answers) || Object.keys(value.answers).length > 128) fail("Answers must match bounded question IDs.");
    for (const [id, answer] of Object.entries(value.answers)) { if (!opaque(id)) fail("Invalid question ID."); if (Array.isArray(answer)) { if (answer.length > 128 || answer.some(v => !bounded(v, 65536, true))) fail("Invalid question answers."); } else if (!bounded(answer, 65536, true)) fail("Invalid question answer."); }
  }
}
export function validateAgentCancelInput(value: unknown): asserts value is AgentCancelInput {
  shape(value, ["requestId", "expectedGeneration", "expectedRevision", "fenceIfNotAdmitted"], "cancellation"); if (!uuid(value.requestId)) fail("A cancellation request UUID is required.");
  if (value.fenceIfNotAdmitted !== undefined) {
    shape(value.fenceIfNotAdmitted, ["sessionId", "startDigest"], "delayed start fence");
    if (!opaque(value.fenceIfNotAdmitted.sessionId) || !digest(value.fenceIfNotAdmitted.startDigest) || value.expectedRevision !== undefined || value.expectedGeneration !== undefined) fail("A delayed-start fence requires only the exact intended session/digest.");
  } else if (value.expectedRevision !== undefined || value.expectedGeneration !== undefined) controlBase(value);
}
/** This validates an attestation's shape only. Providers must independently confirm actual native exit. */
export function validateAgentRunControlInput(value: unknown): asserts value is AgentRunControlInput {
  if (!object(value)) fail("An execution control is required.");
  const fields: Record<string, string[]> = { park: ["decisionId", "decisionRevision", "reason"], barrier: ["barrierId", "kind", "generation", "acknowledgedSequence", "snapshot"], reconcile: ["stopped", "evidence"], retire: [], liveConfigure: ["mcp"], mcpPolicy: ["mcp"], predictions: ["enabled"] };
  if (typeof value.command !== "string" || !fields[value.command]) fail("Unsupported execution control.", 422, "unsupported_capability");
  shape(value, ["requestId", "expectedGeneration", "expectedRevision", "command", ...fields[value.command]!], "execution control"); controlBase(value);
  if (value.command === "park" && (!opaque(value.decisionId) || !decimal(value.decisionRevision) || value.reason !== undefined && !bounded(value.reason, 8192))) fail("Parking requires the exact pending decision.");
  if (value.command === "barrier" && (!opaque(value.barrierId) || !["task_adoption", "child_wait", "source_rebind", "limits", "human_input"].includes(String(value.kind)) || !decimal(value.generation) || !decimal(value.acknowledgedSequence, true) || value.snapshot !== undefined && !bounded(value.snapshot, 8192))) fail("A barrier requires exact generation and acknowledged event sequence.");
  if (value.command === "reconcile" && (value.stopped !== true || value.evidence !== undefined && !bounded(value.evidence, 8192))) fail("Invalid stop-reconciliation attestation.");
  if (value.command === "liveConfigure" || value.command === "mcpPolicy") validateAgentMcpSelection(value.mcp);
  if (value.command === "predictions" && typeof value.enabled !== "boolean") fail("Invalid prediction control.");
}

/** Validate the actual relative path and bytes before Core introspection. Never trust body identity fields. */
export function validateAgentRequest(method: string, path: string, body: string | Uint8Array, expectedOperation?: AgentOperation): AgentParsedRequest {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\r\n]/.test(path) || /%(?:2f|5c|25)/i.test(path.split("?", 1)[0]!)) fail("Use a declared relative agent route.");
  if (Buffer.byteLength(body) > AGENT_COMMAND_MAX_BYTES) fail("The command exceeds its byte allowance.", 413, "payload_budget");
  const url = new URL(path, "http://agent.invalid"), route = url.pathname, query: AgentParsedBase["query"] = {};
  let operation: AgentOperation | undefined, sessionId: string | undefined, runId: string | undefined, requestId: string | undefined, connectionId: string | undefined, attachmentId: string | undefined, chunkIndex: number | undefined;
  const attachment = /^\/attachments\/([A-Za-z0-9_-]{1,256})\/chunks\/(0|[1-9][0-9]?)$/.exec(route);
  const match = /^\/(sessions|runs|connections)(?:\/([A-Za-z0-9_-]{1,256}))?(?:\/(configurations|runs|events|closure|discard|responses|stop|controls|models|usage))?(?:\/([A-Za-z0-9_-]{1,256}))?$/.exec(route);
  if (route === "/capabilities" && method === "GET") operation = "capabilities";
  else if (attachment && method === "PUT") { operation = "attachments.write"; attachmentId = attachment[1]; chunkIndex = Number(attachment[2]); if (!uuid(attachmentId)) fail("An attachment upload UUID is required."); }
  else if (match) {
    const [, root, id, sub, child] = match;
    if (root === "sessions") {
      sessionId = id;
      if (!id && !sub && method === "GET") operation = "sessions.list";
      else if (id && !sub && method === "GET") operation = "sessions.read";
      else if (id && !sub && method === "PUT") operation = "sessions.create";
      else if (id && sub === "configurations" && child && method === "PUT") { operation = "sessions.configure"; requestId = child; }
      else if (id && sub === "runs" && child && method === "PUT") { operation = "runs.start"; runId = child; }
    } else if (root === "runs" && id) {
      runId = id;
      if (!sub && method === "GET") operation = "runs.read";
      else if (sub === "closure" && !child && method === "GET") operation = "runs.closure";
      else if (sub === "events" && !child && method === "GET") operation = "runs.events";
      else if (sub === "responses" && !child && method === "POST") operation = "runs.respond";
      else if (sub === "discard" && !child && method === "PUT") operation = "runs.discard";
      else if (sub === "stop" && !child && method === "PUT") operation = "runs.cancel";
      else if (sub === "controls" && !child && method === "POST") operation = "runs.control";
      else if (sub === "controls" && child && method === "GET") { operation = "runs.controls.read"; requestId = child; }
    } else if (root === "connections") {
      connectionId = id;
      if (!id && !sub && method === "GET") operation = "connections.list";
      else if (id && sub === "models" && !child && method === "GET") operation = "connections.models";
      else if (id && sub === "usage" && !child && method === "GET") operation = "connections.usage";
    }
  }
  if (!operation || expectedOperation !== undefined && expectedOperation !== operation) fail("Use a declared agent v2 operation.", 422, "unsupported_operation");
  const allowed = operation === "runs.events" ? ["after"] : ["sessions.list", "connections.list"].includes(operation) ? ["cursor", "limit"] : [];
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail("Unsupported or repeated query field.");
    if (key === "limit") { if (!/^[1-9][0-9]*$/.test(value) || !integer(Number(value), 1, 100)) fail("Use a page limit between 1 and 100."); query.limit = Number(value); }
    else { if (!bounded(value, 8192) || /[\r\n]/.test(value)) fail("Invalid replay/page cursor."); if (key === "after") query.after = value; else query.cursor = value; }
  }
  let input: unknown;
  if (method === "GET") { if (Buffer.byteLength(body)) fail("Agent reads have no command body."); }
  else {
    try { input = JSON.parse(typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { fail("A valid UTF-8 JSON command is required."); }
    if (["sessions.create", "sessions.configure", "runs.start"].includes(operation) && (!uuid(sessionId) || operation === "runs.start" && !uuid(runId))) fail("Creation and submission IDs must be stable UUIDs.");
    if (operation === "sessions.create") validateAgentSessionCreate(input);
    else if (operation === "sessions.configure") { validateAgentConfigurationCreate(input); if (input.requestId !== requestId) fail("Configuration request ID must equal its path ID."); }
    else if (operation === "runs.start") validateAgentRunInput(input);
    else if (operation === "runs.respond") validateAgentResponseInput(input);
    else if (operation === "runs.discard") {
      shape(input, ["requestId"], "delivery discard");
      if (!uuid(input.requestId)) fail("A discard request UUID is required.");
    }
    else if (operation === "runs.cancel") validateAgentCancelInput(input);
    else if (operation === "runs.control") validateAgentRunControlInput(input);
    else if (operation === "attachments.write") validateAgentAttachmentChunk(input, chunkIndex);
  }
  return { operation, method, path, input, sessionId, runId, requestId, connectionId, attachmentId, chunkIndex, query } as AgentParsedRequest;
}
export function agentReplayCursor(after?: string | null, lastEventId?: string | null): string | undefined {
  if (after && lastEventId && after !== lastEventId) fail("Conflicting replay cursors.");
  const value = after || lastEventId || undefined; if (value && (!bounded(value, 8192) || /[\r\n]/.test(value))) fail("Invalid replay cursor."); return value;
}
function responseProblem(message: string): never { return fail(message, 502, "response_invalid"); }
function finiteJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every(item => finiteJson(item, depth + 1, seen));
  seen.delete(value); return valid;
}
function contextUsage(value: unknown): boolean { return value === null || object(value) && finiteJson(value); }
function source(value: unknown): void { if (!object(value) || !opaque(value.agentId) || value.parentAgentId !== undefined && !opaque(value.parentAgentId) || value.parentToolCallId !== undefined && (!opaque(value.parentToolCallId) || !opaque(value.parentAgentId))) responseProblem("Invalid execution source."); }
function validateChildAgent(agent: unknown): void {
  source(agent);
  if (!object(agent) || !["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled", "unknown"].includes(String(agent.state))
    || [agent.stopConfirmed, agent.promptTruncated, agent.responseTruncated].some(flag => flag !== undefined && typeof flag !== "boolean")
    || [agent.prompt, agent.response].some(text => text !== undefined && (typeof text !== "string" || text.length > 65536 && [...text].length > 65536))) responseProblem("Invalid child agent observation.");
}
export function validateAgentPendingDecision(value: unknown): asserts value is AgentPendingDecision {
  if (!object(value) || !opaque(value.id) || !decimal(value.revision) || !["approval", "question"].includes(String(value.kind)) || !["continue_run", "next_turn"].includes(String(value.delivery))) responseProblem("Invalid pending decision.");
  if (value.source !== undefined) source(value.source);
  if (value.questions !== undefined) { if (!Array.isArray(value.questions) || value.questions.length > 128) responseProblem("Invalid question schema."); for (const q of value.questions) { if (!object(q) || !opaque(q.id) || !bounded(q.text, 65536) || q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => !object(o) || !opaque(o.id) || !bounded(o.label, 8192)))) responseProblem("Invalid question schema."); } }
}
export function validateAgentRunClosure(value: unknown): asserts value is import("./agent.js").AgentRunClosure {
  if (!object(value)) responseProblem("Missing execution closure.");
  qualified(value.ref);
  if (!opaque(value.sessionId) || !uuid(value.generation) || !decimal(value.revision, true) || typeof value.stopConfirmed !== "boolean"
    || !["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled", "unknown"].includes(String(value.state))
    || !["preparing", "executing", "waiting", "finalizing", "cancelling", "parked", "interrupted", "terminal"].includes(String(value.phase))
    || ["succeeded", "failed", "cancelled"].includes(String(value.state)) && !value.stopConfirmed) responseProblem("Invalid execution closure.");
  if (value.pendingContinuations !== undefined) {
    array(value.pendingContinuations, 256, "continuation references");
    for (const item of value.pendingContinuations) {
      if (!object(item) || !uuid(item.requestId) || !["pending", "awaiting_authorization", "admitted", "superseded"].includes(String(item.state)))
        responseProblem("Invalid continuation receipt.");
      qualified(item.run);
    }
  }
}
export function validateAgentRunSnapshot(value: unknown): asserts value is AgentRunSnapshot {
  if (!object(value)) responseProblem("A run snapshot is required.");
  qualified(value.ref);
  if (!opaque(value.sessionId) || !uuid(value.generation) || !decimal(value.revision, true) || !decimal(value.configurationRevision) || !decimal(value.lastSequence, true)
    || !["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled", "unknown"].includes(String(value.state))
    || !["preparing", "executing", "waiting", "finalizing", "cancelling", "parked", "interrupted", "terminal"].includes(String(value.phase))
    || typeof value.stopConfirmed !== "boolean" || !["current", "last_known", "unavailable"].includes(String(value.freshness)) || !bounded(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || !bounded(value.cursor, 8192)
    || !Array.isArray(value.pending) || value.pending.length > 256 || !object(value.effects) || !["known", "unknown"].includes(String(value.effects.certainty))) responseProblem("Invalid atomic run snapshot.");
  for (const decision of value.pending) validateAgentPendingDecision(decision);
  strings(value.effects.unresolvedCallIds, 1024);
  if (value.coverage !== undefined) { shape(value.coverage, ["messages", "tools", "decisions"], "snapshot coverage"); if (![value.coverage.messages, value.coverage.tools].every(item => item === "complete" || item === "truncated") || value.coverage.decisions !== undefined && !["complete", "truncated"].includes(String(value.coverage.decisions))) responseProblem("Invalid snapshot coverage."); }
  if (value.executionUsage !== undefined && (!object(value.executionUsage) || !decimal(value.executionUsage.sequence, true) || !integer(value.executionUsage.activeMs, 0) || typeof value.executionUsage.unknown !== "boolean")) responseProblem("Invalid durable execution usage.");
  if (value.latestContext !== undefined) {
    const latest = value.latestContext;
    if (!object(latest) || Object.keys(latest).some(key => !["sequence", "usage"].includes(key)) || !decimal(latest.sequence)
      || BigInt(latest.sequence) > BigInt(value.lastSequence) || !Object.hasOwn(latest, "usage") || !contextUsage(latest.usage))
      responseProblem("Invalid latest context observation or snapshot watermark.");
  }
  if (value.decisions !== undefined) { array(value.decisions, 256, "decision history"); for (const item of value.decisions) { if (!object(item) || !["pending", "resolved", "superseded", "unknown"].includes(String(item.state))) responseProblem("Invalid retained decision state."); validateAgentPendingDecision(item.decision); if (item.response !== undefined) { try { decisionResponse(item.response); } catch { responseProblem("Invalid retained decision response."); } } } }
  if (value.pendingContinuations !== undefined) { array(value.pendingContinuations, 256, "continuation references"); for (const item of value.pendingContinuations) { if (!object(item) || !uuid(item.requestId) || !["pending", "awaiting_authorization", "admitted", "superseded"].includes(String(item.state))) responseProblem("Invalid reserved continuation reference."); qualified(item.run); } }
  if (["succeeded", "failed", "cancelled"].includes(String(value.state)) && !value.stopConfirmed) responseProblem("A final run requires confirmed native stop.");
  if (value.messages !== undefined && (!Array.isArray(value.messages) || value.messages.length > 4096 || value.messages.some(m => !object(m) || !opaque(m.id) || typeof m.text !== "string"))) responseProblem("Invalid snapshot message identities.");
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > 4096 || value.tools.some(t => !object(t) || !opaque(t.id) || !bounded(t.name)))) responseProblem("Invalid snapshot tool identities.");
  for (const message of (value.messages ?? []) as ObjectValue[]) {
    if (!["assistant", "user", "system"].includes(String(message.role)) || !["streaming", "complete", "interrupted"].includes(String(message.state))) responseProblem("Invalid snapshot message state.");
    if (message.source !== undefined) source(message.source);
  }
  for (const tool of (value.tools ?? []) as ObjectValue[]) {
    if (!["running", "completed", "failed", "cancelled", "unknown"].includes(String(tool.state))) responseProblem("Invalid snapshot tool state.");
    if (tool.source !== undefined) source(tool.source);
    if (tool.command !== undefined) {
      const command = tool.command;
      if (!object(command) || !["completed", "failed", "cancelled", "unknown"].includes(String(command.status)) || command.exitCode !== undefined && !Number.isSafeInteger(command.exitCode) || command.durationMs !== undefined && !integer(command.durationMs, 0) || command.summary !== undefined && !bounded(command.summary, 65536, true)) responseProblem("Invalid retained command result.");
    }
  }
  if (value.agents !== undefined) { array(value.agents, 1024, "agent inventory"); for (const agent of value.agents) validateChildAgent(agent); }
  if (Buffer.byteLength(JSON.stringify(value)) > AGENT_COMMAND_MAX_BYTES) responseProblem("Snapshot byte allowance exceeded.");
}
const eventTypes = ["run.updated", "session.bound", "selection.updated", "message.started", "message.delta", "message.completed", "tool.started", "tool.output", "tool.completed", "decision.requested", "decision.updated", "decision.resolved", "control.updated", "result.available", "usage.updated", "context.updated", "agent.updated", "warning", "extension"];
export function validateAgentEvent(value: unknown): asserts value is AgentEvent {
  if (!object(value) || value.schemaVersion !== AGENT_EVENT_VERSION || !opaque(value.runId) || !uuid(value.generation) || !decimal(value.sequence) || !decimal(value.revision, true)
    || !bounded(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt)) || !eventTypes.includes(String(value.type)) || !object(value.data)) responseProblem("Unsupported or invalid agent event envelope.");
  source(value.source);
  const data = value.data;
  if (value.type === "run.updated") {
    validateAgentRunSnapshot(data.snapshot);
    if (data.snapshot.ref.id !== value.runId || data.snapshot.generation !== value.generation || data.snapshot.lastSequence !== value.sequence || data.snapshot.revision !== value.revision) responseProblem("Run event snapshot does not match its atomic watermark.");
  }
  else if (String(value.type).startsWith("message.") && !opaque(data.messageId)) responseProblem("Message events require a stable message ID.");
  else if (String(value.type).startsWith("tool.") && !opaque(data.toolCallId)) responseProblem("Tool events require a stable tool-call ID.");
  else if (String(value.type).startsWith("decision.") && !opaque(data.decisionId)) responseProblem("Decision events require a stable decision ID.");
  else if (value.type === "control.updated" && !uuid(data.requestId)) responseProblem("Control events require a stable request UUID.");
  else if (value.type === "session.bound" && !opaque(data.sessionId)) responseProblem("Session events require a public session ID.");
  else if (value.type === "context.updated" && (!Object.hasOwn(data, "usage") || !contextUsage(data.usage))) responseProblem("Context events require nullable JSON observation data.");
  else if (value.type === "extension" && (!bounded(data.namespace, 256) || data.required === true)) responseProblem("Extensions cannot carry required protocol semantics.");
  if (value.type === "agent.updated" && data.agent !== undefined) validateChildAgent(data.agent);
  if (data.decision !== undefined) validateAgentPendingDecision(data.decision);
  if (data.response !== undefined) { try { decisionResponse(data.response); } catch { responseProblem("Invalid event decision response."); } }
  if (value.type === "usage.updated" && data.execution !== undefined && (!object(data.execution) || !decimal(data.execution.sequence, true) || !integer(data.execution.activeMs, 0) || typeof data.execution.unknown !== "boolean")) responseProblem("Invalid event execution usage.");
  if (object(data.decision) && data.decision.id !== data.decisionId) responseProblem("Decision event identity mismatch.");
  if ((value.type === "message.delta" || value.type === "tool.output") && typeof (value.type === "message.delta" ? data.text : data.output) !== "string") responseProblem("Streamed output requires bounded text.");
  if (Buffer.byteLength(JSON.stringify(value)) > AGENT_COMMAND_MAX_BYTES) responseProblem("Event byte allowance exceeded.");
}
export function validateAgentCapabilities(value: unknown): asserts value is AgentCapabilities {
  if (!object(value) || value.version !== 2 || !Array.isArray(value.eventVersions) || !value.eventVersions.includes(AGENT_EVENT_VERSION) || !object(value.limits) || !object(value.configuration)) responseProblem("Unsupported agent contract.");
  strings(value.capabilities, 128); strings(value.configuration.resumeCompatible, 32);
  if (value.capabilities.some(item => !capabilityName.test(item))) responseProblem("Invalid capability contract key.");
  for (const key of ["maxCommandBytes", "maxEventBytes", "maxSnapshotBytes", "maxReplayBytes", "replayRetentionMs", "maxControls", "maxPageSize"]) if (!integer(value.limits[key])) responseProblem("Invalid agent limits.");
}
export function validateAgentSession(value: unknown): asserts value is AgentSession {
  if (!object(value)) responseProblem("A session is required."); qualified(value.ref);
  if (!decimal(value.revision) || !decimal(value.configurationRevision) || !digest(value.configurationDigest) || !["not_created", "available", "missing", "unavailable", "unknown"].includes(String(value.nativeState)) || !Array.isArray(value.resolvedSkills)) responseProblem("Invalid agent session.");
  if (value.activeRun !== null) qualified(value.activeRun);
  for (const item of value.resolvedSkills) if (!object(item) || !digest(item.skillId) || !digest(item.digest)) responseProblem("Invalid resolved skill digest.");
}
export function validateAgentControlReceipt(value: unknown): asserts value is AgentControlReceipt {
  if (!object(value) || !uuid(value.requestId) || !["accepted", "applied", "rejected", "superseded", "unknown"].includes(String(value.state)) || !decimal(value.revision, true)) responseProblem("Invalid control receipt."); qualified(value.run);
  if (value.continuation !== undefined) { if (!object(value.continuation) || !["pending", "awaiting_authorization", "admitted", "superseded"].includes(String(value.continuation.state))) responseProblem("Invalid reserved continuation."); qualified(value.continuation.run); }
}
export function encodeAgentSseEvent(event: AgentEvent, cursor: string): string {
  validateAgentEvent(event); agentReplayCursor(cursor);
  if (!cursor) fail("A persisted replay cursor is required.");
  return `id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
}
