import { createHash } from "node:crypto";
import {
  AgentApiError, type AgentAttachment, type AgentAttachmentChunk, type AgentAttachmentChunkReceipt, type AgentAuthorizer, type AgentAuthorizationRequest, type AgentCancelInput, type AgentCapabilities,
  type AgentConfigurationCreate, type AgentConnectionPage, type AgentConnectionUsage, type AgentControlReceipt,
  type AgentEvent, type AgentModelCatalog, type AgentOperation, type AgentPreparedRequest, type AgentProviderRef,
  type AgentResponseInput, type AgentRunControlInput, type AgentRunInput, type AgentRunSnapshot, type AgentSession,
  type AgentSessionCreate, type AgentSessionPage, type AgentWatchItem,
} from "./agent.js";
import { validateAgentEvent, validateAgentRunSnapshot, validateAgentRequest, validateAgentSession, validateAgentCapabilities, validateAgentControlReceipt } from "./agent-server.js";

export type AgentClientOptions = { provider: AgentProviderRef; authorize: AgentAuthorizer; fetch?: typeof fetch; requestTimeoutMs?: number };
export type AgentRequestOptions = { signal?: AbortSignal };
export type AgentWatchOptions = AgentRequestOptions & { cursor?: string; maxReconnects?: number; reconnectDelayMs?: number };
const MAX_BYTES = 1024 * 1024;
const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const segment = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new AgentApiError("invalid_input", "A bounded opaque resource ID is required.", 400);
  return encodeURIComponent(id);
};
const sameProvider = (a: AgentProviderRef, b: AgentProviderRef) => a.appId === b.appId && a.installationId === b.installationId && a.key === b.key;

/** Preparing once lets an application persist exactly the bytes it must reuse after an uncertain delivery. */
export function prepareAgentRequest<T>(operation: AgentOperation, method: "PUT" | "POST", path: string, input: unknown,
  metadata: Omit<AgentAuthorizationRequest, "operation" | "method" | "path" | "bodyHash"> = {}): AgentPreparedRequest<T> {
  const body = JSON.stringify(input);
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES) throw new AgentApiError("payload_budget", "The agent command exceeds its byte allowance.", 413);
  validateAgentRequest(method, path, body, operation);
  return { ...JSON.parse(JSON.stringify(metadata)), operation, method, path, body, bodyHash: sha(body) };
}
export const prepareAgentSessionCreate = (sessionId: string, input: AgentSessionCreate) => prepareAgentRequest<AgentSession>("sessions.create", "PUT", `/sessions/${segment(sessionId)}`, input, { sessionId });
export const prepareAgentConfiguration = (sessionId: string, configurationId: string, input: AgentConfigurationCreate) => prepareAgentRequest<AgentSession>("sessions.configure", "PUT", `/sessions/${segment(sessionId)}/configurations/${segment(configurationId)}`, input, { sessionId });
export const prepareAgentRun = (sessionId: string, runId: string, input: AgentRunInput) => prepareAgentRequest<AgentRunSnapshot>("runs.start", "PUT", `/sessions/${segment(sessionId)}/runs/${segment(runId)}`, input,
  { sessionId, runId, resources: input.resources, ceiling: { mcp: input.mcp, resources: input.resources, configurationRevision: input.configurationRevision } });
export const prepareAgentResponse = (runId: string, input: AgentResponseInput) => prepareAgentRequest<AgentControlReceipt>("runs.respond", "POST", `/runs/${segment(runId)}/responses`, input, { runId });
export const prepareAgentCancel = (runId: string, input: AgentCancelInput) => prepareAgentRequest<AgentControlReceipt>("runs.cancel", "POST", `/runs/${segment(runId)}/cancel`, input, { runId, ...(input.fenceIfNotAdmitted ? { sessionId: input.fenceIfNotAdmitted.sessionId } : {}) });
export const prepareAgentControl = (runId: string, input: AgentRunControlInput) => prepareAgentRequest<AgentControlReceipt>("runs.control", "POST", `/runs/${segment(runId)}/controls`, input, { runId });
export const prepareAgentAttachmentChunk = (attachmentId: string, index: number, input: AgentAttachmentChunk) => prepareAgentRequest<AgentAttachmentChunkReceipt>("attachments.write", "PUT", `/attachments/${segment(attachmentId)}/chunks/${index}`, input);

