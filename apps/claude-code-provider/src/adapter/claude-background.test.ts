import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerEngine } from "@hosty/agent-provider-runtime/worker/engine";
import { WorkerJournal } from "@hosty/agent-provider-runtime/worker/journal";
import type { HarnessEvent } from "@hosty/agent-provider-runtime/harness/adapter";
import type { WorkerRunRequest } from "@hosty/agent-provider-runtime/worker/contracts";
import { ClaudeHarnessAdapter } from "./claude.js";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => sdk.query(...args) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  sdk.query.mockReset();
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-background-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const messages: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined, closed = false, consumed = 0;
  const close = vi.fn(() => { closed = true; wake?.(); });
  const query = { async *[Symbol.asyncIterator]() {
    while (!closed) {
      if (!messages.length) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; continue; }
      yield messages.shift()!; consumed++;
    }
  }, close, interrupt: vi.fn(async () => {}), applyFlagSettings: async () => {} };
  sdk.query.mockReturnValue(query);
  const journal = new WorkerJournal(directory); await journal.initialize();
  const adapter = new ClaudeHarnessAdapter({ ANTHROPIC_API_KEY: "isolated-test-placeholder" });
  const engine = new WorkerEngine(journal, { adapter: async () => adapter, cwd: async () => directory,
    reserve: async () => () => {}, validateSelection: async () => {} }, 1);
  cleanups.push(() => engine.close());
  const request: WorkerRunRequest = { conversationId: "chat", operation: "chat", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "claude" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat" }, input: "Research with three background children", options: { promptSuggestions: true }, autoAllowedPrefixes: [] };
  await engine.submit("run", request); await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
  const push = async (...values: Record<string, unknown>[]) => {
    const target = consumed + messages.length + values.length; messages.push(...values); wake?.();
    await vi.waitFor(() => expect(consumed).toBeGreaterThanOrEqual(target));
    await journal.exclusive(async () => {});
  };
  await push({ type: "system", subtype: "init", session_id: "native" });
  const endStream = () => { closed = true; wake?.(); };
  const pushDuringStop = async (...values: Record<string, unknown>[]) => {
    const target = consumed + messages.length + values.length; messages.push(...values); wake?.();
    await vi.waitFor(() => expect(consumed).toBeGreaterThanOrEqual(target));
  };
  return { engine, journal, push, close, query, endStream, pushDuringStop };
}
const assistant = (content: unknown[], parent?: string) => ({ type: "assistant", session_id: "native", ...(parent ? { parent_tool_use_id: parent } : {}), message: { content } });
const tool = (id: string, name: string, input = {}) => ({ type: "tool_use", id, name, input });
const result = () => ({ type: "result", subtype: "success", session_id: "native" });
const tasks = (ids: string[]) => ({ type: "system", subtype: "background_tasks_changed", session_id: "native", tasks: ids.map(task_id => ({ task_id, task_type: "local_agent", description: task_id })) });
const started = (id: string) => ({ type: "system", subtype: "task_started", session_id: "native", task_id: id, tool_use_id: `spawn-${id}`, task_type: "local_agent", is_backgrounded: true });
const finished = (id: string, status = "completed") => ({ type: "system", subtype: "task_notification", session_id: "native", task_id: id, tool_use_id: `spawn-${id}`, status, summary: id, output_file: "unused" });
const toolResult = (id: string, parent: string, failed = false) => ({ type: "user", session_id: "native", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "Research result", is_error: failed }] } });

