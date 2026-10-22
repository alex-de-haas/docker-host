import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type StoredEvent } from "./store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import type { HarnessEvent, HarnessRun, HarnessStartOptions } from "../harness/adapter.js";
import { AuditReporter } from "../audit.js";

class ManualAdapter extends FakeHarnessAdapter {
  callbacks: Array<(event: HarnessEvent) => void> = [];
  override start(options: HarnessStartOptions): HarnessRun {
    this.callbacks.push(options.onEvent);
    return { send() {}, resolveApproval: () => true, resolveQuestion: () => true,
      setMcpServers: async () => true, interrupt: async () => {}, stop: async () => {} };
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
afterEach(async () => { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
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
  expect((await contexts()).at(-1)).toMatchObject({ usage: null });
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
