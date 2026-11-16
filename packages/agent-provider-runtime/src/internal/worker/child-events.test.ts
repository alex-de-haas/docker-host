import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { WorkerEngine } from "./engine.js";
import { WorkerJournal } from "./journal.js";
import type { WorkerRunRequest } from "./contracts.js";
import { nativeEventIdentity, readHarnessEventSource, type HarnessEvent, type HarnessAdapter, type HarnessStartOptions } from "../harness/adapter.js";

const paths: string[] = [];
const engines: WorkerEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); await Promise.all(paths.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
const request = (): WorkerRunRequest => { const id = randomUUID(); return { conversationId: id, binding: { connectionId: randomUUID(), connectionRevision: 1, harnessKind: "claude" }, selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id }, input: "Hello", options: {}, autoAllowedPrefixes: [] }; };
const source = { agentId: "child-native-id", parentAgentId: "root" };
describe("native child event authority", () => {
  it("does not complete or release the root execution for a child's result or error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-child-events-")); paths.push(directory);
    const journal = new WorkerJournal(directory); await journal.initialize(); let options: HarnessStartOptions | undefined;
    const release = vi.fn(), stop = vi.fn(async () => {});
    const adapter = { capabilities: {}, probe: async () => ({ available: true }), start: (value: HarnessStartOptions) => { options = value; return { send() {}, stop, stopAndWait: stop }; } } as unknown as HarnessAdapter;
    const engine = new WorkerEngine(journal, { adapter: async () => adapter, cwd: async () => directory, validateSelection: async () => {}, reserve: async () => release }, 1); engines.push(engine);
    const id = randomUUID(); await engine.submit(id, request()); await vi.waitFor(() => expect(options).toBeDefined());
    options!.onEvent({ type: "assistant_text", text: "Child answer", source });
    options!.onEvent({ type: "result", status: "success", source }); options!.onEvent({ type: "error", message: "Child later failed", source });
    await vi.waitFor(async () => expect((await journal.load(id)).events).toHaveLength(3));
    expect((await journal.load(id)).receipt).toMatchObject({ state: "running" });
    expect((await journal.load(id)).receipt.snapshot?.text).toBeUndefined(); expect((await journal.load(id)).receipt.snapshot?.result).toBeUndefined();
    expect(engine.occupied).toBe(1); expect(stop).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    options!.onEvent({ type: "assistant_text", text: "Root answer" }); options!.onEvent({ type: "result", status: "success" });
    await vi.waitFor(async () => expect((await journal.load(id)).receipt.state).toBe("completed"));
    expect((await journal.load(id)).receipt.snapshot?.text).toBe("Root answer"); expect(release).toHaveBeenCalledTimes(1);
  });
  it("retains child tool provenance after normalization and separates reused native effect IDs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-child-journal-")); paths.push(directory);
    const journal = new WorkerJournal(directory); await journal.initialize(); const id = randomUUID(); await journal.accept(id, request());
    const append = (event: HarnessEvent) => journal.append(id, event);
    await append({ type: "native_effect", id: "reused", state: "started" }); await append({ type: "native_effect", id: "reused", state: "started", source });
    await append({ type: "native_effect", id: "reused", state: "settled", source });
    await append({ type: "tool_result", toolUseId: "reused", status: "completed", output: "Child output", source });
    const retained = await journal.load(id); expect(retained.receipt.effects).toEqual({ reused: "started" });
    expect(retained.events.at(-1)?.event.source).toEqual(source);
    expect(nativeEventIdentity(source, "reused")).not.toBe(nativeEventIdentity(undefined, "reused"));
    expect(() => readHarnessEventSource({ agentId: "" })).toThrow(); expect(() => readHarnessEventSource({ agentId: "child", parentToolCallId: "tool" })).toThrow();
  });
});
