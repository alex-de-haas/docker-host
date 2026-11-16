import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { WorkerEngine } from "@hosty/agent-provider-runtime/worker/engine";
import { WorkerJournal } from "@hosty/agent-provider-runtime/worker/journal";
import type { WorkerRunRequest } from "@hosty/agent-provider-runtime/worker/contracts";
import { CodexHarnessAdapter } from "./codex.js";
import type { HarnessAdapter, HarnessEvent, HarnessStartOptions } from "@hosty/agent-provider-runtime/harness/adapter";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
  delete process.env.HOSTY_HARNESS_CODEX_COMMAND; delete process.env.HOSTY_TEST_CODEX_DENIAL_MODE;
});
const request = (input = "Hello"): WorkerRunRequest => {
  const id = randomUUID(); return { conversationId: id,
    binding: { connectionId: randomUUID(), connectionRevision: 1, harnessKind: "codex" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id }, input, options: {}, autoAllowedPrefixes: [] };
};
async function fixture(adapter?: HarnessAdapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-healthy-close-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new WorkerJournal(directory); await journal.initialize();
  let options!: HarnessStartOptions;
  const stop = vi.fn(async () => {});
  adapter ??= { name: "isolated-fixture", capabilities: {}, probe: async () => ({ available: true }), start: (value: HarnessStartOptions) => {
    options = value; return { send() {}, stop, stopAndWait: stop };
  } } as unknown as HarnessAdapter;
  const engine = new WorkerEngine(journal, { adapter: async () => adapter!, cwd: async () => directory, validateSelection: async () => {}, reserve: async () => () => {} }, 1);
  cleanup.push(() => engine.close());
  const id = randomUUID();
  return { directory, journal, engine, id, stop, emit: (event: HarnessEvent) => options.onEvent(event) };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, input?: string) {
  await f.engine.submit(f.id, request(input));
  await vi.waitFor(async () => expect(["running", "awaiting_input"]).toContain((await f.journal.load(f.id)).receipt.state));
}
async function proposed(f: Awaited<ReturnType<typeof fixture>>) {
  f.emit({ type: "native_effect", id: "known-call", state: "started" });
  await vi.waitFor(async () => expect((await f.journal.load(f.id)).receipt.effects?.["known-call"]).toBe("started"));
}

it("persists only exact pre-existing settlements during ordinary healthy close", async () => {
  const f = await fixture(); await start(f); await proposed(f);
  f.stop.mockImplementation(async () => {
    f.emit({ type: "native_effect", id: "new-call", state: "started" });
    f.emit({ type: "native_effect", id: "new-call", state: "settled" });
    f.emit({ type: "native_effect", id: "known-call", state: "settled", source: { agentId: "foreign-child", parentAgentId: "root" } });
    f.emit({ type: "tool_use", toolUseId: "late-tool", toolName: "Tool", input: {} });
    f.emit({ type: "approval_request", approvalId: "late-approval", toolName: "Tool", input: {} });
    f.emit({ type: "assistant_text", text: "late output" }); f.emit({ type: "result", status: "success" });
    f.emit({ type: "native_effect", id: "known-call", state: "settled" });
    f.emit({ type: "native_effect", id: "known-call", state: "settled" });
  });
  await f.engine.close();
  const record = await f.journal.load(f.id);
  expect(record.receipt.effects).toEqual({}); expect(record.receipt.state).toBe("failed");
  expect(record.events.map(frame => frame.event)).toEqual([
    { type: "native_effect", id: "known-call", state: "started" }, { type: "native_effect", id: "known-call", state: "settled" },
  ]);
  expect(record.receipt.snapshot?.result).toBeUndefined();
});

