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
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hosty-command-results-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  adapter = new ManualAdapter();
  manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
  id = (await manager.createSession({ createdBy: "admin" })).id;
  await manager.postMessage(id, "run the checks");
});
afterEach(async () => { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
const results = async () => (await store.readEvents(id)).filter(event => event.type === "command_result");

it("persists and streams only bounded command metadata, then replays the same result after restart", async () => {
  const seen: StoredEvent[] = [];
  const sub = await manager.subscribe(id, 0, event => seen.push(event));
  adapter.emit({ type: "tool_use", toolUseId: "run-1:command-1", toolName: "Command", input: { command: "npm test" } });
  adapter.emit({ type: "command_result", toolUseId: "run-1:command-1", status: "completed", exitCode: 0,
    durationMs: 1200, summary: "14 passed", stdout: "credential=never-store", stderr: "never-store", content: "never-store" } as HarnessEvent);
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  const saved = (await results())[0]!;
  expect(Object.keys(saved).sort()).toEqual(["durationMs", "exitCode", "seq", "status", "summary", "toolUseId", "ts", "type"].sort());
  expect(saved).toMatchObject({ toolUseId: "run-1:command-1", status: "completed", exitCode: 0, durationMs: 1200, summary: "14 passed" });
  expect(seen.find(event => event.type === "command_result")).toEqual(saved);
  expect(JSON.stringify(await store.readEvents(id))).not.toContain("never-store");
  sub.unsubscribe();
  adapter.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  await manager.shutdown();
  manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
  const replay = await manager.subscribe(id, saved.seq - 1, () => {});
  expect(replay.replay.filter(event => event.type === "command_result")).toEqual([saved]);
  expect(adapter.callbacks).toHaveLength(1);
  replay.unsubscribe();
});

it("drops malformed identities and numbers and removes untrusted output and summary text", async () => {
  adapter.emit({ type: "command_result", toolUseId: "bad\nid", status: "completed", stdout: "secret" } as HarnessEvent);
  adapter.emit({ type: "command_result", toolUseId: "run-1:invalid", status: "unknown", exitCode: NaN, durationMs: Infinity } as HarnessEvent);
  adapter.emit({ type: "command_result", toolUseId: "run-1:unknown", status: "unknown",
    summary: "token=secret\n14 passed", stdout: "secret" } as HarnessEvent);
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  expect((await results())[0]).toMatchObject({ toolUseId: "run-1:unknown", status: "unknown" });
  expect(Object.keys((await results())[0]!).sort()).toEqual(["seq", "status", "toolUseId", "ts", "type"].sort());
  expect(JSON.stringify(await store.readEvents(id))).not.toContain("secret");
});

it("does not infer command success from a successful turn or accept a late result after it", async () => {
  adapter.emit({ type: "tool_use", toolUseId: "run-1:missing", toolName: "Command", input: { command: "check" } });
  adapter.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  adapter.emit({ type: "command_result", toolUseId: "run-1:missing", status: "completed", exitCode: 0 });
  await manager.shutdown();
  expect(await results()).toEqual([]);
  expect((await store.readEvents(id)).some(event => event.type === "tool_use" && event.toolUseId === "run-1:missing")).toBe(true);
});

it("retains the approval state while a separate command finishes", async () => {
  adapter.emit({ type: "approval_request", approvalId: "approval", toolName: "Write", input: {} });
  adapter.emit({ type: "command_result", toolUseId: "run-1:parallel", status: "failed", exitCode: 1 });
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  expect((await manager.getSession(id))?.status).toBe("awaiting_approval");
  expect(await manager.resolveApproval(id, "approval", "deny")).toBe(true);
});

it("ignores an old run's completion after cancellation and a fresh run", async () => {
  const old = adapter.callbacks[0]!;
  await manager.cancelSession(id);
  await manager.postMessage(id, "try a different check");
  old({ type: "command_result", toolUseId: "old:command", status: "completed", exitCode: 0 });
  adapter.emit({ type: "command_result", toolUseId: "new:command", status: "failed", exitCode: 2 });
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  expect((await results())[0]).toMatchObject({ toolUseId: "new:command", status: "failed", exitCode: 2 });
  expect((await manager.getSession(id))?.status).toBe("running");
});
