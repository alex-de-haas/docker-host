import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { AuditReporter } from "../audit.js";
import { ProviderDirectory } from "../settings/providers.js";
import { resolveAppSession } from "../app-session.js";
import { MAX_CONTEXT_BYTES, withAppContext, type AppContextSnapshot } from "./app-context.js";
import type { ContextAction } from "./app-context-tools.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";

vi.mock("../app-session.js", () => ({ resolveAppSession: vi.fn() }));
let dir: string, store: SessionStore, manager: SessionManager, directory: ProviderDirectory;
let entries: Array<Record<string, unknown>> | null, starts: HarnessStartOptions[], sent: string[];
const adapter: HarnessAdapter = {
  name: "recording", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => { starts.push(options); return { send: text => sent.push(text), stop: async () => {},
    interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false }; },
};
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "harness"), dir, null, directory);
const invoke = (id: string, action: ContextAction, input = {}) => manager.workspaceAction(id, action, input, "hostyg_test", "admin") as Promise<Record<string, any>>;
const mutate = (appIds: string[], expectedRevision = 0) => ({ appIds, expectedRevision, requestId: randomUUID() });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-agent-context-")); store = new SessionStore(dir);
  entries = [{ id: "notes", displayName: "Notes", runtimeState: "stopped" }, { id: "media", displayName: "Media" }];
  directory = new ProviderDirectory(null, null, "harness");
  vi.spyOn(directory, "readApps").mockImplementation(async () => entries);
  vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "admin", hostRole: "host.admin" } });
  starts = []; sent = []; manager = build();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

it("manages context in an active turn without rewriting accepted snapshots, cwd or tools", async () => {
  const session = await manager.createSession({ createdBy: "admin" });
  await manager.postMessage(session.id, "Inspect apps", "hostyg_test");
  const original = (await store.readEvents(session.id)).find(event => event.type === "user_message");
  const options = starts[0]!;
  const result = await manager.workspaceAction(session.id, "context-add", mutate(["notes"]), "hostyg_test") as any;
  expect(result.current.snapshot.apps[0]).toMatchObject({ id: "notes", runtimeState: "stopped" });
  expect(result.outcome).toEqual({ appIds: ["notes"], revision: 1, changed: true });
  expect(sent).toEqual(["Inspect apps"]);
  expect(starts).toEqual([options]);
  expect((await store.readEvents(session.id)).find(event => event.type === "user_message")).toEqual(original);
  expect((await store.readEvents(session.id)).find(event => event.type === "app_context_changed")).toMatchObject({ origin: "agent", actor: "admin" });
  starts[0]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(session.id))?.status).toBe("idle"));
  await manager.postMessage(session.id, "Next turn", "hostyg_test", [], { expectedRevision: 1 });
  expect(sent.at(-1)).toContain('"id":"notes"');
});

it("replays the recorded outcome after restart and a later human removal without restoring it", async () => {
  const session = await manager.createSession({ createdBy: "admin" }), input = mutate(["notes", "notes"]);
  const first = await invoke(session.id, "context-add", input);
  await manager.setAppContext(session.id, [], 1, "admin");
  await manager.shutdown(); manager = build();
  const replay = await invoke(session.id, "context-add", input);
  expect(replay).toMatchObject({ replayed: true, outcome: first.outcome, current: { appIds: [], revision: 2 } });
  expect((await store.readEvents(session.id)).filter(event => event.contextRequestId === input.requestId)).toHaveLength(1);
  await expect(invoke(session.id, "context-add", { ...input, appIds: ["notes"] })).rejects.toMatchObject({ code: "app_context_request_conflict" });
});

it("serializes concurrent changes and keeps no-op revision stable", async () => {
  const session = await manager.createSession({ createdBy: "admin" });
  const results = await Promise.allSettled([invoke(session.id, "context-add", mutate(["notes"])), invoke(session.id, "context-add", mutate(["media"]))]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "app_context_conflict", details: { revision: 1, appIds: ["notes"] } });
  expect((await invoke(session.id, "context-add", mutate(["notes"], 1))).outcome).toMatchObject({ changed: false, revision: 1 });
  expect((await invoke(session.id, "context-remove", mutate(["missing"], 1))).outcome).toMatchObject({ changed: false, revision: 1 });
  expect((await invoke(session.id, "context-add", mutate(["media"], 1))).current.appIds).toEqual(["notes", "media"]);
});