it("keeps background children and their parent continuation alive when predictions are disabled after a root result", async () => {
  const f = await fixture();
  await f.push(assistant([tool("spawn-one", "Agent", { run_in_background: true }), tool("spawn-two", "Agent", { run_in_background: true }), tool("spawn-three", "Agent", { run_in_background: true })]),
    tasks(["one", "two", "three"]), started("one"), started("two"), started("three"),
    { type: "user", message: { content: ["one", "two", "three"].map(id => ({ type: "tool_result", tool_use_id: `spawn-${id}`, content: "Background agent started" })) } },
    assistant([tool("fetch-one", "WebFetch")], "spawn-one"), assistant([tool("search-two", "WebSearch")], "spawn-two"),
    assistant([{ type: "text", text: "Waiting for the three research children." }]), result());
  await f.engine.disableSuggestions("run", "disable-predictions");
  expect(f.close).not.toHaveBeenCalled();
  expect((await f.journal.load("run")).receipt).toMatchObject({ state: "running" });
  expect((await f.journal.load("run")).events.some(frame => frame.event.type === "answer_complete")).toBe(false);
  await f.push(toolResult("fetch-one", "spawn-one"), tasks(["two", "three"]), finished("one"),
    assistant([tool("fetch-three", "WebFetch")], "spawn-three"), toolResult("search-two", "spawn-two", true),
    tasks(["three"]), finished("two", "failed"), toolResult("fetch-three", "spawn-three"), tasks([]), finished("three"));
  expect(f.close).not.toHaveBeenCalled();
  await f.push(assistant([{ type: "text", text: "Final synthesis after all three children." }]), result(), { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt).toMatchObject({ state: "completed", exitConfirmed: true, effects: {} }));
  expect((await f.journal.load("run")).receipt.effects).toEqual({});
  const events = (await f.journal.load("run")).events.map(frame => frame.event);
  expect(events.flatMap(event => event.type === "tool_result" && event.source ? [event.status] : [])).toEqual(["completed", "failed", "completed"]);
  expect(events.filter(event => event.type === "result" && !event.source)).toEqual([expect.objectContaining({ status: "success" })]);
  expect(events).toContainEqual(expect.objectContaining({ type: "assistant_text", text: "Final synthesis after all three children." }));
  expect(f.close).toHaveBeenCalledOnce();
});

it("uses native idle rather than task bookend ordering to finish the parent and buffers its final prediction", async () => {
  const f = await fixture();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "running" },
    assistant([tool("spawn-one", "Agent", { run_in_background: true })]), tasks(["one"]), started("one"),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "spawn-one", content: "Background agent started" }] } },
    assistant([{ type: "text", text: "Waiting." }]), result(),
    { type: "prompt_suggestion", session_id: "native", suggestion: "Stale while child is running" });
  await f.push(tasks([]), finished("one"),
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "running" },
    assistant([{ type: "text", text: "Final synthesis." }]), result(),
    { type: "prompt_suggestion", session_id: "native", suggestion: "Valid final prediction" });
  expect(f.close).not.toHaveBeenCalled();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
  expect((await f.journal.load("run")).events.flatMap(frame => frame.event.type === "prompt_suggestion" ? [frame.event.text] : []))
    .toEqual(["Valid final prediction"]);
});

it("explicitly cancels all owned background work after root yield while retaining late child terminals", async () => {
  const f = await fixture();
  await f.push(assistant([tool("spawn-one", "Agent", { run_in_background: true })]), tasks(["one"]), started("one"),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "spawn-one", content: "Background agent started" }] } },
    assistant([tool("fetch", "WebFetch")], "spawn-one"), result());
  f.query.interrupt.mockImplementation(async () => {
    await f.push(toolResult("fetch", "spawn-one", true), finished("one", "stopped"), tasks([]),
      { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  });
  const receipt = await f.engine.cancel("run", "explicit-stop");
  expect(receipt).toMatchObject({ state: "cancelled", exitConfirmed: true });
  expect(receipt.effects).toEqual({});
  expect(f.close).toHaveBeenCalledOnce();
  const events = (await f.journal.load("run")).events.map(frame => frame.event);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent_status", agentId: "claude-child:spawn-one", state: "cancelled" }));
  expect(events.some(event => event.type === "result")).toBe(false);
});

it("does not let foreign idle, duplicate task starts or ambient watchers complete pending child work", async () => {
  const f = await fixture();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "running" },
    assistant([tool("spawn-one", "Agent", { run_in_background: true })]), tasks(["one"]), { ...started("one"), run_id: "run-2" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "spawn-one", content: "Background agent started" }] } },
    result(), { type: "system", subtype: "session_state_changed", session_id: "foreign", state: "idle" },
    { ...finished("one"), run_id: "run-1" });
  expect(f.close).not.toHaveBeenCalled();
  await f.push({ ...finished("one"), run_id: "run-2" }, { ...started("one"), run_id: "run-2" },
    { type: "system", subtype: "background_tasks_changed", session_id: "native", tasks: [{ task_id: "watcher", task_type: "local_agent", description: "Ambient", ambient: true }] },
    assistant([{ type: "text", text: "Done." }]), result());
  await f.engine.disableSuggestions("run", "disable");
  expect(f.close).not.toHaveBeenCalled();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
  const states = (await f.journal.load("run")).events.flatMap(frame => frame.event.type === "agent_status" ? [frame.event.state] : []);
  expect(states).toEqual(["running", "succeeded"]);
});


