import { afterEach, expect, it, vi } from "vitest";
import { WorkerEngine } from "./engine.js";
import { WorkerJournal } from "./journal.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import type { WorkerRunRequest } from "./contracts.js";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
it.each(["confirmed", "unconfirmed", "pending", "unsupported"])("contains a sealed event write with %s native exit without terminating unrelated work", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-isolation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = fork(path.join(import.meta.dirname, "../../../test/worker-storage-isolation-child.mjs"), [root, mode], {
    execArgv: ["--unhandled-rejections=strict", "--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, HOSTY_CORE_ORIGIN: "", HOSTY_APP_SERVICE_TOKEN: "", HOSTY_APP_ID: "isolation-fixture", NODE_ENV: "test" },
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  });
  let stderr = "", result: unknown;
  child.stderr?.on("data", data => { stderr += data; }); child.on("message", value => { result = value; });
  const [code, signal] = await once(child, "exit");
  expect(code, stderr).toBe(0); expect(signal).toBeNull();
  expect(result).toMatchObject({ survived: true, healthy: "completed", damaged: "interrupted", faults: 1,
    sends: [["damaged", 1], ["healthy", 1]], releases: expect.arrayContaining(mode === "unsupported" ? [["healthy", 1]] : [["damaged", 1], ["healthy", 1]]) });
}, 15_000);

it("closes the old root and preserves only its already registered outcomes during detached drain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-deferred-output-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new WorkerJournal(directory);
  await journal.initialize();
  let finishDrain!: () => void;
  const drained = new Promise<void>(resolve => { finishDrain = resolve; });
  const launches: HarnessStartOptions[] = [];
  const adapter = { name: "draining", capabilities: {}, probe: async () => ({ available: true }), start: (options: HarnessStartOptions) => {
    launches.push(options);
    return { send() {}, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {},
      stopForCancellation: async () => ({ drained }) };
  } } as unknown as HarnessAdapter;
  const engine = new WorkerEngine(journal, { adapter: async () => adapter, cwd: async () => directory,
    validateSelection: async () => {}, reserve: async () => () => {} }, 1);
  cleanup.push(async () => { finishDrain(); await engine.close(); });
  const request: WorkerRunRequest = { conversationId: "chat", input: "Test", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "draining" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat" }, options: {}, autoAllowedPrefixes: [] };
  await engine.submit("old", request);
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  const emit = launches[0]!.onEvent, source = { agentId: "child", parentAgentId: "root", parentToolCallId: "delegate" };
  emit({ type: "tool_use", toolName: "Command", toolUseId: "known", input: {}, source });
  emit({ type: "native_effect", id: "known", state: "started", source });
  await vi.waitFor(async () => expect((await journal.load("old")).events).toHaveLength(2));
  expect(await engine.cancel("old", "stop")).toMatchObject({ state: "cancelled", exitConfirmed: true });
  expect(engine.occupied).toBe(0);
  await engine.submit("next", request);
  await vi.waitFor(() => expect(launches).toHaveLength(2));
  emit({ type: "native_effect", id: "known", state: "settled", source: { agentId: "" } });
  emit({ type: "tool_result", toolUseId: "known", status: "failed", output: "wrong source", source: { ...source, parentToolCallId: "other" } });
  emit({ type: "native_effect", id: "known", state: "settled", source });
  emit({ type: "tool_result", toolUseId: "known", status: "failed", output: "captured after root stop", source });
  emit({ type: "approval_request", approvalId: "late", toolName: "Command", input: {}, source });
  finishDrain();
  await vi.waitFor(async () => expect((await journal.load("old")).events).toHaveLength(4));
  const old = await journal.load("old");
  expect(old.receipt).toMatchObject({ state: "cancelled", exitConfirmed: true, effects: {} });
  expect(old.events.at(-1)?.event).toMatchObject({ output: "captured after root stop" });
  expect((await journal.load("next")).receipt.state).toBe("running");
  expect((await journal.load("next")).events).toEqual([]);
});
