/** Machine-readable public contract. Payload-free Core admission is a separate platform API. */
type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength = 256): Schema => ({ type: "string", minLength: 1, maxLength });
const id: Schema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,256}$" };
const uuid: Schema = { type: "string", format: "uuid" };
const revision: Schema = { type: "string", pattern: "^[1-9][0-9]{0,39}$" };
const sequence: Schema = { type: "string", pattern: "^(0|[1-9][0-9]{0,39})$" };
const digest: Schema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const boolean: Schema = { type: "boolean" };
const positive: Schema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nullableText: Schema = { type: ["string", "null"], maxLength: 256 };
const list = (items: Schema, maxItems = 128): Schema => ({ type: "array", maxItems, items });
const unique = (items: Schema, maxItems = 128): Schema => ({ ...list(items, maxItems), uniqueItems: true });
const object = (properties: Record<string, Schema>, required = Object.keys(properties), additionalProperties: boolean | Schema = false): Schema => ({ type: "object", properties, required, additionalProperties });
const capability = unique({ ...text(), pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$" }, 128);
const refProperties = { appId: text(), installationId: text(), key: text() };
const baseControl = { requestId: uuid, expectedGeneration: uuid, expectedRevision: revision };
const terminalStates = ["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled", "unknown"];
const phases = ["preparing", "executing", "waiting", "finalizing", "cancelling", "parked", "interrupted", "terminal"];

const historyObservation = {
  sessionId: id, runId: id, generation: uuid, principalId: text(512), userId: text(512),
  item: { oneOf: [object({ kind: { const: "snapshot" }, snapshot: ref("RunSnapshot") }),
    object({ kind: { const: "event" }, event: ref("Event"), cursor: text(8192) })] },
};
export const AGENT_SCHEMAS: Record<string, Schema> = {
  ProviderRef: object({ ...refProperties, implementationId: { anyOf: [text(128), { type: "null" }] } }, Object.keys(refProperties)),
  QualifiedRef: object({ provider: ref("ProviderRef"), id }),
  Instruction: object({ id: text(128), text: { type: "string", maxLength: 262144 } }),
  Skill: object({ skillId: digest, expectedDigest: digest }, ["skillId"]),
  McpTarget: { oneOf: [object({ kind: { const: "core" } }), object({ kind: { const: "app" }, ...refProperties })] },
  McpPolicy: object({ default: { enum: ["ask", "run"] }, autoAllowReadOnly: boolean, tools: { type: "object", maxProperties: 512, propertyNames: text(), additionalProperties: { oneOf: [object({ mode: { const: "run" }, definition: digest }), object({ mode: { enum: ["ask", "disabled"] } })] } } }, ["default"]),
  McpSelection: object({ targets: list(object({ target: ref("McpTarget"), tools: unique(text(), 512), policy: ref("McpPolicy") }, ["target"]), 16), connections: list(object({ id, revision }), 16) }, []),
  Configuration: object({ connection: object({ id, revision }), instructions: list(ref("Instruction"), 16),
    systemPrompt: object({ mode: { const: "append" }, text: { type: "string", maxLength: 262144 } }), skills: list(ref("Skill"), 202),
    nativeTools: { enum: ["provider_default", "none"] }, approvalMode: { enum: ["normal", "autonomous"] }, predictions: object({ enabled: boolean }), subagents: object({ enabled: boolean, maxConcurrency: { type: "integer", minimum: 1, maximum: 128 } }, ["enabled"]) }, ["connection"]),
  SessionCreate: object({ configuration: ref("Configuration"), requiredCapabilities: capability,
    correlation: object({ conversation: ref("QualifiedRef"), task: ref("QualifiedRef") }, []) }, ["configuration"]),
  ConfigurationCreate: object({ requestId: uuid, expectedSessionRevision: revision, configuration: ref("Configuration"), requiredCapabilities: capability }, ["requestId", "expectedSessionRevision", "configuration"]),
  Attachment: object({ owner: ref("ProviderRef"), id, digest, sizeBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, mediaType: text(128), name: text() }, ["owner", "id", "digest", "sizeBytes", "mediaType"]),
  AttachmentChunk: object({ digest, sizeBytes: { type: "integer", minimum: 0, maximum: 26214400 }, mediaType: text(128), name: text(), count: { type: "integer", minimum: 1, maximum: 50 }, data: { type: "string", maxLength: 699052, contentEncoding: "base64" } }, ["digest", "sizeBytes", "mediaType", "count", "data"]),
  AttachmentChunkReceipt: object({ attachment: { oneOf: [ref("Attachment"), { type: "null" }] }, received: unique({ type: "integer", minimum: 0, maximum: 49 }, 50) }),
  Resource: object({ kind: text(64), id, revision: text(), provider: ref("ProviderRef") }, ["kind", "id", "revision"]),
  Selection: object({ model: nullableText, reasoningEffort: nullableText }),
  RunInput: object({ expectedSessionRevision: revision, configurationRevision: revision, continuation: { enum: ["start", "resume"] },
    input: { oneOf: [object({ text: text(1048576), attachments: list(ref("Attachment"), 20) }, ["text"]), object({ decisionResponseRef: object({ runId: id, requestId: uuid }) })] },
    context: list(ref("Instruction"), 16), selection: ref("Selection"), resources: list(ref("Resource"), 16), mcp: ref("McpSelection"), requiredCapabilities: capability,
    limits: object({ maxDurationMs: positive, maxOutputTokens: positive, maxToolCalls: positive }, []) }, ["expectedSessionRevision", "configurationRevision", "continuation", "input"]),
  DecisionResponse: { oneOf: [object({ kind: { const: "approval" }, decision: { enum: ["allow", "deny"] }, message: { type: "string", maxLength: 65536 } }, ["kind", "decision"]),
    object({ kind: { const: "question" }, answers: { type: "object", maxProperties: 128, propertyNames: id, additionalProperties: { oneOf: [{ type: "string", maxLength: 65536 }, list({ type: "string", maxLength: 65536 }, 128)] } } })] },
  ResponseInput: object({ ...baseControl, decisionId: id, decisionRevision: revision, response: ref("DecisionResponse") }),
  CancelInput: { oneOf: [object(baseControl), object({ requestId: uuid, fenceIfNotAdmitted: object({ sessionId: id, startDigest: digest }) })] },
  ControlInput: { oneOf: [
    object({ ...baseControl, command: { const: "park" }, decisionId: id, decisionRevision: revision, reason: text(8192) }, [...Object.keys(baseControl), "command", "decisionId", "decisionRevision"]),
    object({ ...baseControl, command: { const: "barrier" }, barrierId: id, kind: { enum: ["task_adoption", "child_wait", "source_rebind", "limits", "human_input"] }, generation: revision, acknowledgedSequence: sequence, snapshot: text(8192) }, [...Object.keys(baseControl), "command", "barrierId", "kind", "generation", "acknowledgedSequence"]),
    object({ ...baseControl, command: { const: "reconcile" }, stopped: { const: true }, evidence: text(8192) }, [...Object.keys(baseControl), "command", "stopped"]),
    object({ ...baseControl, command: { const: "retire" } }),
    object({ ...baseControl, command: { const: "liveConfigure" }, mcp: ref("McpSelection") }),
    object({ ...baseControl, command: { const: "mcpPolicy" }, mcp: ref("McpSelection") }),
    object({ ...baseControl, command: { const: "predictions" }, enabled: boolean }),
  ] },
  Source: object({ agentId: id, parentAgentId: id, parentToolCallId: id }, ["agentId"]),
  ChildAgent: object({ agentId: id, parentAgentId: id, parentToolCallId: id, state: { enum: terminalStates }, stopConfirmed: boolean,
      prompt: { type: "string", maxLength: 65536 }, response: { type: "string", maxLength: 65536 }, promptTruncated: boolean, responseTruncated: boolean }, ["agentId", "state"], true),
  PendingDecision: object({ id, revision, kind: { enum: ["approval", "question"] }, delivery: { enum: ["continue_run", "next_turn"] }, source: ref("Source"), title: text(65536), toolCallId: id, toolName: text(), input: {},
    questions: list(object({ id, text: text(65536), header: text(1024), allowText: boolean, multiple: boolean, required: boolean,
      options: list(object({ id, label: text(8192), description: text(8192), preview: text(65536) }, ["id", "label"]), 128) }, ["id", "text"]), 128) }, ["id", "revision", "kind", "delivery"], true),
  Result: object({ status: { enum: ["succeeded", "failed", "cancelled"] }, messageId: id, text: { type: "string", maxLength: 1048576 }, value: {}, schemaValid: boolean, error: ref("ErrorDetail") }, ["status"], true),
  Message: object({ id, source: ref("Source"), role: { enum: ["assistant", "user", "system"] }, text: { type: "string", maxLength: 1048576 }, state: { enum: ["streaming", "complete", "interrupted"] } }, ["id", "role", "text", "state"], true),
  Tool: object({ id, source: ref("Source"), name: text(), input: {}, output: { type: "string", maxLength: 1048576 }, state: { enum: ["running", "completed", "failed", "cancelled", "unknown"] }, truncated: boolean,
    command: object({ status: { enum: ["completed", "failed", "cancelled", "unknown"] }, exitCode: { type: "integer" }, durationMs: { type: "integer", minimum: 0 }, summary: text(65536) }, ["status"]) }, ["id", "name", "state"], true),
  RunSnapshot: object({ ref: ref("QualifiedRef"), sessionId: id, generation: uuid, revision: sequence,
    state: { enum: terminalStates }, phase: { enum: phases }, stopConfirmed: boolean, freshness: { enum: ["current", "last_known", "unavailable"] }, observedAt: { type: "string", format: "date-time" },
    configurationRevision: revision, lastSequence: sequence, cursor: text(8192), pending: list(ref("PendingDecision"), 256),
    effects: object({ certainty: { enum: ["known", "unknown"] }, unresolvedCallIds: unique(id, 1024) }), result: ref("Result"), messages: list(ref("Message"), 4096), tools: list(ref("Tool"), 4096),
    agents: list(ref("ChildAgent"), 1024),
    selection: object({ requested: ref("Selection"), effective: ref("Selection") }), admissionRef: text(),
    coverage: object({ messages: { enum: ["complete", "truncated"] }, tools: { enum: ["complete", "truncated"] }, decisions: { enum: ["complete", "truncated"] } }, ["messages", "tools"]),
    executionUsage: object({ sequence, activeMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, unknown: boolean }),
    latestContext: { ...object({ sequence: revision, usage: { type: ["object", "null"], additionalProperties: true } }),
      description: "Latest root context.updated observation within the snapshot watermark; its canonical positive sequence is at most lastSequence. Null usage explicitly clears the observation. Absence means no retained observation. Payloads share the bounded snapshot/event JSON byte allowance." },
    decisions: list(object({ decision: ref("PendingDecision"), state: { enum: ["pending", "resolved", "superseded", "unknown"] }, response: ref("DecisionResponse") }, ["decision", "state"]), 256),
    pendingContinuations: list(object({ requestId: uuid, run: ref("QualifiedRef"), state: { enum: ["pending", "awaiting_authorization", "admitted", "superseded"] } }), 256) },
    ["ref", "sessionId", "generation", "revision", "state", "phase", "stopConfirmed", "freshness", "observedAt", "configurationRevision", "lastSequence", "cursor", "pending", "effects"], true),
  HistoryObservation: object(historyObservation),
  LiveHistoryReady: object({ through: text(8192) }),
  LiveHistoryObservation: object({ ...historyObservation, epoch: uuid, sessionPosition: positive, sourceHistoryIncomplete: { const: true } }, [...Object.keys(historyObservation), "epoch"]),
  HistoryStates: object({ through: text(8192), nextSession: nullableText, sessions: list(object({
    sessionId: id, userId: text(512), principalId: text(512), epoch: uuid, head: positive, snapshot: ref("RunSnapshot"), sourceHistoryIncomplete: { const: true },
  }, ["sessionId", "userId", "principalId", "epoch", "head", "snapshot"]), 100) }),
  HistoryRange: object({ nextPosition: { type: ["integer", "null"], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    observations: list(object({ ...historyObservation, cursor: text(8192), epoch: uuid, sessionPosition: positive, sourceHistoryIncomplete: { const: true } },
      [...Object.keys(historyObservation), "cursor", "epoch", "sessionPosition"]), 100) }),
  HistoryPage: object({ observations: list(object({ ...historyObservation, cursor: text(8192) }), 100),
    through: text(8192), nextCursor: { type: ["string", "null"] } }),
  Session: object({ ref: ref("QualifiedRef"), revision, configurationRevision: revision, configurationDigest: digest,
    nativeState: { enum: ["not_created", "available", "missing", "unavailable", "unknown"] }, activeRun: { oneOf: [ref("QualifiedRef"), { type: "null" }] },
    resolvedSkills: list(object({ skillId: digest, digest }), 202), configuration: ref("Configuration"), correlation: object({ conversation: ref("QualifiedRef"), task: ref("QualifiedRef") }, []) },
    ["ref", "revision", "configurationRevision", "configurationDigest", "nativeState", "activeRun", "resolvedSkills"], true),
  ControlReceipt: object({ requestId: uuid, state: { enum: ["accepted", "applied", "rejected", "superseded", "unknown"] }, run: ref("QualifiedRef"), revision: sequence, generation: uuid, error: ref("ErrorDetail"),
    continuation: object({ run: ref("QualifiedRef"), state: { enum: ["pending", "awaiting_authorization", "admitted", "superseded"] } }) }, ["requestId", "state", "run", "revision"], true),
  ErrorDetail: object({ code: text(), message: { type: "string", maxLength: 8192 }, retryable: boolean, requestId: uuid, details: { type: "object", additionalProperties: true } }, ["code", "message", "retryable"], true),
  Error: object({ error: ref("ErrorDetail") }),
  Connection: object({ id, revision, name: text(), ready: boolean, reason: text(8192), capabilities: capability }, ["id", "revision", "name", "ready"], true),
  ModelCatalog: object({ revision: text(256), models: list(object({ id: text(), name: text(), reasoningEfforts: list(nullableText), defaultReasoningEffort: nullableText, capabilities: capability, unavailableReason: text(8192) }, ["id", "reasoningEfforts"], true), 1000), defaultModel: nullableText, nextCursor: { type: ["string", "null"], maxLength: 8192 } }, ["revision", "models", "defaultModel"], true),
  Capabilities: object({ version: { const: 1 }, eventVersions: unique(text(), 16), capabilities: capability,
    limits: object({ maxCommandBytes: positive, maxEventBytes: positive, maxSnapshotBytes: positive, maxReplayBytes: positive, replayRetentionMs: positive, maxControls: positive, maxPageSize: positive, maxDurationMs: positive, maxSkillSnapshotBytes: positive, maxSkillSnapshotFiles: positive },
      ["maxCommandBytes", "maxEventBytes", "maxSnapshotBytes", "maxReplayBytes", "replayRetentionMs", "maxControls", "maxPageSize"], true), configuration: object({ resumeCompatible: unique(text(), 32) }) }, ["version", "eventVersions", "capabilities", "limits", "configuration"], true),
};
const eventNames = ["run.updated", "session.bound", "selection.updated", "message.started", "message.delta", "message.completed", "tool.started", "tool.output", "tool.completed", "decision.requested", "decision.updated", "decision.resolved", "control.updated", "result.available", "usage.updated", "context.updated", "agent.updated", "warning", "extension"];
AGENT_SCHEMAS.Event = { ...object({ schemaVersion: { const: "agent-event.1" }, runId: id, generation: uuid, sequence: revision, revision: sequence,
  occurredAt: { type: "string", format: "date-time" }, type: { enum: eventNames }, source: ref("Source"), data: { type: "object", additionalProperties: true } }),
  allOf: eventNames.map(name => ({ if: { properties: { type: { const: name } } }, then: { properties: { data:
    name === "run.updated" ? object({ snapshot: ref("RunSnapshot") }, ["snapshot"], true)
      : name.startsWith("message.") ? object({ messageId: id, text: { type: "string" } }, name === "message.delta" ? ["messageId", "text"] : ["messageId"], true)
      : name.startsWith("tool.") ? object({ toolCallId: id, name: text(), output: { type: "string" } }, name === "tool.output" ? ["toolCallId", "output"] : ["toolCallId"], true)
      : name.startsWith("decision.") ? object({ decisionId: id, decision: ref("PendingDecision") }, ["decisionId"], true)
      : name === "control.updated" ? object({ requestId: uuid, receipt: ref("ControlReceipt") }, ["requestId"], true)
      : name === "session.bound" ? object({ sessionId: id }, ["sessionId"], true)
      : name === "agent.updated" ? object({ agent: ref("ChildAgent") }, [], true)
      : name === "context.updated" ? object({ usage: { type: ["object", "null"], additionalProperties: true } }, ["usage"], true)
      : name === "extension" ? object({ namespace: text(), required: { const: false }, payload: {} }, ["namespace"], true)
      : { type: "object", additionalProperties: true } } } })),
};
const page = (key: string, item: string): Schema => object({ [key]: list(ref(item), 100), nextCursor: { type: ["string", "null"], maxLength: 8192 } });
AGENT_SCHEMAS.SessionPage = page("sessions", "Session");
AGENT_SCHEMAS.ConnectionPage = page("connections", "Connection");
AGENT_SCHEMAS.ConnectionUsage = object({ observedAt: { type: "string", format: "date-time" }, available: boolean, data: { type: "object", additionalProperties: true } }, ["observedAt", "available"], true);
const parameter = (name: string): Schema => ({ name, in: "path", required: true, schema: id });
const errors: Record<string, Schema> = Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 422, 429, 503].map(status => [String(status), { description: "Structured agent error; retryable never authorizes another mutation UUID.", content: { "application/json": { schema: ref("Error") } } }]));
function operation(operationId: string, response: string, input?: string, pathParameters: string[] = [], statuses = [200]): Schema {
  return { operationId, security: [{ coreOperation: [] }], parameters: pathParameters.map(parameter), ...(input ? { requestBody: { required: true, content: { "application/json": { schema: ref(input) } } } } : {}),
    responses: { ...errors, ...Object.fromEntries(statuses.map(status => [String(status), { description: "Authorized durable result.", headers: { "Cache-Control": { schema: { const: "no-store" } } }, content: { "application/json": { schema: ref(response) } } }])) } };
}
const historySecurity = [{ installationHistory: [] }];
const historyParam = (name: string, schema: Schema, required = false) => ({ name, in: "query", schema, required });
const pageLimit = historyParam("limit", { type: "integer", minimum: 1, maximum: 100 });
export const AGENT_OPENAPI: Schema = {
  openapi: "3.1.0", info: { title: "Hosty Agent Execution API", version: "1.0.0", description: "Independent provider execution. Paths are relative to the current Core-declared interface base. Exact UTF-8 command bytes and stable mutation UUIDs are retained across retries. No Harness dependency or raw native session IDs." },
  paths: {
    "/history/live": { get: { operationId: "history.live", security: historySecurity, parameters: [historyParam("after", text(8192))],
      description: "Open a fresh live subscription. The optional previous cursor checks archive ancestry. The ready event returns the subscribed boundary. Subsequent observation events carry an SSE id and every durable record carries its session position.",
      responses: { ...errors, "200": { description: "Ready boundary followed by live observations.", content: {
        "text/event-stream": { schema: { type: "string" }, "x-event-schemas": { ready: ref("LiveHistoryReady"), observation: ref("LiveHistoryObservation") } },
      } } } } },
    "/history/states": { get: { operationId: "history.states", security: historySecurity,
      parameters: [historyParam("through", text(8192)), historyParam("afterSession", id), pageLimit],
      description: "List sessions with retained runs and their state and durable session head at the supplied or current installation boundary. Pass the returned boundary on later pages.",
      responses: { ...errors, "200": { description: "States for the calling installation.", content: { "application/json": { schema: ref("HistoryStates") } } } } } },
    "/history/range": { get: { operationId: "history.range", security: historySecurity,
      parameters: [historyParam("through", text(8192), true), historyParam("sessionId", id, true), historyParam("epoch", uuid, true),
        historyParam("from", positive, true), historyParam("to", positive, true), pageLimit],
      description: "Read an inclusive interval of durable positions for one session and history epoch. nextPosition is the first unread position in the requested interval.",
      responses: { ...errors, "200": { description: "Ordered durable session records.", content: { "application/json": { schema: ref("HistoryRange") } } } } } },
    "/history/events": { get: { operationId: "history.events", security: [{ installationHistory: [] }],
      parameters: [{ name: "after", in: "query", schema: text(8192) }, { name: "through", in: "query", schema: text(8192) }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }],
      description: "Resumable, read-only installation history. Frames use event: observation with an opaque installation feed position in id. Commit each observation before saving this position.",
      responses: { ...errors, "200": { description: "History for the authenticated consumer installation.", content: { "text/event-stream": { schema: { type: "string" }, "x-event-schema": ref("HistoryObservation") }, "application/json": { schema: ref("HistoryPage") } } } } } },
    "/capabilities": { get: operation("capabilities", "Capabilities") },
    "/connections": { get: operation("connections.list", "ConnectionPage") },
    "/connections/{connectionId}/models": { get: operation("connections.models", "ModelCatalog", undefined, ["connectionId"]) },
    "/connections/{connectionId}/usage": { get: { ...operation("connections.usage", "ConnectionUsage", undefined, ["connectionId"]), description: "Optional connections.usage capability." } },
    "/attachments/{attachmentId}/chunks/{index}": { put: { ...operation("attachments.write", "AttachmentChunkReceipt", "AttachmentChunk", ["attachmentId", "index"], [200, 201]), description: "Stable upload UUID, zero-based chunk index. At most 512 KiB decoded per chunk and 25 MiB/file; exact retries are actor scoped. Final completion publishes an immutable provider-owned attachment reference." } },
    "/sessions": { get: operation("sessions.list", "SessionPage") },
    "/sessions/{sessionId}": { get: operation("sessions.read", "Session", undefined, ["sessionId"]), put: operation("sessions.create", "Session", "SessionCreate", ["sessionId"], [200, 201]) },
    "/sessions/{sessionId}/configurations/{configurationId}": { put: operation("sessions.configure", "Session", "ConfigurationCreate", ["sessionId", "configurationId"], [200, 201]) },
    "/sessions/{sessionId}/runs/{runId}": { put: operation("runs.start", "RunSnapshot", "RunInput", ["sessionId", "runId"], [200, 202]) },
    "/runs/{runId}": { get: operation("runs.read", "RunSnapshot", undefined, ["runId"]) },
    "/runs/{runId}/events": { get: { operationId: "runs.events", security: [{ coreOperation: [] }], parameters: [parameter("runId"), { name: "after", in: "query", schema: text(8192) }, { name: "Last-Event-ID", in: "header", schema: text(8192) }],
      description: "At-least-once SSE. after and Last-Event-ID must agree. Persisted Event envelopes use event: agent and an opaque id cursor. 410 replay_expired requires installing a fresh atomic snapshot before following its cursor. Disconnect never cancels execution.",
      responses: { ...errors, "200": { description: "Persisted agent event stream.", content: { "text/event-stream": { schema: { type: "string" }, "x-event-schema": ref("Event") } } } } } },
    "/runs/{runId}/responses": { post: operation("runs.respond", "ControlReceipt", "ResponseInput", ["runId"], [200, 202]) },
    "/runs/{runId}/cancel": { post: operation("runs.cancel", "ControlReceipt", "CancelInput", ["runId"], [200, 202]) },
    "/runs/{runId}/controls": { post: { ...operation("runs.control", "ControlReceipt", "ControlInput", ["runId"], [200, 202]), description: "Optional controls require their advertised capabilities. Reconcile input is an attestation, never proof of actual native exit. Retirement requires provider-owned evidence of native process exit. Its applied receipt records retirement of the exact run and preserves unresolved tool outcomes." } },
    "/runs/{runId}/controls/{requestId}": { get: operation("runs.controls.read", "ControlReceipt", undefined, ["runId", "requestId"]) },
  }, components: { securitySchemes: { installationHistory: { type: "http", scheme: "bearer", description: "Core-issued installation history credential." }, coreOperation: { type: "http", scheme: "bearer", description: "Fresh Core exact-operation credential, never the caller's service/user token." } }, schemas: AGENT_SCHEMAS },
};
function localRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localRefs);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "$ref" && typeof item === "string" ? item.replace("#/components/schemas/", "#/$defs/") : localRefs(item)]));
  return value;
}
export const AGENT_EVENT_SCHEMA: Schema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:hosty:agent-event:1", $ref: "#/$defs/Event", $defs: localRefs(AGENT_SCHEMAS) };
