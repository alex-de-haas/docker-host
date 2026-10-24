import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type StoredEvent } from "./store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import type { HarnessEvent, HarnessRun, HarnessStartOptions } from "../harness/adapter.js";
import { AuditReporter } from "../audit.js";
import { catalog } from "../worker/models.js";

class ManualAdapter extends FakeHarnessAdapter {
  callbacks: Array<(event: HarnessEvent) => void> = [];
  starts: HarnessStartOptions[] = [];
  stopRun = vi.fn(async () => {});
  override start(options: HarnessStartOptions): HarnessRun {
    this.callbacks.push(options.onEvent); this.starts.push(options);
    return { send() {}, resolveApproval: () => true, resolveQuestion: () => true,
      setMcpServers: async () => true, interrupt: async () => {}, stop: this.stopRun, stopAndWait: this.stopRun };
  }
}
let dir: string, store: SessionStore, manager: SessionManager, adapter: ManualAdapter, id: string;
const usage = { usedTokens: 200, maxTokens: 1000, estimated: true, observedAt: "2026-10-22T12:00:00Z" };
const make = () => new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hosty-context-"));
  store = new SessionStore(dir, path.join(dir, "cache")); adapter = new ManualAdapter(); manager = make();
  id = (await manager.createSession({ createdBy: "admin" })).id;
  await manager.postMessage(id, "inspect");
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const contexts = async () => (await store.readEvents(id)).filter(event => event.type === "context_usage");

