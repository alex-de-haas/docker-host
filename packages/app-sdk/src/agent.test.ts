import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AgentClient, readAgentHistoryPage, readAgentHistoryRange, readAgentHistoryStates, watchAgentHistory, watchLiveAgentHistory, parseAgentSse, prepareAgentCancel, prepareAgentControl, prepareAgentRun, prepareAgentSessionCreate } from "./agent-client.js";
import { AGENT_CAPABILITIES, AgentApiError, type AgentAttachmentChunk, type AgentEvent, type AgentRunInput, type AgentRunSnapshot, type AgentSession } from "./agent.js";
import { agentReplayCursor, encodeAgentSseEvent, validateAgentAttachmentChunk, validateAgentConfiguration, validateAgentEvent, validateAgentRequest, validateAgentResponseInput, validateAgentRunSnapshot } from "./agent-server.js";
import { AGENT_EVENT_SCHEMA, AGENT_OPENAPI } from "./agent-schemas.js";

const provider = { appId: "org.example.unrelated-provider", installationId: "installation-1", key: "execution" };
const sessionId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const generation = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const configuration = { connection: { id: "account-1", revision: "1" } };
const session = (): AgentSession => ({ ref: { provider, id: sessionId }, revision: "1", configurationRevision: "1", configurationDigest: "a".repeat(64), nativeState: "not_created", activeRun: null, resolvedSkills: [] });
const runInput = (): AgentRunInput => ({ expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Explain the failing build — Привет" } });
const snapshot = (sequence = "1", done = false): AgentRunSnapshot => ({ ref: { provider, id: runId }, sessionId, generation, revision: "1", state: done ? "succeeded" : "running", phase: done ? "terminal" : "executing", stopConfirmed: done,
  freshness: "current", observedAt: new Date().toISOString(), configurationRevision: "1", lastSequence: sequence, cursor: `cursor-${sequence}`, pending: [], effects: { certainty: "known", unresolvedCallIds: [] }, messages: [] });
const event = (sequence: string, type: AgentEvent["type"] = "message.delta", data: Record<string, unknown> = { messageId: "message-1", text: "Привет" }): AgentEvent => ({ schemaVersion: "agent-event.1", runId, generation, sequence, revision: "1", occurredAt: new Date().toISOString(), type, source: { agentId: "root" }, data });
const authorization = () => ({ provider, baseUrl: "http://provider.test/declared/agent/v1", token: "scoped-operation", expiresAt: new Date(Date.now() + 60000).toISOString() });
const stream = (value: string, split = 19): Response => {
  const bytes = new TextEncoder().encode(value);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split)); controller.close(); } }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
};
const collect = async <T>(items: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const item of items) result.push(item); return result; };