it("ignores model-less notification acknowledgements until the parent produces its continuation result", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), result());
  await f.engine.disableSuggestions("run", "disable");
  await f.push(finished("one"), tasks([]), { ...result(), num_turns: 0, result: "" });
  expect(f.close).not.toHaveBeenCalled();
  await f.push(assistant([{ type: "text", text: "Final synthesis." }]), { ...result(), num_turns: 1, result: "Final synthesis." }, { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
  expect((await f.journal.load("run")).events.filter(frame => frame.event.type === "result")).toHaveLength(1);
});

it("does not hold a completed parent turn for persistent background shells or ambient agents", async () => {
  const f = await fixture();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "running" },
    { type: "system", subtype: "background_tasks_changed", session_id: "native", tasks: [
      { task_id: "server", task_type: "local_bash", description: "Persistent preview" },
      { task_id: "watcher", task_type: "local_agent", description: "Ambient watcher", ambient: true },
    ] }, result());
  await f.engine.disableSuggestions("run", "disable");
  expect(f.close).not.toHaveBeenCalled();
  await f.push({ type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
});


it("reports interrupted EOF even between the yielded root result and its next continuation result", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), result(),
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "running" });
  f.endStream();
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("failed"));
  expect((await f.journal.load("run")).events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "error", message: expect.stringContaining("Native completion is unconfirmed") }) }));
});

it("does not accept a foreign or replayed root result as the parent continuation", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), result(), finished("one"), tasks([]),
    { ...result(), session_id: "foreign" }, { ...result(), isReplay: true });
  await f.engine.disableSuggestions("run", "disable");
  expect(f.close).not.toHaveBeenCalled();
  await f.push({ ...result(), num_turns: 1, result: "" }, { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
});

it("retains exact late child terminals produced by normal final-result teardown", async () => {
  const f = await fixture();
  await f.push(assistant([tool("late-fetch", "WebFetch")], "spawn-one"));
  await f.engine.disableSuggestions("run", "disable");
  f.query.interrupt.mockImplementation(async () => { await f.pushDuringStop(toolResult("late-fetch", "spawn-one")); });
  await f.push(result(), { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt).toMatchObject({ state: "completed", exitConfirmed: true, effects: {} }));
  expect((await f.journal.load("run")).receipt.effects).toEqual({});
  expect((await f.journal.load("run")).events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "tool_result", status: "completed", source: expect.objectContaining({ agentId: "claude-child:spawn-one" }) }) }));
});

it("keeps malformed background inventories uncertain until a valid native replacement arrives", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), result(),
    { type: "system", subtype: "background_tasks_changed", session_id: "native", tasks: [{ task_id: "one" }] },
    { ...result(), num_turns: 1, result: "An uncertain inventory is not completion evidence." });
  await f.engine.disableSuggestions("run", "disable");
  expect(f.close).not.toHaveBeenCalled();
  await f.push(finished("one"), tasks([]), { ...result(), num_turns: 1, result: "Final synthesis." }, { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
  expect((await f.journal.load("run")).events.filter(frame => frame.event.type === "notice" && frame.event.message.includes("background activity"))).toHaveLength(1);
});


it("waits for native idle while completed children's notifications still drive parent turns", async () => {
  const f = await fixture();
  await f.push(tasks(["one", "two", "three"]), started("one"), started("two"), started("three"),
    assistant([{ type: "text", text: "Waiting for children." }]), result(),
    finished("one"), finished("two"), finished("three"), tasks([]),
    assistant([{ type: "text", text: "BETA returned; GAMMA's notification is still queued." }]),
    { ...result(), num_turns: 1, result: "BETA returned; still waiting." });
  expect((await f.journal.load("run")).receipt.state).toBe("running");
  expect((await f.journal.load("run")).events.some(frame => frame.event.type === "answer_complete")).toBe(false);
  await f.engine.disableSuggestions("run", "disable-during-queued-parent-notification");
  expect(f.close).not.toHaveBeenCalled();
  await f.push(assistant([{ type: "text", text: "Final synthesis from all three observed child results." }]),
    { ...result(), num_turns: 1, result: "Final synthesis from all three observed child results." },
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt.state).toBe("completed"));
  const events = (await f.journal.load("run")).events.map(frame => frame.event);
  expect(events.filter(event => event.type === "result" && !event.source)).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "assistant_text", text: "Final synthesis from all three observed child results." }));
});

