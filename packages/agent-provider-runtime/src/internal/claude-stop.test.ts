import { afterEach, expect, it, vi } from "vitest";
import type { HarnessEvent } from "./harness/adapter.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
import { trackedAdapter } from "../tracked-adapter.js";
import type { TrackedNativeProcesses } from "../tracked-process.js";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => sdk.query(args) }));
const finishers: Array<() => void> = [];
afterEach(() => { for (const finish of finishers.splice(0)) finish(); vi.useRealTimers(); sdk.query.mockReset(); });
function fixture(options: { neverFinish?: boolean; rejectedInterrupt?: boolean; autonomy?: "normal" | "autonomous" } = {}) {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; }); finishers.push(finish);
  const query = { async *[Symbol.asyncIterator]() {
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "unresolved-command", name: "Bash", input: { command: "fixture" } }] } };
    await finished;
  }, interrupt: vi.fn(() => options.rejectedInterrupt ? Promise.reject(new Error("Native interrupt unavailable")) : new Promise<void>(() => {})),
    close: vi.fn(() => { if (!options.neverFinish) finish(); }) };
  sdk.query.mockReturnValue(query);
  let sdkStopped = false;
  const processes = { transport: {}, confirmSdkStop: vi.fn(async () => { sdkStopped = true; }),
    stop: vi.fn(async () => ({ stopped: sdkStopped, allClosed: true, reason: sdkStopped ? undefined : "sdk_stop_unconfirmed" })) };
  const events: HarnessEvent[] = [];
  const run = trackedAdapter(new ClaudeHarnessAdapter(), processes as unknown as TrackedNativeProcesses)
    .start({ sessionId: "isolated-claude-stop", cwd: "/unused-fixture", autonomy: options.autonomy, onEvent: event => events.push(event) });
  run.send("Synthetic cancellation fixture");
  return { run, query, processes, events };
}

it("bounds a hanging Claude interrupt, denies pending permission and closes once before confirming the SDK stream", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.events.some(event => event.type === "native_effect")).toBe(true));
  const options = sdk.query.mock.calls[0]![0].options;
  const permission = options.canUseTool("Write", { file_path: "fixture" });
  expect(f.events.some(event => event.type === "approval_request")).toBe(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const polite = f.run.interrupt();
  const first = f.run.stopAndWait!(), repeated = f.run.stopAndWait!();
  await expect(permission).resolves.toMatchObject({ behavior: "deny" });
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.query.close).not.toHaveBeenCalled(); expect(f.processes.confirmSdkStop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.query.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all([polite, first, repeated]);
  expect(f.query.interrupt).toHaveBeenCalledOnce(); expect(f.query.close).toHaveBeenCalledOnce();
  expect(f.processes.confirmSdkStop).toHaveBeenCalled();
  expect(f.events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started"]);
  expect(f.events.some(event => event.type === "result" || event.type === "command_result")).toBe(false);
});