/** Backend-to-backend transport. The authorizer talks to Core; only its scoped token reaches the provider. */
export class AgentClient {
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  constructor(private readonly options: AgentClientOptions) {
    if (!options.provider?.appId || !options.provider.installationId || !options.provider.key)
      throw new AgentApiError("provider_selection_required", "Select an installation-qualified agent provider.", 400);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeout = options.requestTimeoutMs ?? 15000;
  }
  private async response(request: AgentAuthorizationRequest, body: string | undefined, options: AgentRequestOptions, stream = false): Promise<Response> {
    options.signal?.throwIfAborted();
    const signal = stream ? options.signal : options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout);
    for (let attempt = 0; attempt < 2; attempt++) {
      const binding = await this.options.authorize(request, signal);
      if (!sameProvider(this.options.provider, binding.provider)) throw new AgentApiError("provider_changed", "The selected provider installation changed.", 409);
      const base = new URL(binding.baseUrl);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || !binding.token
        || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= Date.now())
        throw new AgentApiError("authorization_invalid", "Core returned an invalid current provider binding.", 401);
      const headers: Record<string, string> = { authorization: `Bearer ${binding.token}`, accept: stream ? "text/event-stream" : "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (binding.admissionRef) headers["X-Hosty-Agent-Admission"] = binding.admissionRef;
      const response = await this.fetcher(base.href.replace(/\/$/, "") + request.path,
        { method: request.method, headers, body, signal, redirect: "error", cache: "no-store" });
      if (response.status === 401 && attempt === 0) { await response.body?.cancel(); continue; }
      return response;
    }
    throw new AgentApiError("token_invalid", "Agent authorization expired.", 401);
  }
  private async json<T>(response: Response): Promise<T> {
    const raw = await boundedText(response, MAX_BYTES);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new AgentApiError("response_invalid", "The provider returned invalid JSON.", 502); }
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown>; requestId?: string } })?.error;
      throw new AgentApiError(error?.code ?? "provider_failed", error?.message ?? `Agent request failed (${response.status}).`, response.status, error?.retryable === true, error?.details, error?.requestId);
    }
    return value as T;
  }
  private async get<T>(operation: AgentOperation, path: string, options: AgentRequestOptions = {}, metadata: Partial<AgentAuthorizationRequest> = {}): Promise<T> {
    const request = { ...metadata, operation, method: "GET" as const, path, bodyHash: sha("") };
    validateAgentRequest("GET", path, "", operation);
    const value = await this.json<T>(await this.response(request, undefined, options));
    this.validateResponse(request, value); return value;
  }
  /** No transport retry can change a prepared body's identity or begin a second run. */
  async execute<T>(request: AgentPreparedRequest<T>, options: AgentRequestOptions = {}): Promise<T> {
    if (request.bodyHash !== sha(request.body)) throw new AgentApiError("request_digest_mismatch", "The prepared command bytes changed.", 409);
    validateAgentRequest(request.method, request.path, request.body, request.operation);
    const { body, __result: _result, ...metadata } = request;
    const value = await this.json<T>(await this.response(metadata, body, options));
    this.validateResponse(metadata, value); return value;
  }
  capabilities(options?: AgentRequestOptions): Promise<AgentCapabilities> { return this.get("capabilities", "/capabilities", options); }
  connections(query: { cursor?: string; limit?: number } = {}, options?: AgentRequestOptions): Promise<AgentConnectionPage> { return this.get("connections.list", "/connections" + queryString(query), options); }
  models(connectionId: string, options?: AgentRequestOptions): Promise<AgentModelCatalog> { return this.get("connections.models", `/connections/${segment(connectionId)}/models`, options); }
  connectionUsage(connectionId: string, options?: AgentRequestOptions): Promise<AgentConnectionUsage> { return this.get("connections.usage", `/connections/${segment(connectionId)}/usage`, options); }
  createSession(sessionId: string, input: AgentSessionCreate, options?: AgentRequestOptions): Promise<AgentSession> { return this.execute(prepareAgentSessionCreate(sessionId, input), options); }
  session(sessionId: string, options?: AgentRequestOptions): Promise<AgentSession> { return this.get("sessions.read", `/sessions/${segment(sessionId)}`, options, { sessionId }); }
  sessions(query: { cursor?: string; limit?: number } = {}, options?: AgentRequestOptions): Promise<AgentSessionPage> { return this.get("sessions.list", "/sessions" + queryString(query), options); }
  configureSession(sessionId: string, configurationId: string, input: AgentConfigurationCreate, options?: AgentRequestOptions): Promise<AgentSession> { return this.execute(prepareAgentConfiguration(sessionId, configurationId, input), options); }
  startRun(sessionId: string, runId: string, input: AgentRunInput, options?: AgentRequestOptions): Promise<AgentRunSnapshot> { return this.execute(prepareAgentRun(sessionId, runId, input), options); }
  async run(runId: string, options?: AgentRequestOptions): Promise<AgentRunSnapshot> {
    const value = await this.get<AgentRunSnapshot>("runs.read", `/runs/${segment(runId)}`, options, { runId });
    this.checkSnapshot(value, runId); return value;
  }
  respond(runId: string, input: AgentResponseInput, options?: AgentRequestOptions): Promise<AgentControlReceipt> { return this.execute(prepareAgentResponse(runId, input), options); }
  cancel(runId: string, input: AgentCancelInput, options?: AgentRequestOptions): Promise<AgentControlReceipt> { return this.execute(prepareAgentCancel(runId, input), options); }
  control(runId: string, requestId: string, options?: AgentRequestOptions): Promise<AgentControlReceipt> { return this.get("runs.controls.read", `/runs/${segment(runId)}/controls/${segment(requestId)}`, options, { runId }); }
  runControl(runId: string, input: AgentRunControlInput, options?: AgentRequestOptions): Promise<AgentControlReceipt> { return this.execute(prepareAgentControl(runId, input), options); }
  prepareAttachmentChunk(attachmentId: string, index: number, input: AgentAttachmentChunk): AgentPreparedRequest<AgentAttachmentChunkReceipt> { return prepareAgentAttachmentChunk(attachmentId, index, input); }
  async uploadAttachment(attachmentId: string, input: Uint8Array, metadata: { mediaType: string; name?: string }, options?: AgentRequestOptions): Promise<AgentAttachment> {
    const bytes = Buffer.from(input), digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength > 25 * 1024 * 1024) throw new AgentApiError("payload_budget", "An attachment exceeds 25 MiB.", 413);
    const count = Math.max(1, Math.ceil(bytes.byteLength / (512 * 1024))); let completed: AgentAttachment | null = null;
    for (let index = 0; index < count; index++) {
      const receipt = await this.execute(prepareAgentAttachmentChunk(attachmentId, index, { digest, sizeBytes: bytes.byteLength, mediaType: metadata.mediaType, ...(metadata.name !== undefined ? { name: metadata.name } : {}), count, data: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString("base64") }), options);
      if (receipt.attachment) completed = receipt.attachment;
    }
    if (!completed || completed.digest !== digest || completed.sizeBytes !== bytes.byteLength || completed.mediaType !== metadata.mediaType) throw new AgentApiError("response_invalid", "The provider did not publish the intended immutable attachment.", 502);
    return completed;
  }
  private checkSnapshot(value: unknown, runId: string): asserts value is AgentRunSnapshot {
    validateAgentRunSnapshot(value);
    if (value.ref.id !== runId || !sameProvider(this.options.provider, value.ref.provider)) throw new AgentApiError("response_invalid", "The snapshot belongs to another run or provider.", 502);
  }
  private validateResponse(request: AgentAuthorizationRequest, value: unknown): void {
    const invalid = () => { throw new AgentApiError("response_invalid", "The provider returned an invalid operation result.", 502); };
    const record = value as Record<string, unknown> | null;
    if (request.operation === "capabilities") validateAgentCapabilities(value);
    else if (["sessions.create", "sessions.configure", "sessions.read"].includes(request.operation)) {
      validateAgentSession(value);
      if (!sameProvider(this.options.provider, value.ref.provider) || value.ref.id !== request.sessionId) invalid();
    } else if (request.operation === "sessions.list") {
      const items = record?.sessions; if (!Array.isArray(items) || items.length > 100 || !(record?.nextCursor === null || typeof record?.nextCursor === "string")) invalid();
      for (const session of items as unknown[]) { validateAgentSession(session); if (!sameProvider(this.options.provider, session.ref.provider)) invalid(); }
    } else if (request.operation === "runs.start" || request.operation === "runs.read") {
      this.checkSnapshot(value, request.runId!); if (request.sessionId && value.sessionId !== request.sessionId) invalid();
    } else if (["runs.respond", "runs.cancel", "runs.control", "runs.controls.read"].includes(request.operation)) {
      validateAgentControlReceipt(value); if (value.run.id !== request.runId || !sameProvider(this.options.provider, value.run.provider)) invalid();
      if (request.operation === "runs.controls.read" && value.requestId !== request.path.split("/").at(-1)) invalid();
    } else if (request.operation === "connections.list") {
      const items = record?.connections; if (!Array.isArray(items) || items.length > 100 || !(record?.nextCursor === null || typeof record?.nextCursor === "string")) invalid();
      for (const connection of items as Array<Record<string, unknown>>) if (!connection || typeof connection.id !== "string" || typeof connection.name !== "string" || typeof connection.ready !== "boolean" || typeof connection.revision !== "string" || !/^[1-9][0-9]*$/.test(connection.revision)) invalid();
    } else if (request.operation === "connections.models") {
      if (!record || typeof record.revision !== "string" || !record.revision.length || record.revision.length > 256 || !Array.isArray(record.models) || record.models.length > 1000 || !(record.defaultModel === null || typeof record.defaultModel === "string")) invalid();
      for (const model of record!.models as Array<Record<string, unknown>>) if (!model || typeof model.id !== "string" || !Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some(v => v !== null && typeof v !== "string")) invalid();
    } else if (request.operation === "attachments.write") {
      if (!record || !Array.isArray(record.received) || record.received.length > 50 || record.received.some(i => !Number.isSafeInteger(i) || i < 0 || i >= 50) || new Set(record.received).size !== record.received.length) invalid();
      const attachment = record!.attachment as AgentAttachment | null;
      if (attachment !== null && (!attachment || !sameProvider(this.options.provider, attachment.owner) || typeof attachment.id !== "string" || !/^[a-f0-9]{64}$/.test(attachment.digest) || !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || typeof attachment.mediaType !== "string")) invalid();
    } else if (request.operation === "connections.usage" && (!record || typeof record.available !== "boolean" || typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt)))) invalid();
  }
  /** One authenticated stream; watchRun adds reconnect and atomic snapshot recovery. */
  async *events(runId: string, options: AgentRequestOptions & { cursor?: string } = {}): AsyncGenerator<{ event: AgentEvent; cursor: string }> {
    const path = `/runs/${segment(runId)}/events` + queryString({ after: options.cursor });
    const response = await this.response({ operation: "runs.events", method: "GET", path, bodyHash: sha(""), runId }, undefined, options, true);
    if (!response.ok) { await this.json(response); return; }
    if (!response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase().includes("text/event-stream"))
      throw new AgentApiError("response_invalid", "The provider did not return an event stream.", 502);
    for await (const frame of parseAgentSse(response, MAX_BYTES)) {
      if (frame.event !== "agent") continue;
      let event: unknown;
      try { event = JSON.parse(frame.data); } catch { throw new AgentApiError("event_invalid", "The provider returned an invalid event.", 502); }
      validateAgentEvent(event);
      if (event.runId !== runId || !frame.id) throw new AgentApiError("event_invalid", "The event does not identify this run and replay cursor.", 502);
      if (event.type === "run.updated") this.checkSnapshot(event.data.snapshot, runId);
      yield { event, cursor: frame.id };
    }
  }
  /** Snapshot items replace consumer state; event items are new, deduplicated persisted events. */
  async *watchRun(runId: string, options: AgentWatchOptions = {}): AsyncGenerator<AgentWatchItem> {
    let snapshot = await this.run(runId, options);
    yield { kind: "snapshot", snapshot };
    let cursor = snapshot.cursor, sequence = BigInt(snapshot.lastSequence), generation = snapshot.generation;
    let retries = 0;
    const max = options.maxReconnects ?? 5;
    if (!Number.isSafeInteger(max) || max < 0 || max > 100 || options.reconnectDelayMs !== undefined && (!Number.isSafeInteger(options.reconnectDelayMs) || options.reconnectDelayMs < 0 || options.reconnectDelayMs > 60000)) throw new AgentApiError("invalid_input", "Invalid bounded reconnect policy.", 400);
    while (!options.signal?.aborted) {
      if (snapshot.stopConfirmed && ["succeeded", "failed", "cancelled"].includes(snapshot.state)) return;
      try {
        for await (const item of this.events(runId, { signal: options.signal, cursor })) {
          if (item.event.generation !== generation) throw new AgentApiError("event_generation_changed", "A run's durable generation changed.", 409);
          const next = BigInt(item.event.sequence);
          if (next <= sequence) continue;
          if (next !== sequence + 1n) throw new AgentApiError("event_gap", "Resynchronize the run after a missing event.", 409, true);
          sequence = next; cursor = item.cursor; retries = 0;
          if (item.event.type === "run.updated") snapshot = item.event.data.snapshot as AgentRunSnapshot;
          yield { kind: "event", ...item };
          if (snapshot.stopConfirmed && ["succeeded", "failed", "cancelled"].includes(snapshot.state)) return;
        }
        if (++retries > max) throw new AgentApiError("stream_closed", "The provider repeatedly closed its active stream.", 503, true);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (error instanceof AgentApiError && error.status !== 410 && error.code !== "event_gap" && !error.retryable && ![429, 503, 504].includes(error.status)) throw error;
        if (error instanceof AgentApiError && error.code === "stream_closed" || ++retries > max) throw error;
      }
      options.signal?.throwIfAborted();
      snapshot = await this.run(runId, options);
      if (snapshot.generation !== generation) throw new AgentApiError("event_generation_changed", "A run's durable generation changed.", 409);
      cursor = snapshot.cursor; sequence = BigInt(snapshot.lastSequence); generation = snapshot.generation;
      yield { kind: "snapshot", snapshot };
      if (!snapshot.stopConfirmed) await pause(options.reconnectDelayMs ?? 250, options.signal);
    }
    options.signal?.throwIfAborted();
  }
}

