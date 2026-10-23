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
  dir = mkdtempSync(path.join(os.tmpdir(), "hosty-tool-results-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  adapter = new ManualAdapter();
  manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
  id = (await manager.createSession({ createdBy: "admin" })).id;
  await manager.postMessage(id, "run the checks");
});
afterEach(async () => { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });
const results = async () => (await store.readEvents(id)).filter(event => event.type === "tool_result");
const call = (toolUseId = "run:tool:1", toolName = "mcp__hosty-core__list_apps") => adapter.emit({ type: "tool_use", toolUseId, toolName, input: {} });

it("persists bounded output, streams it and restores the same recorded result without running a tool", async () => {
  const seen: StoredEvent[] = [];
  const sub = await manager.subscribe(id, 0, event => seen.push(event));
  call();
  adapter.emit({ type: "tool_result", toolUseId: "run:tool:1", status: "completed", output: "a".repeat(40_000), _meta: { token: "not-presentation" }, headers: "not-presentation" } as HarnessEvent);
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  const saved = (await results())[0]!;
  expect(saved.output).toHaveLength(32_768); expect(saved.truncated).toBe(true);
  expect(Object.keys(saved).sort()).toEqual(["seq", "ts", "type", "toolUseId", "status", "output", "truncated"].sort());
  expect(seen.find(event => event.type === "tool_result")).toEqual(saved);
  sub.unsubscribe(); adapter.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  await manager.shutdown();
  manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir);
  const replay = await manager.subscribe(id, saved.seq - 1, () => {});
  expect(replay.replay.filter(event => event.type === "tool_result")).toEqual([saved]);
  expect(adapter.callbacks).toHaveLength(1); replay.unsubscribe();
});

it("keeps parallel call identities and approval state while retaining an empty or failed result", async () => {
  call("first"); call("second");
  adapter.emit({ type: "approval_request", approvalId: "approval", toolName: "Write", input: {} });
  adapter.emit({ type: "tool_result", toolUseId: "second", status: "failed", output: "Permission refused" });
  adapter.emit({ type: "tool_result", toolUseId: "first", status: "completed", output: "" });
  await vi.waitFor(async () => expect(await results()).toHaveLength(2));
  expect((await results()).map(event => [event.toolUseId, event.status, event.output])).toEqual([["second", "failed", "Permission refused"], ["first", "completed", ""]]);
  expect((await manager.getSession(id))?.status).toBe("awaiting_approval");
});

it("drops malformed, unmatched, ambiguous and hidden infrastructure outputs before persistence", async () => {
  call("setup", "mcp__hosty-workspaces__environment_setup"); call("hidden", "ToolSearch");
  call("same"); call("same");
  for (const toolUseId of ["setup", "hidden", "same", "unmatched", "bad\nid"]) adapter.emit({ type: "tool_result", toolUseId, status: "completed", output: "never-store" });
  call("invalid"); adapter.emit({ type: "tool_result", toolUseId: "invalid", status: "invented", output: "never-store" } as unknown as HarnessEvent);
  call("valid"); adapter.emit({ type: "tool_result", toolUseId: "valid", status: "completed", output: "retained" });
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  expect(JSON.stringify(await store.readEvents(id))).not.toContain("never-store");
});

it("ignores a late output after a terminal turn and an old run after cancellation", async () => {
  call("old"); adapter.emit({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
  adapter.emit({ type: "tool_result", toolUseId: "old", status: "completed", output: "late" });
  await manager.postMessage(id, "next turn"); call("next");
  adapter.emit({ type: "tool_result", toolUseId: "old", status: "completed", output: "late" });
  const old = adapter.callbacks[0]!;
  await manager.cancelSession(id); await manager.postMessage(id, "new run");
  old({ type: "tool_result", toolUseId: "next", status: "completed", output: "late" });
  call("fresh"); adapter.emit({ type: "tool_result", toolUseId: "fresh", status: "completed", output: "current" });
  await vi.waitFor(async () => expect(await results()).toHaveLength(1));
  expect((await results())[0]).toMatchObject({ toolUseId: "fresh", output: "current" });
});


it("recovers a durably appended call after its record write failed before caching the identity", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const save = vi.spyOn(store, "saveRecord").mockRejectedValueOnce(new Error("interrupted record write"));
  try {
    call("recoverable");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect((await store.readEvents(id)).some(event => event.type === "tool_use" && event.toolUseId === "recoverable")).toBe(true);
    adapter.emit({ type: "tool_result", toolUseId: "recoverable", status: "completed", output: "retained after recovery" });
    await vi.waitFor(async () => expect(await results()).toHaveLength(1));
    expect((await results())[0]).toMatchObject({ toolUseId: "recoverable", output: "retained after recovery" });
  } finally { save.mockRestore(); warn.mockRestore(); }
});