it("rejects additions atomically on overflow or unavailable identities and removes during directory outage", async () => {
  entries = Array.from({ length: 17 }, (_, i) => ({ id: "app-" + i }));
  const ids = entries.slice(0, 16).map(entry => String(entry.id));
  const session = await manager.createSession({ createdBy: "admin", appIds: ids });
  await expect(invoke(session.id, "context-add", mutate(["app-16"]))).rejects.toMatchObject({ code: "app_ids_invalid" });
  await expect(invoke(session.id, "context-add", mutate(["missing"]))).rejects.toMatchObject({ code: "app_ids_invalid" });
  expect((await manager.getSession(session.id))?.appIds).toEqual(ids);
  entries = null;
  const removed = await invoke(session.id, "context-remove", mutate(["app-0"]));
  expect(removed.current.appIds).toEqual(ids.slice(1));
  expect(removed.current.snapshot.resolution).toBe("unavailable");
  await expect(invoke(session.id, "context-add", mutate(["app-16"], 1))).rejects.toMatchObject({ code: "app_context_unavailable" });
  entries = [];
  await expect(invoke(session.id, "context-add", mutate(["missing"], 1))).rejects.toMatchObject({ code: "app_not_available" });
});

it("bounds search metadata and pagination independently of selected apps and provider enablement", async () => {
  entries = Array.from({ length: 40 }, (_, i) => ({ id: "app-" + i, displayName: "App " + i, description: "data".repeat(500),
    runtimeState: "stopped", interfaces: Array.from({ length: 8 }, () => ({ name: "x".repeat(80), key: "a", url: "x".repeat(510) })) }));
  const session = await manager.createSession({ createdBy: "admin" });
  const page = await invoke(session.id, "context-search", { search: "app-", offset: 0 });
  expect(page.apps).toHaveLength(16); expect(page.nextOffset).toBe(16);
  expect(Buffer.byteLength(withAppContext("", page as AppContextSnapshot))).toBeLessThan(MAX_CONTEXT_BYTES);
  expect((await invoke(session.id, "context-list")).appIds).toEqual([]);
  expect((await invoke(session.id, "context-search", { offset: 32 })).apps).toHaveLength(8);
});

it.each(["wrong-user", "non-admin", "revoked", "changed-before-write", "disabled-before-write"])("revalidates %s before persisting local metadata", async failure => {
  const session = await manager.createSession({ createdBy: "admin" });
  const allowed = { status: "active" as const, identity: { userId: "admin", hostRole: "host.admin" } };
  if (failure === "wrong-user") vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "other", hostRole: "host.admin" } });
  if (failure === "non-admin") vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "admin", hostRole: "host.user" } });
  if (failure === "revoked") vi.mocked(resolveAppSession).mockResolvedValue({ status: "forbidden" });
  if (failure === "changed-before-write") vi.mocked(resolveAppSession).mockResolvedValueOnce(allowed).mockResolvedValueOnce({ status: "forbidden" });
  const guard = vi.fn(async () => {});
  if (failure === "disabled-before-write") guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Tool disabled"));
  await expect(manager.workspaceAction(session.id, "context-add", mutate(["notes"]), "hostyg_test", "admin", guard)).rejects.toThrow();
  expect((await store.readRecord(session.id))?.appIds).toEqual([]);
});

it.each(["sessionId", "userId", "url"])("rejects model-supplied %s instead of changing context scope", async key => {
  const session = await manager.createSession({ createdBy: "admin" });
  await expect(invoke(session.id, "context-add", { ...mutate(["notes"]), [key]: "other" })).rejects.toMatchObject({ code: "app_context_input_invalid" });
});

it.each(["before-event", "after-event", "after-record"])("recovers %s failure with exactly one mutation and transcript event", async failure => {
  const session = await manager.createSession({ createdBy: "admin" }), input = mutate(["notes"]);
  const append = store.appendEvent.bind(store), save = store.saveRecord.bind(store);
  if (failure === "before-event") vi.spyOn(store, "appendEvent").mockRejectedValueOnce(new Error("event unavailable"));
  if (failure === "after-event") vi.spyOn(store, "appendEvent").mockImplementationOnce(async (id, event) => { await append(id, event); throw new Error("lost event acknowledgement"); });
  if (failure === "after-record") vi.spyOn(store, "saveRecord").mockImplementationOnce(async record => { await save(record); throw new Error("lost record acknowledgement"); });
  await expect(invoke(session.id, "context-add", input)).rejects.toThrow();
  vi.restoreAllMocks();
  vi.spyOn(directory, "readApps").mockImplementation(async () => entries);
  await manager.shutdown(); manager = build();
  const replay = await invoke(session.id, "context-add", input);
  expect(replay).toMatchObject({ replayed: true, outcome: { revision: 1 }, current: { appIds: ["notes"], revision: 1 } });
  const events = (await manager.subscribe(session.id, 0, () => {})).replay.filter(event => event.type === "app_context_changed");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ contextRequestId: input.requestId, origin: "operator" });
  expect((await store.readRecord(session.id))?.appContextEvent).toBeUndefined();
});
