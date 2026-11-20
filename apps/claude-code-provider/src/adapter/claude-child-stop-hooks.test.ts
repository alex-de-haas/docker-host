import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { HarnessEvent, HarnessRun } from "@hosty/agent-provider-runtime/harness/adapter";
import { ClaudeHarnessAdapter } from "./claude.js";
import { WorkerJournal } from "@hosty/agent-provider-runtime/worker/journal";
import { ProviderStore, type VerifiedOperation } from "@hosty/agent-provider-runtime/store";
import { projectEvent, projectReceipt } from "@hosty/agent-provider-runtime/projection";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
const history = vi.hoisted(() => ({ read: vi.fn(async (_request: unknown, _transport: unknown, _report?: (diagnostic: Record<string, unknown>) => void): Promise<unknown[]> => []) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (input: unknown) => sdk.query(input) }));
vi.mock("./claude-history.js", () => ({ readClaudeChildHistory: (request: unknown, transport: unknown, report?: (diagnostic: Record<string, unknown>) => void) => history.read(request, transport, report) }));
const runs: HarnessRun[] = [], finishers: Array<() => void> = [], directories: string[] = [];
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(async () => {
  finishers.splice(0).forEach(finish => finish());
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5000);
  await Promise.allSettled(runs.splice(0).map(run => run.stopAndWait!()));
  vi.useRealTimers(); sdk.query.mockReset(); history.read.mockReset(); history.read.mockResolvedValue([]);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
type Hook = (input: Record<string, unknown>) => Promise<unknown>;
type FixtureOptions = { capture?: boolean; deliver?: boolean; parent?: boolean; duplicate?: boolean; toolName?: string;
  background?: boolean; conflictingCapture?: boolean; post?: Record<string, unknown>; observedInput?: Record<string, unknown>;
  reader?: boolean; assistantUuid?: boolean; assistantMessageId?: boolean; historyPath?: boolean; closeDelay?: number; nativeCloseDelay?: number; nativeCloseDelays?: number[]; noNativeHandle?: boolean;
  observedAgentId?: string | null; observedSessionId?: string | null };
async function fixture(options: FixtureOptions = {}) {
  const events: HarnessEvent[] = [];
  let interrupt!: () => void, finish!: () => void, preHook!: Hook, postHook!: Hook;
  let hookReady = false, iteratorFinished = false, nativeClosed = false;
  const nativeDelays = options.nativeCloseDelays ?? [options.nativeCloseDelay ?? 0], nativeChildren = nativeDelays.map(() => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), killed: false, exitCode: null, signalCode: null }));
  let nativeClosedCount = 0, nextNative = 0, spawnNative!: () => unknown;
  const interrupted = new Promise<void>(resolve => { interrupt = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
  finishers.push(finish);
  const toolName = options.toolName ?? "Bash";
  const pre = { hook_event_name: "PreToolUse", session_id: "native-session", agent_id: "native-child", prompt_id: "current-prompt",
    ...(options.historyPath !== false ? { transcript_path: "/owned/native/projects/transcript.jsonl", cwd: "/unused-fixture" } : {}),
    tool_name: toolName, tool_use_id: "child-command", tool_input: { command: "node -e harmless_fixture", timeout: 45000,
      ...(options.background ? { run_in_background: true } : {}) } };
  const failure = { ...pre, hook_event_name: "PostToolUseFailure", error: "The native child tool was interrupted.", is_interrupt: true, ...options.post };
  const use = (id: string, name: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent,
    ...(options.observedSessionId !== null ? { session_id: options.observedSessionId ?? "native-session" } : {}),
    ...(parent && options.observedAgentId !== null ? { agent_id: options.observedAgentId ?? "native-child" } : {}),
    ...(options.assistantUuid !== false ? { uuid: `assistant-${id}-${parent ?? "root"}` } : {}),
    message: { ...(options.assistantMessageId !== false ? { id: `message-${id}-${parent ?? "root"}` } : {}),
      content: [{ type: "tool_use", id, name, input: name === "Bash" && options.observedInput ? options.observedInput : pre.tool_input }] } });
  const stoppedParent = (id: string) => ({ type: "user", parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "Agent interrupted", is_error: true }] } });
  const query = { async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: "native-session" };
    if (options.parent !== false) yield use("parent", "Agent");
    yield use("child-command", toolName, "parent");
    if (options.duplicate) { yield use("second-parent", "Agent"); yield use("child-command", toolName, "second-parent"); }
    if (options.capture !== false) await preHook(pre);
    if (options.conflictingCapture) await preHook({ ...pre, tool_input: { command: "another command" } });
    hookReady = true;
    await interrupted;
    if (options.parent !== false) yield stoppedParent("parent");
    if (options.duplicate) yield stoppedParent("second-parent");
    // The SDK acknowledges interrupt before the authoritative child hook. It never
    // forwards that child's user/tool_result envelope in this observed SDK shape.
    await new Promise(resolve => setTimeout(resolve, 250));
    if (options.deliver !== false) await postHook(failure);
    await finished;
    iteratorFinished = true;
    nativeChildren.forEach((child, index) => {
      const closeNative = () => { nativeClosed = ++nativeClosedCount === nativeChildren.length; child.emit("close", 0, null); };
      if (nativeDelays[index]) setTimeout(closeNative, nativeDelays[index]); else closeNative();
    });
  }, interrupt: vi.fn(async () => { interrupt(); }), close: vi.fn(() => {
    if (options.closeDelay) setTimeout(finish, options.closeDelay); else finish();
  }) };
  sdk.query.mockImplementation(({ options: queryOptions }) => {
    preHook = queryOptions.hooks.PreToolUse[0].hooks[0]; postHook = queryOptions.hooks.PostToolUseFailure[0].hooks[0];
    spawnNative = () => queryOptions.spawnClaudeCodeProcess({ command: process.execPath, args: [], cwd: "/unused-fixture", env: {} });
    if (options.reader && !options.noNativeHandle) nativeChildren.forEach(() => spawnNative());
    return query;
  });
  const run = new ClaudeHarnessAdapter().start({ sessionId: "consumer-session", cwd: "/unused-fixture", autonomy: "autonomous", onEvent: event => events.push(event),
    ...(options.reader ? { nativeHome: "/owned/native", nativeHistoryHome: { home: "/owned/history", directories: { projects: "/owned/history/projects" } },
      processTransport: { spawn: vi.fn(() => nativeChildren[nextNative++] as never), spawnTool: vi.fn() } } : {}) });
  runs.push(run); run.send("Run the harmless child fixture");
  await vi.waitFor(() => {
    expect(events.filter(event => event.type === "tool_use")).toHaveLength((options.parent === false ? 1 : 2) + (options.duplicate ? 2 : 0));
    expect(hookReady).toBe(true);
  });
  return { run, events, query, pre, failure, get iteratorFinished() { return iteratorFinished; },
    get nativeClosed() { return nativeClosed; },
    spawnNative: () => spawnNative(),
    postHook: (value = failure) => postHook(value), preHook: (value = pre) => preHook(value) };
}
async function stop(f: Awaited<ReturnType<typeof fixture>>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!(); await vi.advanceTimersByTimeAsync(4500); await stopping;
}
async function publicStop(events: HarnessEvent[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-child-hook-proof-")); directories.push(directory);
  const journal = new WorkerJournal(path.join(directory, "journal")); await journal.initialize();
  const request = { conversationId: "conversation", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "claude" as const },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation" as const, id: "conversation" }, input: "fixture", options: {}, autoAllowedPrefixes: [] };
  const runId = randomUUID(); await journal.accept(runId, request); await journal.update(runId, "running");
  for (const event of events) await journal.append(runId, event);
  await journal.update(runId, "cancelled"); // The synthetic SDK stream really closed; command outcome is independent.
  const native = await journal.load(runId), provider = { appId: "unrelated.provider", installationId: "installation", key: "agent" };
  const actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "unrelated.consumer", callerInstallation: "consumer-installation",
    admissionRef: "admission", operation: "runs.start", provider };
  const store = new ProviderStore(path.join(directory, "public"), provider); await store.initialize();
  const configuration = { connection: { id: "account", revision: "1" } };
  await store.create(randomUUID(), actor, "{}", { configuration }, { configuration, digest: "a".repeat(64), resolvedSkills: [] });
  const session = (await store.records())[0]!, record = store.makeRun(session, runId, actor, "{}");
  for (const frame of native.events) projectEvent(store, session, record, frame);
  projectReceipt(store, session, record, native.receipt);
  return record.snapshot;
}

