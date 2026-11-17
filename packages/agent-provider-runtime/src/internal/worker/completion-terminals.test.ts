import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerEngine } from "./engine.js";
import { WorkerJournal } from "./journal.js";
import type { WorkerRunRequest } from "./contracts.js";
import { nativeEventIdentity, type HarnessEvent, type HarnessStartOptions } from "../harness/adapter.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const child = { agentId: "child", parentAgentId: "root", parentToolCallId: "spawn" };
async function fixture(suggestions = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "worker-completion-terminals-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new WorkerJournal(directory); await journal.initialize();
  let options: HarnessStartOptions | undefined;
  const release = vi.fn(), stop = vi.fn(async () => {});
  const engine = new WorkerEngine(journal, { reserve: async () => release, validateSelection: async () => {}, cwd: async () => directory,
    adapter: async () => ({ name: "Neutral fixture", capabilities: { questions: true, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false, promptSuggestions: true },
      probe: async () => ({ available: true }), start(value) { options = value; return { send() {}, interrupt: async () => {},
        stop, stopAndWait: stop, resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => false }; } }) }, 1);
  cleanups.push(() => engine.close());
  const runId = randomUUID(), request: WorkerRunRequest = { conversationId: "conversation", operation: "chat", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "neutral.example" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "conversation" }, input: "Work", options: { promptSuggestions: suggestions }, autoAllowedPrefixes: [] };
  await engine.submit(runId, request); await vi.waitFor(() => expect(options).toBeDefined());
  const emit = (event: HarnessEvent) => options!.onEvent(event);
  emit({ type: "native_effect", id: "same", state: "started" });
  emit({ type: "tool_use", toolUseId: "same", toolName: "Bash", input: {} });
  emit({ type: "native_effect", id: "same", state: "started", source: child });
  emit({ type: "tool_use", toolUseId: "same", toolName: "Bash", input: {}, source: child });
  emit({ type: "agent_status", ...child, state: "running", stopConfirmed: false, source: child });
  await journal.exclusive(async () => {});
  return { engine, journal, runId, emit, release, stop };
}