describe("independent agent request boundary", () => {
  it("accepts a minimal session without conversation, Harness defaults, skills or MCP", () => {
    const parsed = validateAgentRequest("PUT", `/sessions/${sessionId}`, JSON.stringify({ configuration }));
    expect(parsed).toMatchObject({ operation: "sessions.create", sessionId, input: { configuration } });
    expect(parsed.input).not.toHaveProperty("conversationId");
  });
  it.each([
    { configuration, userId: "administrator" },
    { configuration: { ...configuration, instructions: [{ id: "trusted", text: "x", source: "platform" }] } },
    { configuration: { ...configuration, skills: [{ path: "/private/skills" }] } },
    { configuration: { ...configuration, secret: "another-app-service-token" } },
  ])("rejects caller-supplied identity, authority labels, paths and secrets %#", body => {
    expect(() => validateAgentRequest("PUT", `/sessions/${sessionId}`, JSON.stringify(body))).toThrow(AgentApiError);
  });
  it("accepts explicit skill/MCP references and rejects raw server authority", () => {
    const input: AgentRunInput = { ...runInput(), mcp: { targets: [{ target: { kind: "core" }, tools: ["workspace_list"], policy: { default: "ask", autoAllowReadOnly: true, tools: { workspace_list: { mode: "run", definition: "a".repeat(64) } } } }, { target: { kind: "app", ...provider }, tools: [] }], connections: [{ id: "external-1", revision: "2" }] } };
    expect(() => prepareAgentRun(sessionId, runId, input)).not.toThrow();
    expect(() => prepareAgentRun(sessionId, runId, { ...input, mcp: { targets: [{ target: { kind: "core" }, url: "http://secret.test", headers: { authorization: "secret" } }] } } as unknown as AgentRunInput)).toThrow();
    validateAgentConfiguration({ ...configuration, approvalMode: "autonomous", skills: [{ skillId: "b".repeat(64), expectedDigest: "c".repeat(64) }] });
    expect(() => prepareAgentRun(sessionId, runId, { ...runInput(), mcp: { targets: [{ target: { kind: "core" }, policy: { default: "ask", tools: { danger: { mode: "run" } } } }] } })).toThrow();
    const policy = { requestId, expectedGeneration: generation, expectedRevision: "4", command: "mcpPolicy", mcp: input.mcp };
    expect(validateAgentRequest("POST", `/runs/${runId}/controls`, JSON.stringify(policy)).operation).toBe("runs.control");
    expect(() => validateAgentRequest("POST", `/runs/${runId}/controls`, JSON.stringify({ ...policy, mcp: { targets: [{ target: { kind: "core" }, headers: { authorization: "secret" } }] } }))).toThrow();
  });
  it("retains exact question IDs and interactive metadata", () => {
    const response = { requestId, expectedGeneration: generation, expectedRevision: "4", decisionId: "question-1", decisionRevision: "2", response: { kind: "question", answers: { color: ["red", "blue"], detail: "custom" } } };
    validateAgentResponseInput(response);
    const state = snapshot(); state.pending = [{ id: "question-1", revision: "2", kind: "question", delivery: "next_turn", questions: [{ id: "color", header: "Choice", text: "Pick", allowText: true, multiple: true, options: [{ id: "red", label: "Red", description: "Warm", preview: "preview" }] }] }];
    validateAgentRunSnapshot(state);
  });
  it("binds exact barriers and reserves cancellation independently of a run revision", () => {
    const barrier = { requestId, expectedGeneration: generation, expectedRevision: "3", command: "barrier", barrierId: "barrier-1", kind: "source_rebind", generation: "2", acknowledgedSequence: "17" };
    expect(validateAgentRequest("POST", `/runs/${runId}/controls`, JSON.stringify(barrier)).operation).toBe("runs.control");
    expect(() => validateAgentRequest("POST", `/runs/${runId}/controls`, JSON.stringify({ ...barrier, acknowledgedSequence: undefined }))).toThrow();
    const fence = prepareAgentCancel(runId, { requestId, fenceIfNotAdmitted: { sessionId, startDigest: hash("original input") } });
    expect(JSON.parse(fence.body)).not.toHaveProperty("expectedGeneration");
    expect(() => validateAgentRequest("POST", `/runs/${runId}/cancel`, JSON.stringify({ ...JSON.parse(fence.body), expectedRevision: "1" }))).toThrow();
  });
  it("prepares retirement for the exact run without accepting caller-supplied exit proof", () => {
    expect(AGENT_CAPABILITIES.retire).toBe("runs.retire");
    const input = { requestId, expectedGeneration: generation, expectedRevision: "4", command: "retire" } as const;
    const request = prepareAgentControl(runId, input);
    expect(request).toMatchObject({ operation: "runs.control", method: "POST", path: `/runs/${runId}/controls`, runId,
      body: JSON.stringify(input), bodyHash: hash(JSON.stringify(input)) });
    expect(validateAgentRequest(request.method, request.path, request.body)).toMatchObject({ runId, input });
    expect(() => validateAgentRequest(request.method, request.path, JSON.stringify({ ...input, stopped: true }))).toThrow();
    expect(() => validateAgentRequest(request.method, request.path, JSON.stringify({ ...input, expectedGeneration: undefined }))).toThrow();
  });
  it("bounds UTF-8 bytes and rejects ambiguous routes/query/cursors before authorization", () => {
    expect(() => prepareAgentRun(sessionId, runId, { ...runInput(), input: { text: "界".repeat(400000) } })).toThrowError(expect.objectContaining({ status: 413 }));
    for (const path of ["//other.test/sessions", "/sessions?limit=0", "/sessions?limit=101", "/sessions?cursor=x&cursor=y", "/runs/foo%2fbar", "/sessions#hidden"]) expect(() => validateAgentRequest("GET", path, "")).toThrow();
    expect(() => agentReplayCursor("one", "two")).toThrow(); expect(agentReplayCursor("same", "same")).toBe("same");
  });
});