it("does not admit settlement through a storage-failure quarantine", async () => {
  const f = await fixture(); await start(f); await proposed(f);
  f.stop.mockImplementation(async () => { f.emit({ type: "native_effect", id: "known-call", state: "settled" }); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const append = f.journal.append.bind(f.journal);
  vi.spyOn(f.journal, "append").mockImplementation(async (id, event) => {
    if (event.type === "assistant_text") throw new Error("synthetic persistence failure");
    return append(id, event);
  });
  f.emit({ type: "assistant_text", text: "cannot persist" });
  await vi.waitFor(async () => expect((await f.journal.load(f.id)).receipt.state).toBe("failed"));
  await f.engine.close();
  expect((await f.journal.load(f.id)).receipt.effects).toEqual({ "known-call": "started" });
  expect((await f.journal.load(f.id)).events.some(frame => frame.event.type === "native_effect" && frame.event.state === "settled")).toBe(false);
});

it("keeps usage-storage-failure shutdown fully closed to native callbacks", async () => {
  const f = await fixture(); await start(f); await proposed(f);
  f.stop.mockImplementation(async () => { f.emit({ type: "native_effect", id: "known-call", state: "settled" }); });
  await f.engine.close("Usage persistence failed", false);
  expect((await f.journal.load(f.id)).receipt.effects).toEqual({ "known-call": "started" });
});

it("drains the real Codex pending-approval terminal into its durable journal on healthy shutdown", async () => {
  process.env.HOSTY_HARNESS_CODEX_COMMAND = path.join(import.meta.dirname, "../../test/fake-codex-server.mjs");
  process.env.HOSTY_TEST_CODEX_DENIAL_MODE = "delayed";
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-real-codex-close-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const adapter = new CodexHarnessAdapter({ dataDir: directory, isolated: true });
  // This unit owns no account. Exercise the actual CLI protocol without its separate login probe.
  vi.spyOn(adapter, "probe").mockResolvedValue({ available: true });
  const f = await fixture(adapter);
  await start(f, "write");
  await vi.waitFor(async () => expect((await f.journal.load(f.id)).receipt.pending?.some(frame => frame.event.type === "approval_request")).toBe(true));
  const before = await f.journal.load(f.id), effect = Object.keys(before.receipt.effects ?? {});
  expect(effect).toHaveLength(1);
  await f.engine.close();
  const stopped = await f.journal.load(f.id);
  expect(stopped.receipt.effects).toEqual({});
  expect(stopped.events).toContainEqual(expect.objectContaining({ event: { type: "native_effect", id: effect[0], state: "settled" } }));
  expect(stopped.events.some(frame => frame.event.type === "tool_use" && frame.event.toolName === "FileChange")).toBe(false);
  expect(stopped.receipt.state).toBe("failed"); expect(stopped.receipt.exitConfirmed).toBe(true);
});


it("revokes healthy-close settlement when the actual in-flight usage timer fails after close begins", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = await fixture(); await start(f); await proposed(f);
  let sampled!: () => void, rejectSample!: (error: Error) => void;
  const sampleEntered = new Promise<void>(resolve => { sampled = resolve; });
  const failedSample = new Promise<never>((_resolve, reject) => { rejectSample = reject; });
  vi.spyOn(f.journal, "sample").mockImplementation(async () => { sampled(); return failedSample; });
  await vi.advanceTimersByTimeAsync(1000); await sampleEntered;
  f.stop.mockImplementation(async () => { f.emit({ type: "native_effect", id: "known-call", state: "settled" }); });
  const closing = f.engine.close();
  try {
    expect(f.engine.available).toBe(false);
    // The real timer callback still owns journal.exclusive. Its failure must
    // revoke ordinary-close permission before the ordered effect capture runs.
    rejectSample(new Error("synthetic in-flight usage persistence failure"));
    await closing;
    const record = await f.journal.load(f.id);
    expect(record.receipt.effects).toEqual({ "known-call": "started" });
    expect(record.events.some(frame => frame.event.type === "native_effect" && frame.event.state === "settled")).toBe(false);
    expect(f.stop).toHaveBeenCalledTimes(1);
  } finally { rejectSample(new Error("fixture cleanup")); await closing; }
});


it("retains pre-close queued effect uncertainty while rejecting starts admitted after close", async () => {
  const f = await fixture(); await start(f);
  let entered!: () => void, release!: () => void, stopEntered!: () => void, releaseStop!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  const stopping = new Promise<void>(resolve => { stopEntered = resolve; });
  const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
  f.stop.mockImplementation(async () => { stopEntered(); await stopped; });
  const blocker = f.journal.exclusive(async () => { entered(); await unlock; });
  await locked;
  f.emit({ type: "native_effect", id: "pre-close-call", state: "started" });
  const closing = f.engine.close();
  f.emit({ type: "native_effect", id: "new-after-close", state: "started" });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    release(); await blocker; await stopping; releaseStop(); await closing;
    expect((await f.journal.load(f.id)).receipt.effects).toEqual({ "pre-close-call": "started" });
  } finally { release(); releaseStop(); await closing; }
});