it("times out the entire Claude stop when close never ends the query, cleans its owned tree and never records SDK completion", async () => {
  const f = fixture({ neverFinish: true });
  await vi.waitFor(() => expect(f.events.some(event => event.type === "native_effect")).toBe(true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!();
  const outcome = stopping.then(() => ({ confirmed: true, message: "" }), error => ({ confirmed: false, message: error.message }));
  await vi.advanceTimersByTimeAsync(4000); expect(f.query.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5999); expect(f.processes.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toEqual({ confirmed: false, message: "Claude execution exit was not confirmed. Source lease remains held." });
  expect(f.processes.stop).toHaveBeenCalledOnce(); expect(f.processes.confirmSdkStop).not.toHaveBeenCalled();
  expect(f.events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started"]);
  expect(f.events.some(event => event.type === "result" || event.type === "command_result")).toBe(false);
});

it("still closes after a rejected polite interrupt without waiting for the full deadline", async () => {
  const f = fixture({ rejectedInterrupt: true });
  await vi.waitFor(() => expect(f.events.some(event => event.type === "native_effect")).toBe(true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!(); await vi.advanceTimersByTimeAsync(2000); await stopping;
  expect(f.query.close).toHaveBeenCalledOnce(); expect(f.processes.confirmSdkStop).toHaveBeenCalledOnce();
});

it("does not create an SDK query when Stop wins its asynchronous initialization", async () => {
  const run = new ClaudeHarnessAdapter().start({ sessionId: "stopped-before-import", cwd: "/unused-fixture", onEvent() {} });
  await run.stopAndWait!();
  expect(sdk.query).not.toHaveBeenCalled();
});

it.each(["normal", "autonomous"] as const)("denies late SDK tool and question callbacks during Stop in %s mode", async autonomy => {
  const f = fixture({ autonomy });
  await vi.waitFor(() => expect(f.events.some(event => event.type === "native_effect")).toBe(true));
  const callback = sdk.query.mock.calls[0]![0].options.canUseTool;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!();
  const results = await Promise.all([
    callback("Read", { file_path: "must-not-read" }), callback("Bash", { command: "must-not-execute" }),
    callback("AskUserQuestion", { questions: [{ question: "Must not ask", options: [] }] }),
  ]);
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ behavior: "deny", message: "Session stopped." })));
  expect(f.events.some(event => event.type === "approval_request" || event.type === "question_request")).toBe(false);
  expect(f.query.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000); await stopping;
  expect(f.query.close).toHaveBeenCalledOnce();
});

it("drains only registered root/child tool terminals during Stop without accepting new work or settling a missing remote result", async () => {
  const events: HarnessEvent[] = [];
  let interrupt!: () => void, finish!: () => void;
  const interrupted = new Promise<void>(resolve => { interrupt = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
  finishers.push(finish);
  const use = (id: string, name: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input: {} }] } });
  const result = (id: string, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent,
    tool_use_result: { stdout: "", stderr: "Interrupted", interrupted: true },
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "Interrupted", is_error: false }] } });
  const query = { async *[Symbol.asyncIterator]() {
    yield use("parent", "Agent"); yield use("root-command", "Bash"); yield use("child-command", "Bash", "parent");
    yield use("remote-call", "mcp__external__write");
    await interrupted;
    yield { ...result("root-command"), isReplay: true };
    yield result("root-command", "foreign-parent"); yield result("foreign-call");
    yield result("root-command"); yield result("root-command"); yield result("child-command", "parent");
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "parent", content: "Child stopped", is_error: false }] } };
    yield use("must-not-start", "Bash"); yield { type: "assistant", message: { content: [{ type: "text", text: "Late new answer" }] } };
    yield { type: "result", subtype: "success" };
    await finished;
  }, interrupt: vi.fn(async () => { interrupt(); }), close: vi.fn(() => { finish(); }) };
  sdk.query.mockReturnValue(query);
  const run = new ClaudeHarnessAdapter().start({ sessionId: "cancel-drain-fixture", cwd: "/unused-fixture", onEvent: event => events.push(event) });
  run.send("Synthetic known calls");
  await vi.waitFor(() => expect(events.filter(event => event.type === "native_effect")).toHaveLength(4));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = run.stopAndWait!(); await vi.advanceTimersByTimeAsync(2000); await stopping;
  const commands = events.filter(event => event.type === "command_result");
  expect(commands).toHaveLength(2); expect(commands.map(event => event.status)).toEqual(["cancelled", "cancelled"]);
  expect(commands[0]?.source).toBeUndefined(); expect(commands[1]?.source?.agentId).toBe("claude-child:parent");
  for (const command of commands) expect(events.filter(event => event.type === "native_effect" && event.id === command.toolUseId).map(event => event.type === "native_effect" && event.state)).toEqual(["started", "settled"]);
  const remote = events.find(event => event.type === "tool_use" && event.toolName === "mcp__external__write");
  expect(remote?.type === "tool_use" && events.filter(event => event.type === "native_effect" && event.id === remote.toolUseId).map(event => event.type === "native_effect" && event.state)).toEqual(["started"]);
  expect(events.filter(event => event.type === "tool_use")).toHaveLength(4);
  expect(events.some(event => event.type === "assistant_text" || event.type === "result")).toBe(false);
  expect(events.filter(event => event.type === "agent_status")).toHaveLength(1);
  expect(query.close).toHaveBeenCalledOnce();
});