describe("agent operation transport", () => {
  it("renews a 401 with identical UTF-8 bytes and sends only exact-operation authority", async () => {
    const authorize = vi.fn(async () => authorization());
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "expired", message: "Expired", retryable: false } }, { status: 401 })).mockResolvedValueOnce(Response.json(session()));
    const client = new AgentClient({ provider, authorize, fetch: fetcher });
    const prepared = prepareAgentSessionCreate(sessionId, { configuration: { ...configuration, instructions: [{ id: "workflow", text: "Русский текст" }] } });
    await client.execute(JSON.parse(JSON.stringify(prepared)));
    expect(authorize).toHaveBeenCalledTimes(2); expect(authorize.mock.calls[0]![0]).toMatchObject({ operation: "sessions.create", bodyHash: hash(prepared.body) });
    for (const call of fetcher.mock.calls) expect(call).toEqual([authorization().baseUrl + `/sessions/${sessionId}`, expect.objectContaining({ body: prepared.body, redirect: "error", headers: expect.objectContaining({ authorization: "Bearer scoped-operation" }) })]);
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  });
  it("rejects changed bytes, changed installation and current authority denial before transfer", async () => {
    const fetcher = vi.fn(); const authorize = vi.fn(async () => authorization()); const client = new AgentClient({ provider, authorize, fetch: fetcher });
    const command = prepareAgentRun(sessionId, runId, runInput());
    await expect(client.execute({ ...command, body: command.body + " " })).rejects.toMatchObject({ code: "request_digest_mismatch" });
    expect(authorize).not.toHaveBeenCalled();
    const changed = new AgentClient({ provider, authorize: async () => ({ ...authorization(), provider: { ...provider, installationId: "reinstalled" } }), fetch: fetcher });
    await expect(changed.execute(command)).rejects.toMatchObject({ code: "provider_changed" });
    const denied = new AgentClient({ provider, authorize: async () => { throw new AgentApiError("permission_denied", "Revoked", 403); }, fetch: fetcher });
    await expect(denied.execute(command)).rejects.toMatchObject({ code: "permission_denied" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves a conflict/uncertain control outcome without repeating a mutation", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "control_unknown", message: "Inspect the original receipt", retryable: true, requestId } }, { status: 409 }));
    const client = new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher });
    await expect(client.cancel(runId, { requestId, expectedGeneration: generation, expectedRevision: "3" })).rejects.toMatchObject({ code: "control_unknown", requestId, retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates accepted session/run/control responses before callers persist them", async () => {
    const client = new AgentClient({ provider, authorize: async () => authorization(), fetch: vi.fn().mockResolvedValue(Response.json({ ...snapshot(), sessionId: "somebody-else" })) });
    await expect(client.startRun(sessionId, runId, runInput())).rejects.toMatchObject({ code: "response_invalid" });
    const another = new AgentClient({ provider, authorize: async () => authorization(), fetch: vi.fn().mockResolvedValue(Response.json({ ...session(), ref: { provider, id: "another-session" } })) });
    await expect(another.createSession(sessionId, { configuration })).rejects.toMatchObject({ code: "response_invalid" });
    expect(() => validateAgentRunSnapshot({ ...snapshot(), state: "succeeded", stopConfirmed: false })).toThrow();
  });
  it("accepts opaque model catalog content revisions while bounding malformed revisions", async () => {
    const catalog = { revision: hash("native catalog"), models: [{ id: "local:model", reasoningEfforts: [], defaultReasoningEffort: null }], defaultModel: "local:model", nextCursor: null };
    const fetcher = vi.fn().mockImplementation(async () => Response.json(catalog));
    const client = new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher });
    expect(await client.models("account-1")).toEqual(catalog);
    for (const revision of ["", "x".repeat(257), 1, null]) {
      fetcher.mockImplementationOnce(async () => Response.json({ ...catalog, revision }));
      await expect(client.models("account-1")).rejects.toMatchObject({ code: "response_invalid" });
    }
  });
});