it("fences a late successful root result delivered while native interrupt is still acknowledging cancellation", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), result(), finished("one"), tasks([]));
  f.query.interrupt.mockImplementation(async () => {
    await f.pushDuringStop({ ...result(), num_turns: 1, result: "Must not complete after cancellation." },
      { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  });
  expect(await f.engine.cancel("run", "cancel-before-late-root-result")).toMatchObject({ state: "cancelled", exitConfirmed: true });
  expect((await f.journal.load("run")).events.some(frame => frame.event.type === "result" || frame.event.type === "answer_complete")).toBe(false);
});

it("keeps the public lifecycle fallback pending after an ended child's command drains from an early idle", async () => {
  const f = await fixture();
  await f.push(tasks(["one"]), started("one"), finished("one"),
    { type: "system", subtype: "background_tasks_changed", session_id: "native", tasks: [{ task_id: "bash", task_type: "local_bash", parent_task_id: "one" }] },
    { ...result(), num_turns: 1, result: "Waiting for the child's command." },
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await f.engine.disableSuggestions("run", "disable-during-nested-command");
  expect(f.close).not.toHaveBeenCalled();
  await f.push(tasks([]), { ...result(), num_turns: 0, result: "" },
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  expect(f.close).not.toHaveBeenCalled();
  expect((await f.journal.load("run")).receipt.state).toBe("running");
  await f.push(assistant([{ type: "text", text: "Final synthesis with the verified command output." }]),
    { ...result(), num_turns: 1, result: "Final synthesis." },
    { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  await vi.waitFor(async () => expect((await f.journal.load("run")).receipt).toMatchObject({ state: "completed", exitConfirmed: true }));
});

const bashCall = (event: HarnessEvent): event is Extract<HarnessEvent, { type: "tool_use" }> => event.type === "tool_use" && event.toolName === "Bash";
const bashStarted = (taskId: string, runId: string, toolId: string, owner?: string) => ({
  type: "system", subtype: "task_started", session_id: "native", task_type: "local_bash",
  task_id: taskId, run_id: runId, tool_use_id: toolId, is_backgrounded: true,
  ...(owner ? { parent_task_id: owner } : {}),
});
const bashFinished = (taskId: string, runId: string, toolId: string, status: string) => ({
  type: "system", subtype: "task_notification", session_id: "native", task_id: taskId,
  run_id: runId, tool_use_id: toolId, status, summary: "Notification metadata", output_file: "/private/fixture-output",
});
const bashLaunch = (toolId: string, parent?: string) => ({
  type: "user", session_id: "native", ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "Started in background" }] },
});

it("projects only an exact background Bash terminal to the right child even when sibling tool IDs repeat", async () => {
  const f = await fixture();
  await f.push(
    assistant([tool("spawn-one", "Agent"), tool("spawn-two", "Agent")]), started("one"), started("two"),
    assistant([tool("bash", "Bash", { run_in_background: true })], "spawn-one"),
    assistant([tool("bash", "Bash", { run_in_background: true })], "spawn-two"),
    bashStarted("command-one", "run-b", "bash", "one"),
    { ...bashStarted("command-two", "run-c", "bash", "two"), is_backgrounded: false },
    { type: "system", subtype: "task_updated", session_id: "native", task_id: "command-two", run_id: "run-c", patch: { is_backgrounded: true } },
    bashLaunch("bash", "spawn-one"), bashLaunch("bash", "spawn-two"),
  );
  const first = bashFinished("command-one", "run-b", "bash", "failed");
  await f.push(
    { ...first, run_id: "run-a", status: "completed" },
    { ...first, tool_use_id: "different", status: "completed" },
    { ...first, session_id: "other", status: "completed" },
    { ...first, reason: "worker_restart", status: "stopped" },
    { ...first, isReplay: true, status: "completed" },
    { ...first, task_id: "unbound", status: "completed" },
  );
  const events = async () => (await f.journal.load("run")).events.map(frame => frame.event);
  expect((await events()).filter(event => event.type === "tool_result" || event.type === "command_result")).toEqual([]);
  await f.push(first, first, bashFinished("command-two", "run-c", "bash", "completed"));
  const projected = await events();
  const calls = projected.filter(bashCall);
  expect(calls).toHaveLength(2);
  expect(projected.filter(event => event.type === "command_result")).toEqual(calls.map((call, index) => ({
    type: "command_result", toolUseId: call.toolUseId, status: index === 0 ? "failed" : "completed", source: call.source,
  })));
  expect(projected.filter(event => event.type === "tool_result")).toEqual([]);
  expect(projected.filter(event => event.type === "native_effect" && event.state === "settled")).toEqual(calls.map(call => ({
    type: "native_effect", id: call.toolUseId, state: "settled", source: call.source,
  })));
});

it("retains a root Bash terminal received while generating a suggestion", async () => {
  const f = await fixture();
  await f.push(assistant([tool("bash", "Bash", { run_in_background: true })]),
    bashStarted("command", "run-a", "bash"), bashLaunch("bash"),
    result(), { type: "system", subtype: "session_state_changed", session_id: "native", state: "idle" });
  expect((await f.journal.load("run")).receipt.state).toBe("suggesting");
  await f.push(bashFinished("command", "run-a", "bash", "completed"));
  await f.push({ type: "prompt_suggestion", session_id: "native", suggestion: "Consider the result." });
  const state = await f.journal.load("run");
  expect(state.receipt).toMatchObject({ state: "completed", exitConfirmed: true, effects: {} });
  const events = state.events.map(frame => frame.event);
  const call = events.find(bashCall);
  expect(call).toBeDefined();
  expect(events.filter(event => event.type === "command_result")).toEqual([
    { type: "command_result", toolUseId: call?.toolUseId, status: "completed" },
  ]);
});

it("keeps a background command unknown when cancellation races its launch receipt and no terminal arrives", async () => {
  const f = await fixture();
  await f.push(assistant([tool("spawn-one", "Agent")]), started("one"),
    assistant([tool("bash", "Bash", { run_in_background: true })], "spawn-one"),
    bashStarted("command", "run-a", "bash", "one"));
  f.query.interrupt.mockImplementation(async () => {
    await f.pushDuringStop(bashLaunch("bash", "spawn-one"));
  });
  const stopped = await f.engine.cancel("run", "stop-unreported-command");
  const events = (await f.journal.load("run")).events.map(frame => frame.event);
  const call = events.find(bashCall);
  expect(call).toBeDefined();
  expect(stopped.exitConfirmed).toBe(true);
  expect(events.filter(event => event.type === "command_result")).toEqual([
    { type: "command_result", toolUseId: call?.toolUseId, status: "unknown", source: call?.source },
  ]);
  expect(events.filter(event => event.type === "tool_result")).toEqual([]);
});

it("drains a late-starting command and its native cancellation before closing the query", async () => {
  const f = await fixture();
  await f.push(assistant([tool("spawn-one", "Agent")]), started("one"),
    bashLaunch("spawn-one"),
    assistant([tool("bash", "Bash", { run_in_background: true })], "spawn-one"));
  let acknowledged = false;
  f.query.interrupt.mockImplementation(async () => {
    await f.pushDuringStop(bashStarted("command", "run-a", "bash", "untracked-owner"),
      bashStarted("command", "run-a", "bash", "one"), bashLaunch("bash", "spawn-one"));
    acknowledged = true;
  });
  const cancellation = f.engine.cancel("run", "stop-late-start");
  await vi.waitFor(() => expect(acknowledged).toBe(true));
  expect(f.close).not.toHaveBeenCalled();

  await f.pushDuringStop(bashFinished("command", "run-a", "bash", "stopped"));
  const receipt = await cancellation;
  const events = (await f.journal.load("run")).events.map(frame => frame.event);
  const call = events.find(bashCall);
  expect(receipt.exitConfirmed).toBe(true);
  expect(events.filter(event => event.type === "command_result")).toEqual([
    { type: "command_result", toolUseId: call?.toolUseId, status: "cancelled", source: call?.source },
  ]);
  expect(events.filter(event => event.type === "tool_result" && event.toolUseId === call?.toolUseId)).toEqual([]);
});