it("keeps the SDK stream open after interrupt ACK until its delayed exact terminal arrives", async () => {
  const events: HarnessEvent[] = [];
  let terminal!: () => void, finish!: () => void, closed = false;
  const terminalReady = new Promise<void>(resolve => { terminal = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
  finishers.push(finish);
  const query = { async *[Symbol.asyncIterator]() {
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "delayed-command", name: "Bash", input: {} }] } };
    await terminalReady;
    if (!closed) yield { type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "delayed-command", content: "Interrupted", is_error: true }] } };
    await finished;
  }, interrupt: vi.fn(async () => { setTimeout(terminal, 250); }), close: vi.fn(() => { closed = true; finish(); terminal(); }) };
  sdk.query.mockReturnValue(query);
  const run = new ClaudeHarnessAdapter().start({ sessionId: "ack-before-terminal", cwd: "/unused-fixture", onEvent: event => events.push(event) }); run.send("Synthetic delayed result");
  await vi.waitFor(() => expect(events.some(event => event.type === "native_effect")).toBe(true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = run.stopAndWait!();
  await vi.advanceTimersByTimeAsync(249); expect(query.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await stopping;
  expect(query.close).toHaveBeenCalledOnce();
  expect(events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started", "settled"]);
  // Actual interrupted envelopes can omit BashOutput; invocation completion invents no exit code.
  expect(events.filter(event => event.type === "command_result")).toEqual([expect.objectContaining({ status: "unknown" })]);
  expect(events.find(event => event.type === "command_result")).not.toHaveProperty("exitCode");
});

it.each(["normal", "autonomous"] as const)("uses the documented PreToolUse deny fence during the terminal drain in %s mode", async autonomy => {
  const f = fixture({ autonomy });
  await vi.waitFor(() => expect(f.events.some(event => event.type === "native_effect")).toBe(true));
  const hook = sdk.query.mock.calls[0]![0].options.hooks.PreToolUse[0].hooks[0];
  const input = { hook_event_name: "PreToolUse", session_id: "sdk-session", transcript_path: "/unused-fixture/transcript", cwd: "/unused-fixture",
    tool_name: "Bash", tool_use_id: "must-not-execute", tool_input: { command: "fixture" } };
  expect(await hook(input)).toEqual({});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = f.run.stopAndWait!();
  expect(await hook(input)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Session stopped." } });
  expect(f.events.some(event => event.type === "approval_request" || event.type === "question_request")).toBe(false);
  await vi.advanceTimersByTimeAsync(4000); await stopping;
  expect(f.query.close).toHaveBeenCalledOnce();
});

it("does not turn an SDK-local MCP cancellation error into proof of a remote outcome", async () => {
  const events: HarnessEvent[] = [];
  let interrupt!: () => void, finish!: () => void;
  const interrupted = new Promise<void>(resolve => { interrupt = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
  finishers.push(finish);
  sdk.query.mockReturnValue({ async *[Symbol.asyncIterator]() {
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "remote-write", name: "mcp__external__write", input: {} }] } };
    await interrupted;
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "remote-write", content: "Cancelled by local SDK", is_error: true }] } };
    await finished;
  }, interrupt: async () => { interrupt(); }, close: () => { finish(); } });
  const run = new ClaudeHarnessAdapter().start({ sessionId: "remote-cancel-unknown", cwd: "/unused-fixture", onEvent: event => events.push(event) }); run.send("Synthetic remote call");
  await vi.waitFor(() => expect(events.some(event => event.type === "native_effect")).toBe(true));
  await run.stopAndWait!();
  expect(events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started", "unknown"]);
  expect(events.filter(event => event.type === "tool_result")).toEqual([expect.objectContaining({ status: "unknown" })]);
  expect(events.some(event => event.type === "result")).toBe(false);
});