describe("SSE replay and recovery", () => {
  it("decodes split UTF-8/CRLF/multiline data and ignores comment heartbeats and torn tails", async () => {
    const frames = await collect(parseAgentSse(stream(": beat\r\n\r\nid: cursor\r\nevent: agent\r\ndata: {\r\ndata: \"text\":\"Привет\"}\r\n\r\ndata: incomplete", 1)));
    expect(frames).toEqual([{ id: "cursor", event: "agent", data: "{\n\"text\":\"Привет\"}" }]);
  });
  it("deduplicates replay by durable sequence and preserves child source correlation", async () => {
    const child = event("2"); child.source = { agentId: "child", parentAgentId: "root", parentToolCallId: "delegation-1" };
    const end = snapshot("3", true); const last = event("3", "run.updated", { snapshot: end });
    const authorize = vi.fn(async () => authorization()); const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(stream(encodeAgentSseEvent(child, "cursor-2") + encodeAgentSseEvent(child, "cursor-2") + encodeAgentSseEvent(last, "cursor-3")));
    const items = await collect(new AgentClient({ provider, authorize, fetch: fetcher }).watchRun(runId));
    expect(items.map(i => i.kind)).toEqual(["snapshot", "event", "event"]);
    expect(items[1]).toMatchObject({ event: { source: child.source, sequence: "2" } });
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("reopens quiet subscriptions from their committed cursor without rereading the snapshot or exhausting the retry limit", async () => {
    const done = snapshot("2", true);
    const renewal = "event: renew\ndata: {}\n\n";
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot()))
      .mockResolvedValueOnce(stream(renewal)).mockResolvedValueOnce(stream(renewal))
      .mockResolvedValueOnce(stream(encodeAgentSseEvent(event("2", "run.updated", { snapshot: done }), "cursor-2")));
    const items = await collect(new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher })
      .watchRun(runId, { maxReconnects: 0, reconnectDelayMs: 0 }));
    expect(items.map(item => item.kind)).toEqual(["snapshot", "event"]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.slice(1).every(call => String(call[0]).endsWith("events?after=cursor-1"))).toBe(true);
  });
  it("replaces state after expired replay, then follows the replacement watermark with fresh authority", async () => {
    const fresh = { ...snapshot("8"), latestContext: { sequence: "7", usage: { usedTokens: 108, maxTokens: 32768, estimated: false } } };
    const end = { ...snapshot("9", true), latestContext: { sequence: "8", usage: null } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(Response.json({ error: { code: "replay_expired", message: "Resync", retryable: false } }, { status: 410 }))
      .mockResolvedValueOnce(Response.json(fresh)).mockResolvedValueOnce(stream(encodeAgentSseEvent(event("9", "run.updated", { snapshot: end }), "cursor-9")));
    const authorize = vi.fn(async () => authorization()); const items = await collect(new AgentClient({ provider, authorize, fetch: fetcher }).watchRun(runId, { reconnectDelayMs: 0 }));
    expect(items.map(i => i.kind)).toEqual(["snapshot", "snapshot", "event"]); expect(items[1]).toMatchObject({ snapshot: { lastSequence: "8" } });
    expect(items[1]).toMatchObject({ snapshot: { latestContext: fresh.latestContext } });
    expect(items[2]).toMatchObject({ event: { data: { snapshot: { latestContext: end.latestContext } } } });
    expect(String(fetcher.mock.calls[3]![0])).toContain("?after=cursor-8"); expect(authorize).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
  it("resynchronizes a missing event without fabricating the skipped tool output", async () => {
    const end = snapshot("5", true);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(stream(encodeAgentSseEvent(event("4"), "cursor-4"))).mockResolvedValueOnce(Response.json(end));
    const items = await collect(new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher }).watchRun(runId, { reconnectDelayMs: 0 }));
    expect(items.map(i => i.kind)).toEqual(["snapshot", "snapshot"]); expect(items.at(-1)).toMatchObject({ snapshot: { lastSequence: "5", stopConfirmed: true } });
  });
  it("fails closed on event version, generation, run identity and snapshot-watermark mismatch", () => {
    for (const item of [{ ...event("2"), schemaVersion: "agent-event.2" }, { ...event("2"), generation: "native-pid" }, event("2", "run.updated", { snapshot: snapshot("3") })]) expect(() => validateAgentEvent(item)).toThrow();
  });
  it("observer cancellation closes the stream without sending an execution cancellation", async () => {
    const controller = new AbortController(); let cancelled = false;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(encodeAgentSseEvent(event("2"), "cursor-2"))); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
    const watch = new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher }).watchRun(runId, { signal: controller.signal });
    await watch.next(); await watch.next(); await watch.return(); expect(cancelled).toBe(true); expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
});