function queryString(value: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams(); for (const [key, item] of Object.entries(value)) if (item !== undefined) query.set(key, String(item));
  return query.size ? "?" + query.toString() : "";
}
async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > max) throw new AgentApiError("response_budget", "The provider response exceeds its byte allowance.", 502);
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Streaming decoder handles split UTF-8, CR/LF framing, multi-line data and comment heartbeats. */
export async function* parseAgentSse(response: Pick<Response, "body">, maxBytes = MAX_BYTES): AsyncGenerator<{ id: string; event: string; data: string }> {
  const reader = response.body?.getReader(); if (!reader) throw new AgentApiError("event_invalid", "The event stream is empty.", 502);
  const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", id = "", event = "message", data: string[] = [], bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at a chunk boundary may be the first half of CRLF.
        if (!chunk.done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        bytes += Buffer.byteLength(line) + 1; if (bytes > maxBytes + 8192) throw new AgentApiError("event_budget", "An event exceeds its byte allowance.", 502);
        if (!line) { if (data.length) yield { id, event, data: data.join("\n") }; id = ""; event = "message"; data = []; bytes = 0; continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon); let value = colon < 0 ? "" : line.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
        if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (Buffer.byteLength(buffer) + bytes > maxBytes + 8192) throw new AgentApiError("event_budget", "An event exceeds its byte allowance.", 502);
      if (chunk.done) break; // An incomplete final frame is never acknowledged as a persisted event.
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
