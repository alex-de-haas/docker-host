import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { AuditReporter } from "../audit.js";
import type { ConnectionService } from "../connections/service.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
const catalog = (models: import("./compatibility.js").ModelChoice[]) => ({ revision: "fixture-model-catalog", models });

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); });

it("keeps model/effort revisions, rejects busy/stale/incompatible choices and preserves per-turn attribution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-models-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options: HarnessStartOptions[] = [];
  const adapter: HarnessAdapter = { name: "fixture", capabilities: { questions: true, autoAllow: true, appMcp: true, liveReconfigure: true, denyReason: true }, probe: async () => ({ available: true }), start: value => {
    options.push(value); return { send() {}, resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => true, interrupt: async () => {}, stop: async () => {} };
  } };
  const available = catalog([{ id: "model-a", label: "A", efforts: [{ id: "high", label: "High" }] }, { id: "model-b", label: "B", efforts: [{ id: "xhigh", label: "Extra high" }] }]);
  const connections = { binding: async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "codex" }),
    models: async () => available, reserve: async () => () => {}, adapter: async () => adapter } as unknown as ConnectionService;
  const store = new SessionStore(root, path.join(root, "cache"));
  const make = () => new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, null, null, null, null, null, null, connections);
  const manager = make(); cleanup.push(() => manager.shutdown());
  const record = await manager.createSession({ createdBy: "owner" });
  await manager.setModel(record.id, { expectedRevision: 0, selection: { model: "model-a", reasoningEffort: "high" } });
  await expect(manager.setModel(record.id, { expectedRevision: 0, selection: { model: null, reasoningEffort: null } })).rejects.toMatchObject({ code: "selection_conflict" });
  await expect(manager.setModel(record.id, { expectedRevision: 1, selection: { model: "model-b" } })).rejects.toMatchObject({ code: "effort_unavailable" });
  await expect(manager.postMessage(record.id, "stale draft", undefined, [], { selectionRevision: 0 })).rejects.toMatchObject({ code: "selection_conflict" });
  expect(options).toHaveLength(0);
  await manager.postMessage(record.id, "first", undefined, [], { selectionRevision: 1 });
  await expect(manager.setModel(record.id, { expectedRevision: 1, selection: { model: null, reasoningEffort: null } })).rejects.toThrow();
  expect(options[0]).toMatchObject({ model: "model-a", reasoningEffort: "high" });
  options[0]!.onEvent({ type: "harness_session", harnessSessionId: "native-context" });
  options[0]!.onEvent({ type: "result", status: "success" });
  await expect.poll(async () => (await store.readRecord(record.id))?.status).toBe("idle");
  await manager.setModel(record.id, { expectedRevision: 1, selection: { model: null, reasoningEffort: null } });
  const reopened = make(); cleanup.push(() => reopened.shutdown());
  expect(await reopened.getSession(record.id)).toMatchObject({ selectionRevision: 2, executionSelection: { model: null, reasoningEffort: null }, harnessSessionId: "native-context" });
  await reopened.postMessage(record.id, "second", undefined, [], { selectionRevision: 2 });
  expect(options[1]).toMatchObject({ model: null, reasoningEffort: null, resumeHarnessSessionId: "native-context" });
  expect((await store.readEvents(record.id)).filter(e => e.type === "user_message").map(e => e.executionSelection))
    .toEqual([{ model: "model-a", reasoningEffort: "high" }, { model: null, reasoningEffort: null }]);
});