describe("provider-owned immutable attachments", () => {
  it("uploads bounded chunks with stable bytes and returns a verified provider reference", async () => {
    const bytes = new Uint8Array(512 * 1024 + 3).fill(7), received = new Map<number, Buffer>(); const bodies: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsed = validateAgentRequest("PUT", new URL(String(url)).pathname.replace("/declared/agent/v1", ""), String(options?.body));
      if (parsed.operation !== "attachments.write") throw new Error("Wrong route");
      bodies.push(String(options?.body)); received.set(parsed.chunkIndex!, Buffer.from(parsed.input.data, "base64"));
      const all = received.size === parsed.input.count ? Buffer.concat([...received].sort(([a], [b]) => a - b).map(([, value]) => value)) : null;
      return Response.json({ received: [...received.keys()], attachment: all ? { owner: provider, id: requestId, digest: hash(all), sizeBytes: all.byteLength, mediaType: parsed.input.mediaType, name: parsed.input.name } : null });
    });
    const client = new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher as typeof fetch });
    const result = await client.uploadAttachment(requestId, bytes, { mediaType: "application/octet-stream", name: "evidence.bin" });
    expect(result).toMatchObject({ owner: provider, digest: hash(bytes), sizeBytes: bytes.length });
    await client.uploadAttachment(requestId, bytes, { mediaType: "application/octet-stream", name: "evidence.bin" });
    expect(bodies[0]).toBe(bodies[2]); expect(bodies[1]).toBe(bodies[3]); expect(bodies.every(b => Buffer.byteLength(b) <= 1024 * 1024)).toBe(true);
  });
  it("rejects oversized, noncanonical, misindexed or incomplete chunks", () => {
    const chunk: AgentAttachmentChunk = { digest: "a".repeat(64), sizeBytes: 1, mediaType: "text/plain", count: 1, data: "YQ==" };
    validateAgentAttachmentChunk(chunk, 0);
    for (const [value, index] of [[{ ...chunk, data: "YR==" }, 0], [{ ...chunk, count: 2 }, 0], [{ ...chunk, sizeBytes: 26 * 1024 * 1024 }, 0], [chunk, 1], [{ ...chunk, data: "" }, 0]] as const) expect(() => validateAgentAttachmentChunk(value, index)).toThrow();
  });
});