it("uses a matched late child interruption hook after interrupt ACK without fabricating an exit code", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!(); await vi.advanceTimersByTimeAsync(249);
  expect(f.query.close).not.toHaveBeenCalled(); expect(f.events.filter(event => event.type === "command_result")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1); await stopping;
  const commands = f.events.filter(event => event.type === "command_result");
  expect(commands).toEqual([{ type: "command_result", toolUseId: expect.any(String), status: "cancelled",
    source: { agentId: "claude-child:parent", parentAgentId: "root", parentToolCallId: expect.any(String) } }]);
  expect(commands[0]).not.toHaveProperty("exitCode");
  expect(f.events.filter(event => event.type === "tool_result" && event.source)).toMatchObject([{ status: "cancelled", output: f.failure.error }]);
  expect(f.query.close).toHaveBeenCalledOnce();
  expect(await publicStop(f.events)).toMatchObject({ state: "cancelled", stopConfirmed: true, effects: { certainty: "known", unresolvedCallIds: [] } });
  const count = f.events.length; await f.postHook(); expect(f.events).toHaveLength(count);
});

it.each([
  { capture: false }, { deliver: false }, { parent: false }, { duplicate: true }, { background: true }, { conflictingCapture: true },
  { post: { session_id: "another-session" } }, { post: { agent_id: "another-child" } }, { post: { prompt_id: "previous-prompt" } },
  { post: { tool_use_id: "foreign-call" } }, { post: { is_interrupt: false } }, { post: { is_interrupt: "true" } },
  { observedInput: { command: "a different observed command", timeout: 45000 } },
  { observedInput: { command: "node -e harmless_fixture", timeout: 45000, run_in_background: true } },
  { toolName: "mcp__remote__write" },
])("keeps unproven child effects fenced for %j", async options => {
  const f = await fixture(options); await stop(f);
  expect(f.events.filter(event => event.type === "command_result")).toEqual([]);
  const snapshot = await publicStop(f.events);
  expect(snapshot).toMatchObject({ state: "unknown", phase: "interrupted", stopConfirmed: false });
  expect(snapshot.effects.unresolvedCallIds.length).toBeGreaterThan(0);
});

