import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
let dir: string, store: SessionStore, manager: SessionManager;
let starts: HarnessStartOptions[];
const stop = vi.fn(async () => {});
const adapter: HarnessAdapter = {
  name: "recording", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => { starts.push(options); return { send: () => {}, stop, interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false }; },
};
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "harness"), dir);
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "hosty-autonomy-")); store = new SessionStore(dir); starts = []; stop.mockClear(); manager = build(); });
afterEach(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); });
it("defaults to Normal, persists operator choice and resumes history with a downgraded native policy", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  await manager.postMessage(record.id, "inspect");
  expect(starts[0]?.autonomy).toBe("normal");
  starts[0]!.onEvent({ type: "harness_session", harnessSessionId: "native-history" });
  starts[0]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
  await manager.setAutonomy(record.id, "autonomous", "admin");
  expect(stop).toHaveBeenCalledOnce();
  await manager.shutdown(); manager = build();
  expect((await manager.getSession(record.id))?.autonomy).toBe("autonomous");
  await manager.postMessage(record.id, "work");
  expect(starts[1]).toMatchObject({ autonomy: "autonomous", resumeHarnessSessionId: "native-history" });
  await expect(manager.setAutonomy(record.id, "normal", "admin")).rejects.toThrow();
  expect((await manager.getSession(record.id))?.autonomy).toBe("autonomous");
  await manager.cancelSession(record.id);
  await manager.setAutonomy(record.id, "normal", "admin");
  await manager.postMessage(record.id, "inspect again");
  expect(starts[2]).toMatchObject({ autonomy: "normal", resumeHarnessSessionId: "native-history" });
});
it("rejects another owner, unknown modes and a pending handoff", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  await expect(manager.setAutonomy(record.id, "autonomous", "other")).rejects.toMatchObject({ status: 403 });
  await expect(manager.setAutonomy(record.id, "anything", "admin")).rejects.toMatchObject({ status: 400 });
  record.handoffPending = true; await store.saveRecord(record);
  await manager.shutdown(); manager = build();
  await expect(manager.setAutonomy(record.id, "autonomous", "admin")).rejects.toThrow();
  expect((await store.readRecord(record.id))?.autonomy).toBeUndefined();
});