describe("recoverable public snapshot details", () => {
  it("retains nullable root context with its original sequence, including values beyond Number precision", () => {
    for (const usage of [{ usedTokens: 0, maxTokens: 32768, estimated: false, detail: { supported: true } }, null]) {
      const value = { ...snapshot("9007199254740993"), latestContext: { sequence: "9007199254740992", usage } };
      expect(() => validateAgentRunSnapshot(value)).not.toThrow();
    }
    expect(() => validateAgentRunSnapshot(snapshot())).not.toThrow();
    expect(snapshot()).not.toHaveProperty("latestContext");
  });
  it.each(["0", "01", "-1", "1.0", " 1", "9007199254740993", 1])("rejects noncanonical or future latest context sequence %s", sequence => {
    expect(() => validateAgentRunSnapshot({ ...snapshot("9007199254740992"), latestContext: { sequence, usage: null } }))
      .toThrowError(AgentApiError);
  });
  it("requires finite object-or-null context data and a complete observation wrapper", () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const latestContext of [null, { sequence: "1" }, { sequence: "1", usage: undefined },
      { sequence: "1", usage: {}, foreign: true }, ...[[], 1, "text", { count: NaN }, { count: Infinity }, { count: 1n }, circular].map(usage => ({ sequence: "1", usage }))])
      expect(() => validateAgentRunSnapshot({ ...snapshot(), latestContext })).toThrowError(AgentApiError);
    for (const usage of [{ usedTokens: 0 }, null]) expect(() => validateAgentEvent(event("1", "context.updated", { usage }))).not.toThrow();
    for (const data of [{}, { usage: undefined }, { usage: [] }, { usage: { count: NaN } }])
      expect(() => validateAgentEvent(event("1", "context.updated", data))).toThrowError(AgentApiError);
  });
  it("restores latest context from a terminal snapshot without requesting native work or inventing intermediate observations", async () => {
    const retained = { ...snapshot("9007199254740993", true), latestContext: { sequence: "9007199254740992", usage: { usedTokens: 109 } } };
    const fetcher = vi.fn().mockResolvedValue(Response.json(retained));
    const items = await collect(new AgentClient({ provider, authorize: async () => authorization(), fetch: fetcher }).watchRun(runId, { cursor: "old-cursor" }));
    expect(items).toEqual([{ kind: "snapshot", snapshot: retained }]);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]![1].method).toBe("GET");
  });
  it("validates retained command results, execution usage, decision history and continuation references", () => {
    const decision = { id: "decision", revision: "1", kind: "approval" as const, delivery: "continue_run" as const };
    const value: AgentRunSnapshot = { ...snapshot(), coverage: { messages: "complete", tools: "truncated", decisions: "complete" }, executionUsage: { sequence: "12", activeMs: 1200, unknown: true },
      tools: [{ id: "tool", name: "Command", state: "failed", command: { status: "failed", exitCode: 1, durationMs: 30 } }],
      decisions: [{ decision, state: "resolved", response: { kind: "approval", decision: "deny" } }], pendingContinuations: [{ requestId, run: { provider, id: runId }, state: "awaiting_authorization" }] };
    validateAgentRunSnapshot(value);
    for (const patch of [
      { coverage: { messages: "all", tools: "complete" } }, { executionUsage: { sequence: "12", activeMs: -1, unknown: false } },
      { tools: [{ id: "tool", name: "Command", state: "completed", command: { status: "completed", durationMs: -1 } }] },
      { decisions: [{ decision, state: "resolved", response: { kind: "approval", decision: "invented" } }] },
      { pendingContinuations: [{ requestId, run: { id: runId }, state: "awaiting_authorization" }] },
    ]) expect(() => validateAgentRunSnapshot({ ...value, ...patch })).toThrow();
  });
});