it.each([false, true])("persists matched cleanup terminals before the terminal receipt (predictions: %s)", async suggestions => {
  const f = await fixture(suggestions);
  const atCompletion: Array<{ effects: unknown; outputs: number }> = [];
  const update = f.journal.update.bind(f.journal);
  vi.spyOn(f.journal, "update").mockImplementation(async (...args) => {
    if (args[1] === "completed") {
      const retained = await f.journal.load(f.runId);
      atCompletion.push({ effects: retained.receipt.effects, outputs: retained.events.filter(frame => frame.event.type === "tool_result").length });
    }
    return update(...args);
  });
  f.stop.mockImplementation(async () => {
    f.emit({ type: "native_effect", id: "same", state: "settled", source: { ...child, parentToolCallId: "foreign-parent" } });
    f.emit({ type: "agent_status", ...child, parentToolCallId: "foreign-parent", state: "failed", stopConfirmed: false, source: child });
    for (const source of [undefined, child]) {
      f.emit({ type: "native_effect", id: "same", state: "settled", ...(source ? { source } : {}) });
      f.emit({ type: "command_result", toolUseId: "same", status: "completed", exitCode: 0, ...(source ? { source } : {}) });
      f.emit({ type: "tool_result", toolUseId: "same", status: "completed", output: source ? "Child result" : "Root result", ...(source ? { source } : {}) });
      f.emit({ type: "tool_result", toolUseId: "same", status: "failed", output: "Conflicting duplicate", ...(source ? { source } : {}) });
    }
    f.emit({ type: "agent_status", ...child, state: "succeeded", stopConfirmed: false, source: child });
    f.emit({ type: "tool_use", toolUseId: "new", toolName: "Bash", input: {}, source: child });
    f.emit({ type: "native_effect", id: "new", state: "started", source: child });
    f.emit({ type: "native_effect", id: "new", state: "settled", source: child });
    f.emit({ type: "tool_result", toolUseId: "new", status: "completed", output: "Unregistered", source: child });
    f.emit({ type: "tool_result", toolUseId: "same", status: "completed", output: "Wrong child", source: { ...child, agentId: "foreign" } });
    f.emit({ type: "approval_request", approvalId: "late-permission", toolName: "Write", input: {}, source: child });
    f.emit({ type: "result", status: "failed" });
    f.emit({ type: "assistant_text", text: "Late new answer" });
  });
  f.emit({ type: "result", status: "success" });
  if (suggestions) {
    await vi.waitFor(async () => expect((await f.journal.load(f.runId)).receipt.state).toBe("suggesting"));
    f.emit({ type: "prompt_suggestion", text: "Next step" });
  }
  await vi.waitFor(async () => expect((await f.journal.load(f.runId)).receipt.state).toBe("completed"));
  await f.journal.exclusive(async () => {});
  const retained = await f.journal.load(f.runId), events = retained.events.map(frame => frame.event);
  expect(atCompletion).toEqual([{ effects: {}, outputs: 2 }]);
  expect(retained.receipt).toMatchObject({ state: "completed", exitConfirmed: true, effects: {}, pending: [], snapshot: { result: { type: "result", status: "success" } } });
  expect(events.filter(event => event.type === "tool_result")).toEqual([
    { type: "tool_result", toolUseId: "same", status: "completed", output: "Root result" },
    { type: "tool_result", toolUseId: "same", status: "completed", output: "Child result", source: child },
  ]);
  expect(events.filter(event => event.type === "command_result")).toHaveLength(2);
  expect(events.filter(event => event.type === "agent_status")).toMatchObject([{ ...child, state: "running" }, { ...child, state: "succeeded" }]);
  expect(events.filter(event => event.type === "native_effect" && event.state === "settled")).toEqual([
    { type: "native_effect", id: "same", state: "settled" }, { type: "native_effect", id: "same", state: "settled", source: child },
  ]);
  expect(events.some(event => event.type === "approval_request" || event.type === "assistant_text")).toBe(false);
  expect(events.filter(event => event.type === "tool_use")).toHaveLength(2);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  f.emit({ type: "native_effect", id: "same", state: "unknown", source: child });
  f.emit({ type: "tool_result", toolUseId: "same", status: "failed", output: "Too late", source: child });
  await f.journal.exclusive(async () => {});
  expect((await f.journal.load(f.runId)).events).toEqual(retained.events);
});

it("drains a terminal already queued behind the root result before native cleanup starts", async () => {
  const f = await fixture();
  f.emit({ type: "result", status: "success" });
  f.emit({ type: "native_effect", id: "same", state: "settled", source: child });
  f.emit({ type: "tool_result", toolUseId: "same", status: "completed", output: "Queued child terminal", source: child });
  await vi.waitFor(async () => expect((await f.journal.load(f.runId)).receipt.state).toBe("completed"));
  const retained = await f.journal.load(f.runId);
  expect(retained.receipt.effects).toEqual({ same: "started" });
  expect(retained.events.filter(frame => frame.event.type === "tool_result")).toMatchObject([{ event: { output: "Queued child terminal", source: child } }]);
});

it("preserves unresolved effects and capacity when native cleanup is unconfirmed", async () => {
  const f = await fixture(); f.stop.mockRejectedValue(new Error("Native exit unconfirmed"));
  f.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.journal.load(f.runId)).receipt.state).toBe("interrupted"));
  expect((await f.journal.load(f.runId)).receipt).toMatchObject({ exitConfirmed: false, effects: { same: "started", [nativeEventIdentity(child, "same")]: "started" } });
  expect(f.release).not.toHaveBeenCalled(); expect(f.engine.occupied).toBe(1);
  f.stop.mockResolvedValue();
});

it("fails closed when a cleanup callback has malformed source instead of settling a root effect", async () => {
  const f = await fixture();
  f.stop.mockImplementation(async () => {
    f.emit({ type: "native_effect", id: "same", state: "settled", source: { agentId: "" } });
  });
  f.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.journal.load(f.runId)).receipt.state).toBe("failed"));
  const retained = await f.journal.load(f.runId);
  expect(retained.receipt.effects).toEqual({ same: "started", [nativeEventIdentity(child, "same")]: "started" });
  expect(retained.events.some(frame => frame.event.type === "native_effect" && frame.event.state === "settled")).toBe(false);
});