it("persists live observations, replays missed changes and restores the latest snapshot after reload", async () => {
  const seen: StoredEvent[] = [];
  const sub = await manager.subscribe(id, 0, event => seen.push(event));
  adapter.callbacks[0]!({ type: "context_usage", usage });
  await vi.waitFor(() => expect(seen.filter(event => event.type === "context_usage")).toHaveLength(1));
  const cursor = seen.find(event => event.type === "context_usage")!.seq;
  sub.unsubscribe();
  const compacted = { ...usage, usedTokens: 50 };
  adapter.callbacks[0]!({ type: "context_usage", usage: compacted });
  adapter.callbacks[0]!({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  const reconnect = await manager.subscribe(id, cursor, () => {});
  expect(reconnect.replay.filter(event => event.type === "context_usage")).toEqual([
    expect.objectContaining({ usage: compacted }),
  ]);
  reconnect.unsubscribe();
  await manager.shutdown(); manager = make();
  const reload = await manager.subscribe(id, 0, () => {});
  expect(reload.replay.filter(event => event.type === "context_usage").at(-1)).toMatchObject({ usage: compacted });
  reload.unsubscribe();
  await manager.setModel(id, { expectedRevision: 0, selection: { model: null, reasoningEffort: null } });
  expect((await contexts()).at(-1)).toMatchObject({ usage: compacted });
});

it("rejects late cancelled-run measurements and keeps other conversations isolated", async () => {
  const old = adapter.callbacks[0]!;
  await manager.cancelSession(id);
  await manager.postMessage(id, "next");
  old({ type: "context_usage", usage: { ...usage, usedTokens: 999 } });
  adapter.callbacks[1]!({ type: "context_usage", usage });
  const other = await manager.createSession({ createdBy: "admin" });
  await manager.postMessage(other.id, "separate");
  adapter.callbacks[2]!({ type: "context_usage", usage: { ...usage, usedTokens: 500 } });
  await vi.waitFor(async () => expect(await contexts()).toHaveLength(1));
  expect((await contexts())[0]).toMatchObject({ usage });
  await vi.waitFor(async () => expect((await store.readEvents(other.id)).filter(event => event.type === "context_usage")).toEqual([
    expect.objectContaining({ usage: { ...usage, usedTokens: 500 } }),
  ]));
});

const available = catalog(["model-a", "model-b"].map(id => ({ id, label: id,
  efforts: ["high", "ultra"].map(id => ({ id, label: id })) })), "model-a");
async function measuredSelection(model: string | null, reasoningEffort = "high") {
  adapter.callbacks[0]!({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  vi.spyOn(manager, "modelCatalog").mockResolvedValue(available);
  await manager.setModel(id, { expectedRevision: 0, selection: { model, reasoningEffort } });
  await manager.postMessage(id, "measure selected model", undefined, [], { selectionRevision: 1 });
  const callback = adapter.callbacks.at(-1)!;
  callback({ type: "harness_session", harnessSessionId: "same-native-thread" });
  callback({ type: "context_usage", usage });
  callback({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  return callback;
}

it.each([
  { model: null, effort: "ultra" },
  { model: "model-a", effort: "ultra" },
  { model: "model-a", effort: null },
  { model: "model-a", effort: "high" },
])("preserves the last observation through an effort/default/no-op save, replay and native resume: %j", async ({ model, effort }) => {
  await measuredSelection(model);
  const before = await contexts();
  const seen: StoredEvent[] = [];
  const sub = await manager.subscribe(id, before.at(-1)!.seq, event => seen.push(event));
  await manager.setModel(id, { expectedRevision: 1, selection: { model, reasoningEffort: effort } });
  expect(await contexts()).toEqual(before);
  expect(seen.filter(event => event.type === "context_usage")).toEqual([]);
  expect(seen).toContainEqual(expect.objectContaining({ type: "model_selection_changed", revision: 2 }));
  expect(await manager.getSession(id)).toMatchObject({ id, harnessSessionId: "same-native-thread",
    executionSelection: { model, reasoningEffort: effort }, selectionRevision: 2 });
  sub.unsubscribe();
  await manager.shutdown(); manager = make();
  const replay = await manager.subscribe(id, 0, () => {});
  expect(replay.replay.filter(event => event.type === "context_usage").at(-1)).toMatchObject({ usage });
  replay.unsubscribe();
  await manager.postMessage(id, "continue", undefined, [], { selectionRevision: 2 });
  expect(adapter.starts.at(-1)).toMatchObject({ resumeHarnessSessionId: "same-native-thread", model, reasoningEffort: effort });
  const fresh = { ...usage, usedTokens: 300, observedAt: "2026-10-22T12:01:00Z" };
  adapter.callbacks.at(-1)!({ type: "context_usage", usage: fresh });
  await vi.waitFor(async () => expect((await contexts()).at(-1)).toMatchObject({ usage: fresh }));
  adapter.callbacks.at(-1)!({ type: "context_usage", usage: null });
  await vi.waitFor(async () => expect((await contexts()).at(-1)).toMatchObject({ usage: null }));
});

it.each([["model-a", "model-b"], [null, "model-a"], ["model-a", null]])(
  "invalidates the observation when the model selection changes from %s to %s", async (model, nextModel) => {
    await measuredSelection(model);
    const cursor = (await contexts()).at(-1)!.seq;
    await manager.setModel(id, { expectedRevision: 1, selection: { model: nextModel, reasoningEffort: "high" } });
    const replay = await manager.subscribe(id, cursor, () => {});
    expect(replay.replay.filter(event => event.type === "context_usage")).toEqual([expect.objectContaining({ usage: null })]);
    replay.unsubscribe();
  },
);

it("ignores old-run context and identity callbacks queued during or after a successful settings teardown", async () => {
  const old = await measuredSelection("model-a");
  const before = await contexts();
  adapter.stopRun.mockImplementationOnce(async () => {
    old({ type: "context_usage", usage: null });
    old({ type: "harness_session", harnessSessionId: "late-unrelated-thread" });
  });
  await manager.setModel(id, { expectedRevision: 1, selection: { model: "model-a", reasoningEffort: "ultra" } });
  old({ type: "context_usage", usage: { ...usage, usedTokens: 999 } });
  old({ type: "harness_session", harnessSessionId: "another-late-thread" });
  // The serialized save also waits for the old callbacks queued ahead of it.
  await manager.setModel(id, { expectedRevision: 2, selection: { model: "model-a", reasoningEffort: "ultra" } });
  expect(await contexts()).toEqual(before);
  expect(await manager.getSession(id)).toMatchObject({ harnessSessionId: "same-native-thread" });
});

it("keeps the previous selection, observation and live callback authority when stopping fails", async () => {
  const old = await measuredSelection("model-a");
  const before = await contexts();
  adapter.stopRun.mockRejectedValueOnce(new Error("Exit could not be confirmed."));
  await expect(manager.setModel(id, { expectedRevision: 1, selection: { model: "model-a", reasoningEffort: "ultra" } })).rejects.toThrow("Exit could not be confirmed");
  expect(await contexts()).toEqual(before);
  expect(await manager.getSession(id)).toMatchObject({ harnessSessionId: "same-native-thread", selectionRevision: 1,
    executionSelection: { model: "model-a", reasoningEffort: "high" } });
  const fresh = { ...usage, usedTokens: 250 };
  old({ type: "context_usage", usage: fresh });
  await vi.waitFor(async () => expect((await contexts()).at(-1)).toMatchObject({ usage: fresh }));
});
