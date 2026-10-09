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
  emit(event: HarnessEvent) { this.callbacks.at(-1)!(event); }
}
let dir: string, store: SessionStore, manager: SessionManager, adapter: ManualAdapter, id: string;
const tool = { phase: "working", tool: { toolName: "Command" }, toolCount: 1 } as const;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hosty-activity-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  adapter = new ManualAdapter();
  manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
  id = (await manager.createSession({ createdBy: "admin" })).id;
  await manager.postMessage(id, "inspect");
});
afterEach(async () => { vi.restoreAllMocks(); await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
const snapshot = async () => {
  const cursor = (await manager.getSession(id))!.lastEventSeq;
  const subscription = await manager.subscribe(id, cursor, () => {});
  subscription.unsubscribe();
  return subscription.replay.find(e => e.type === "session_activity")!;
};

it("streams coalesced live state and restores it with a current cursor without persisting it", async () => {
  const seen: StoredEvent[] = [];
  const sub = await manager.subscribe(id, 0, e => seen.push(e));
  const cursor = (await manager.getSession(id))!.lastEventSeq;
  adapter.emit({ type: "activity", activity: tool });
  adapter.emit({ type: "activity", activity: tool });
  await vi.waitFor(() => expect(seen.filter(e => e.type === "session_activity")).toHaveLength(1));
  expect(await snapshot()).toMatchObject({ seq: -1, activity: tool, revision: 2 });
  expect((await manager.getSession(id))!.lastEventSeq).toBe(cursor);
  expect((await store.readEvents(id)).some(e => e.type === "activity" || e.type === "session_activity")).toBe(false);
  sub.unsubscribe();
});

it("finishes replay with the latest activity when an update arrives during the journal read", async () => {
  const read = store.readEvents.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(store, "readEvents").mockImplementationOnce(async (...args) => { await gate; return read(...args); });
  const pending = manager.subscribe(id, 0, () => {});
  adapter.emit({ type: "activity", activity: tool });
  await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ activity: tool }));
  release();
  const sub = await pending;
  expect(sub.replay.filter(e => e.type === "session_activity")).toEqual([expect.objectContaining({ activity: tool })]);
  sub.unsubscribe();
});

it.each(["result", "error", "cancel"])("clears activity on %s and rejects late events after a terminal state", async terminal => {
  adapter.emit({ type: "activity", activity: tool });
  await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ activity: tool }));
  if (terminal === "cancel") await manager.cancelSession(id);
  else adapter.emit(terminal === "result" ? { type: "result", status: "success" } : { type: "error", message: "process died" });
  await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ activity: null }));
  adapter.emit({ type: "activity", activity: tool });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await snapshot()).toMatchObject({ activity: null });
});

it("ignores callbacks from a cancelled run after a new run starts", async () => {
  const old = adapter.callbacks[0]!;
  await manager.cancelSession(id);
  await manager.postMessage(id, "next");
  old({ type: "activity", activity: tool });
  old({ type: "result", status: "success" });
  adapter.emit({ type: "activity", activity: { phase: "thinking", tool: null, toolCount: 0 } });
  await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ activity: { phase: "thinking", tool: null } }));
  expect((await manager.getSession(id))?.status).toBe("running");
});

it("retains current activity behind an approval wait and clears it on the next turn", async () => {
  adapter.emit({ type: "activity", activity: tool });
  adapter.emit({ type: "approval_request", approvalId: "a", toolName: "Command", input: {} });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("awaiting_approval"));
  expect(await snapshot()).toMatchObject({ activity: tool });
  adapter.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  await manager.postMessage(id, "next");
  expect(await snapshot()).toMatchObject({ activity: { phase: "working", tool: null, toolCount: 0 } });
});