describe("installation history", () => {
  const envelope = () => ({ sessionId, runId, generation, userId: "user-A", principalId: "principal-A", item: { kind: "snapshot", snapshot: snapshot() } });
  it("keeps the installation cursor separate from the run cursor and sends only the history bearer", async () => {
    const fetcher = vi.fn().mockResolvedValue(stream(`event: observation\nid: installation-9\ndata: ${JSON.stringify(envelope())}\n\n`));
    const items = await collect(watchAgentHistory({ url: "http://provider.test/history/events", token: "read-token", provider, cursor: "previous", fetch: fetcher }));
    expect(items).toEqual([{ ...items[0], cursor: "installation-9", item: { kind: "snapshot", snapshot: expect.objectContaining({ cursor: "cursor-1" }) } }]);
    expect(fetcher.mock.calls[0][0].searchParams.get("after")).toBe("previous");
    expect(fetcher.mock.calls[0][1].headers).toEqual({ accept: "text/event-stream", authorization: "Bearer read-token" });
  });
  it("accepts idle heartbeats, pauses the timer during consumer work and resumes a silent transport from its last observation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const silent = new Response(new ReadableStream({ start(c) { controller = c; }, cancel }), { headers: { "content-type": "text/event-stream" } });
    const frame = (id: string) => `event: observation\nid: ${id}\ndata: ${JSON.stringify(envelope())}\n\n`;
    const fetcher = vi.fn().mockResolvedValueOnce(silent).mockResolvedValueOnce(stream(frame("next")));
    const options = { url: "http://provider.test/history/events", token: "history", provider, fetch: fetcher, idleTimeoutMs: 40 };
    try {
      const iterator = watchAgentHistory(options), first = iterator.next();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30);
        controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      }
      controller.enqueue(new TextEncoder().encode(frame("saved")));
      expect((await first).value?.cursor).toBe("saved");
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).not.toHaveBeenCalled();
      const expired = expect(iterator.next()).rejects.toMatchObject({ code: "history_stream_idle", status: 504 });
      await vi.advanceTimersByTimeAsync(41); await expired;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect((await collect(watchAgentHistory({ ...options, cursor: "saved" }))).map(value => value.cursor)).toEqual(["next"]);
      expect(fetcher.mock.calls[1][0].searchParams.get("after")).toBe("saved");
    } finally { vi.useRealTimers(); }
  });

  it("pages an authorized range through its original watermark", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ through: "high", nextCursor: "p", observations: [{ ...envelope(), cursor: "p" }] }))
      .mockResolvedValueOnce(Response.json({ through: "high", nextCursor: null, observations: [] }));
    const options = { url: "http://provider.test/history/events", token: "read-token", provider, fetch: fetcher, limit: 1 };
    const page = await readAgentHistoryPage(options);
    expect(page.observations[0]?.cursor).toBe("p");
    const last = await readAgentHistoryPage({ ...options, cursor: page.nextCursor!, through: page.through });
    expect(last).toEqual({ observations: [], through: "high", nextCursor: null });
    const query = fetcher.mock.calls[1]![0].searchParams;
    expect(query.get("after")).toBe("p");
    expect(query.get("through")).toBe("high");
  });
  it("only falls back for an unsupported live endpoint and rejects an observation before the ready boundary", async () => {
    const fetcher = vi.fn();
    const options = { url: "http://provider.test/history/events", token: "read-token", provider, fetch: fetcher, onReady: vi.fn() };
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "unsupported_operation" } }, { status: 422 }));
    await expect(collect(watchLiveAgentHistory(options))).rejects.toMatchObject({ code: "history_live_unsupported" });
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "permission_denied" } }, { status: 403 }));
    await expect(collect(watchLiveAgentHistory(options))).rejects.toMatchObject({ code: "permission_denied" });
    fetcher.mockResolvedValueOnce(stream("event: observation\nid: pos\ndata: " + JSON.stringify(envelope()) + "\n\n"));
    await expect(collect(watchLiveAgentHistory(options))).rejects.toMatchObject({ code: "event_invalid" });
    expect(options.onReady).not.toHaveBeenCalled();
  });
  it("rejects missing durable positions, changed state identity and an incorrect next range position", async () => {
    const fetcher = vi.fn();
    const options = { url: "http://provider.test/history/events", token: "read-token", provider, fetch: fetcher,
      through: "boundary", sessionId, epoch: "retained-epoch", from: 2, to: 3 };
    const frame = { ...envelope(), cursor: "receipt", epoch: options.epoch, sessionPosition: 2 };
    for (const page of [{ observations: [{ ...frame, sessionPosition: 3 }], nextPosition: 3 },
      { observations: [frame], nextPosition: null }, { observations: [frame], nextPosition: 9 }]) {
      fetcher.mockResolvedValueOnce(Response.json(page));
      await expect(readAgentHistoryRange(options)).rejects.toMatchObject({ code: "response_invalid" });
    }
    fetcher.mockResolvedValueOnce(Response.json({ through: "boundary", nextSession: null, sessions: [{ ...envelope(),
      sessionId: "different", epoch: options.epoch, head: 3, snapshot: snapshot() }] }));
    await expect(readAgentHistoryStates(options)).rejects.toMatchObject({ code: "response_invalid" });
  });
  it("preserves retryable provider failures for state and range reads", async () => {
    const fetcher = vi.fn(async () => Response.json({
      error: { code: "history_temporarily_unavailable", message: "History is recovering.", retryable: true },
    }, { status: 503 }));
    const options = { url: "http://provider.test/history/events", token: "read-token", provider, fetch: fetcher,
      through: "boundary", sessionId, epoch: "retained-epoch", from: 2, to: 3 };
    const expected = { code: "history_temporarily_unavailable", status: 503, retryable: true };
    await expect(readAgentHistoryStates(options)).rejects.toMatchObject(expected);
    await expect(readAgentHistoryRange(options)).rejects.toMatchObject(expected);
  });
  it("rejects a different run in an otherwise valid history page", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ through: "t", nextCursor: null, observations: [{ ...envelope(), runId: requestId, cursor: "p" }] }));
    await expect(readAgentHistoryPage({ url: "http://provider.test/history/events", token: "read-token", provider, fetch: fetcher })).rejects.toThrow("identity changed");
  });
});

describe("published interoperability artifacts", () => {
  it("ships identical JSON schemas and typed SDK schema exports", () => {
    expect(JSON.parse(readFileSync(new URL("../schemas/agent-v1.openapi.json", import.meta.url), "utf8"))).toEqual(AGENT_OPENAPI);
    expect(JSON.parse(readFileSync(new URL("../schemas/agent-event-v1.schema.json", import.meta.url), "utf8"))).toEqual(AGENT_EVENT_SCHEMA);
  });
  it("validates reusable independent-consumer conformance vectors", () => {
    const fixtures = JSON.parse(readFileSync(new URL("../schemas/agent-v1.fixtures.json", import.meta.url), "utf8")) as { validRequests: Array<{ method: string; path: string; body: unknown }>; invalidRequests: Array<{ method: string; path: string; body: unknown }> };
    for (const fixture of fixtures.validRequests) expect(() => validateAgentRequest(fixture.method, fixture.path, JSON.stringify(fixture.body))).not.toThrow();
    for (const fixture of fixtures.invalidRequests) expect(() => validateAgentRequest(fixture.method, fixture.path, JSON.stringify(fixture.body))).toThrow();
  });
});