it("does not accept a matching hook after the bounded stop drain and never captures a new stopped tool", async () => {
  const f = await fixture({ deliver: false }); await stop(f); const count = f.events.length;
  await f.postHook(); expect(f.events).toHaveLength(count);
  expect(await f.preHook()).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});

it("recovers only the exact failed child invocation through SDK history after its parent terminal", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  history.read.mockImplementation(async (value) => {
    // The real missing child terminal is persisted only at native CLI teardown.
    expect(f.query.close).toHaveBeenCalledOnce(); expect(f.iteratorFinished).toBe(true); expect(f.nativeClosed).toBe(true);
    const request = value as { nativeSessionId: string; children: Array<{ agentId: string; parentToolUseId: string; calls: Array<{ assistantUuid: string; assistantMessageId: string; toolUseId: string }> }> };
    const child = request.children[0]!, call = child.calls[0]!;
    return [{ agentId: child.agentId, parentToolUseId: child.parentToolUseId, assistantUuid: call.assistantUuid, assistantMessageId: call.assistantMessageId, historyAssistantUuid: "durable-assistant", toolUseId: call.toolUseId,
      resultUuid: "actual-result", result: { type: "tool_result", tool_use_id: call.toolUseId, is_error: true, content: "Native tool failed" } }];
  });
  f = await fixture({ deliver: false, reader: true, nativeCloseDelay: 400 }); await stop(f);
  expect(history.read).toHaveBeenCalledOnce();
  expect(history.read.mock.calls[0]![0]).toMatchObject({ nativeHome: "/owned/history", executionHome: "/owned/native", cwd: "/unused-fixture", nativeSessionId: "native-session",
    children: [{ agentId: "native-child", parentToolUseId: "parent", calls: [{ assistantUuid: "assistant-child-command-parent", toolUseId: "child-command", input: f.pre.tool_input }] }] });
  expect(f.events.filter(event => event.type === "command_result" && event.source)).toEqual([{ type: "command_result", toolUseId: expect.any(String), status: "unknown", source: expect.any(Object) }]);
  expect(f.events.filter(event => event.type === "tool_result" && event.source)).toMatchObject([{ status: "failed", output: "Native tool failed" }]);
  expect(await publicStop(f.events)).toMatchObject({ state: "cancelled", stopConfirmed: true, effects: { certainty: "known", unresolvedCallIds: [] } });
});
it("does not read history between iterator EOF and actual owned native pipe closure", async () => {
  const f = await fixture({ deliver: false, reader: true, nativeCloseDelay: 400 });
  vi.useFakeTimers(); const stopping = f.run.stopAndWait!();
  await vi.advanceTimersByTimeAsync(2000); expect(f.iteratorFinished).toBe(true); expect(f.nativeClosed).toBe(false); expect(history.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400); await stopping; expect(f.nativeClosed).toBe(true); expect(history.read).toHaveBeenCalledOnce();
});
it("waits for every owned native handle and fences replacement spawning during Stop", async () => {
  const f = await fixture({ deliver: false, reader: true, nativeCloseDelays: [500, 100] });
  vi.useFakeTimers(); const stopping = f.run.stopAndWait!();
  expect(() => f.spawnNative()).toThrow("admission is closed");
  await vi.advanceTimersByTimeAsync(2100); expect(f.iteratorFinished).toBe(true); expect(f.nativeClosed).toBe(false); expect(history.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400); await stopping; expect(f.nativeClosed).toBe(true); expect(history.read).toHaveBeenCalledOnce();
});
it("does not admit a helper after a late owned native close consumes the stop reserve", async () => {
  const f = await fixture({ deliver: false, reader: true, nativeCloseDelay: 6500 });
  vi.useFakeTimers(); const stopping = f.run.stopAndWait!();
  await vi.advanceTimersByTimeAsync(8500); await stopping; expect(f.nativeClosed).toBe(true); expect(history.read).not.toHaveBeenCalled();
});
it("does not admit a helper after an unconfirmed native close exceeds the original stop deadline", async () => {
  const f = await fixture({ deliver: false, reader: true, nativeCloseDelay: 12000 });
  vi.useFakeTimers(); const assertion = expect(f.run.stopAndWait!()).rejects.toThrow("exit was not confirmed");
  await vi.advanceTimersByTimeAsync(10_000); await assertion; expect(f.iteratorFinished).toBe(true); expect(f.nativeClosed).toBe(false);
  expect(history.read).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(4000);
  expect(f.nativeClosed).toBe(true); expect(history.read).not.toHaveBeenCalled();
});
it("does not duplicate a known child terminal delivered while its read-only helper is in flight", async () => {
  let release!: () => void;
  history.read.mockImplementation(value => new Promise(resolve => { release = () => {
    const request = value as { children: Array<{ agentId: string; parentToolUseId: string; calls: Array<{ assistantUuid: string; assistantMessageId: string; toolUseId: string }> }> };
    const child = request.children[0]!, call = child.calls[0]!;
    resolve([{ agentId: child.agentId, parentToolUseId: child.parentToolUseId, assistantUuid: call.assistantUuid, assistantMessageId: call.assistantMessageId, historyAssistantUuid: "durable-assistant", toolUseId: call.toolUseId,
      resultUuid: "actual-result", result: { type: "tool_result", tool_use_id: call.toolUseId, is_error: true, content: "Native tool failed" } }]);
  }; }));
  const f = await fixture({ deliver: false, reader: true }); vi.useFakeTimers();
  const stopping = f.run.stopAndWait!(); await vi.advanceTimersByTimeAsync(2000);
  expect(history.read).toHaveBeenCalledOnce(); await f.postHook(); release(); await stopping;
  expect(f.events.filter(event => event.type === "command_result" && event.source)).toHaveLength(1);
  expect((await publicStop(f.events)).stopConfirmed).toBe(true);
});
it("does not admit a history helper when SDK teardown consumed its original cleanup reserve", async () => {
  const f = await fixture({ deliver: false, reader: true, closeDelay: 6500 });
  vi.useFakeTimers();
  const stopping = f.run.stopAndWait!(); await vi.advanceTimersByTimeAsync(8500); await stopping;
  expect(f.iteratorFinished).toBe(true); expect(history.read).not.toHaveBeenCalled();
  expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});
it("does not admit a history helper after an unconfirmed SDK iterator times out", async () => {
  const f = await fixture({ deliver: false, reader: true, closeDelay: 12000 });
  vi.useFakeTimers();
  const assertion = expect(f.run.stopAndWait!()).rejects.toThrow("exit was not confirmed");
  await vi.advanceTimersByTimeAsync(10_000); await assertion; expect(history.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000); expect(f.iteratorFinished).toBe(true); expect(history.read).not.toHaveBeenCalled();
});
it.each([{ capture: false }, { duplicate: true }, { background: true }, { assistantUuid: false }, { assistantMessageId: false }, { historyPath: false }, { parent: false }, { noNativeHandle: true },
  { observedAgentId: null }, { observedAgentId: "foreign-child" }, { observedSessionId: null }, { observedSessionId: "foreign-session" },
  { observedInput: { command: "foreign" } }, { toolName: "mcp__remote__write" }])("does not read guessed or unbound child history %j", async options => {
  const f = await fixture({ ...options, deliver: false, reader: true }); await stop(f);
  expect(history.read).not.toHaveBeenCalled(); expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});
it("withholds SDK stop when the owned history helper has not confirmed exit", async () => {
  history.read.mockRejectedValue(new Error("The owned Claude history helper has not confirmed exit."));
  const f = await fixture({ deliver: false, reader: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const assertion = expect(f.run.stopAndWait!()).rejects.toThrow("history helper has not confirmed exit");
  await vi.advanceTimersByTimeAsync(4500); await assertion;
  expect(f.query.close).toHaveBeenCalledOnce(); expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});
it("logs one bounded diagnostic with hashed bindings without exposing command input or native paths", async () => {
  history.read.mockImplementation(async (_request, _transport, report) => {
    report?.({ outcome: "unavailable", stdoutBytes: 0, stderrBytes: 0, reasons: ["captured_path_mismatch"] }); return [];
  });
  const f = await fixture({ deliver: false, reader: true }); await stop(f);
  const calls = vi.mocked(console.warn).mock.calls.map(call => String(call[0])).filter(message => message.startsWith("[claude-child-history] "));
  expect(calls).toHaveLength(1); const diagnostic = JSON.parse(calls[0]!.slice("[claude-child-history] ".length));
  expect(diagnostic).toMatchObject({ outcome: "unavailable", reasons: ["captured_path_mismatch"], binding: { session: expect.stringMatching(/^[a-f0-9]{64}$/),
    children: [{ calls: [{ liveUuid: expect.stringMatching(/^[a-f0-9]{64}$/), messageId: expect.stringMatching(/^[a-f0-9]{64}$/), input: expect.stringMatching(/^[a-f0-9]{64}$/) }] }] } });
  for (const raw of ["/owned/native", "/owned/history", "/unused-fixture", "native-child", "native-session", "node -e harmless_fixture", "child-command"])
    expect(calls[0]).not.toContain(raw);
  expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});
it.each([
  { options: { assistantMessageId: false }, reason: "missing_message_id" },
  { options: { observedAgentId: "foreign-child" }, reason: "stream_agent_mismatch" },
  { options: { observedSessionId: "foreign-session" }, reason: "stream_session_mismatch" },
  { options: { observedInput: { command: "different" } }, reason: "observed_input_mismatch" },
  { options: { parent: false }, reason: "unsupported_parent" },
  { options: { historyPath: false }, reason: "capture_unavailable" },
])("distinguishes unbound history admission without admitting work: $reason", async ({ options, reason }) => {
  const f = await fixture({ ...options, deliver: false, reader: true }); await stop(f);
  expect(history.read).not.toHaveBeenCalled();
  const diagnostic = vi.mocked(console.warn).mock.calls.map(call => String(call[0])).filter(value => value.startsWith("[claude-child-history] "))
    .map(value => JSON.parse(value.slice("[claude-child-history] ".length))).find(value => value.outcome === "binding_unavailable");
  expect(diagnostic?.admissionReasons?.[reason]).toBe(1);
  expect((await publicStop(f.events)).stopConfirmed).toBe(false);
});
