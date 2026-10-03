import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createAssistantRequestId } from "@hosty-sdk/app/assistant";
import { HandoffStore } from "./store.js";
import { SessionStore } from "../sessions/store.js";
import { SessionManager } from "../sessions/manager.js";
import { SettingsStore } from "../settings/store.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";

const DAY = 86_400_000;
describe("durable assistant handoffs", () => {
  let root: string, now: number, manager: SessionManager, store: SessionStore, settings: SettingsStore, handoffs: HandoffStore;
  const makeManager = () => new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), root, settings);
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-handoffs-")); now = Date.now();
    store = new SessionStore(root, path.join(root, "cache")); settings = new SettingsStore(root);
    manager = makeManager(); handoffs = new HandoffStore(manager, settings, null, () => now);
  });
  afterEach(async () => { vi.restoreAllMocks(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const input = () => ({ requestId: createAssistantRequestId(now), prompt: "Please inspect this", appIds: [] });
  it.each(["consumer:installation", undefined])("restricts immediate handoffs to operator clients (%s)", async consumer => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input(), consumer);
    const result = await handoffs.finalize("alice", value.handoffId, [], undefined, consumer);
    expect(result.result?.disposition).toBe(consumer ? "draft" : "accepted");
    if (consumer) {
      expect(result.result?.dispatchId).toBeUndefined();
      expect((await store.readRecord(value.conversationId))?.handoffDispatch).toBeUndefined();
    } else {
      expect(result.result?.dispatchId).toBeTruthy();
      await vi.waitFor(async () => expect((await store.readRecord(value.conversationId))?.handoffDispatch).toBeDefined());
    }
  });
  it("isolates app-attributed handoffs from other consumers and reinstallations", async () => {
    const request = input();
    const { value } = await handoffs.prepare("alice", request, "app-one:installation-one");
    for (const consumer of [undefined, "app-two:installation-one", "app-one:installation-two"]) {
      await expect(handoffs.status("alice", value.handoffId, consumer)).rejects.toMatchObject({ status: 404 });
      await expect(handoffs.cancel("alice", value.handoffId, consumer)).rejects.toMatchObject({ status: 404 });
    }
    const own = await handoffs.prepare("alice", request, "app-one:installation-one");
    expect(own.value.handoffId).toBe(value.handoffId);
    const other = await handoffs.prepare("alice", request, "app-two:installation-one");
    expect(other.value.handoffId).not.toBe(value.handoffId);
  });
  it.each(["cancelled", "expired"])("reports 410 for a %s finalize retry with the original attachment IDs", async state => {
    const { value } = await handoffs.prepare("alice", input());
    const id = randomUUID();
    await handoffs.upload("alice", value.handoffId, id, "file", "text/plain", Readable.from(["bytes"]));
    if (state === "cancelled") await handoffs.cancel("alice", value.handoffId);
    else now += DAY + 1;
    await expect(handoffs.finalize("alice", value.handoffId, [id])).rejects.toMatchObject({ status: 410, code: "handoff_closed" });
  });
  it("isolates malformed records and unavailable finalized workspaces during cleanup", async () => {
    const broken = await handoffs.prepare("alice", input());
    const blocked = await handoffs.prepare("alice", input());
    const expired = await handoffs.prepare("alice", input());
    await handoffs.upload("alice", blocked.value.handoffId, randomUUID(), "file", "text/plain", Readable.from(["bytes"]));
    const blockedFile = path.join(root, "handoffs", blocked.value.handoffId, "record.json");
    const raw = JSON.parse(await readFile(blockedFile, "utf8")); raw.state = "finalized";
    raw.result = { conversationId: raw.conversationId, disposition: "draft", open: { endpoint: "http", path: "/assistant" } };
    await writeFile(blockedFile, JSON.stringify(raw));
    await writeFile(path.join(root, "handoffs", broken.value.handoffId, "record.json"), "corrupt");
    vi.spyOn(manager, "workspaceFor").mockResolvedValue(null);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    now += DAY + 1;
    await expect(handoffs.sweep()).resolves.toBeUndefined();
    expect((await handoffs.status("alice", expired.value.handoffId)).state).toBe("expired");
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(blockedFile, "utf8")).prompt).toBe(raw.prompt);
  });
  it.each(["cancelled", "abandoned"])("settles accepted execution when the conversation is %s", async state => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", { ...input(), prompt: "write a file" });
    await handoffs.finalize("alice", value.handoffId, []);
    await vi.waitFor(async () => expect((await manager.getSession(value.conversationId))?.status).toBe("awaiting_approval"));
    if (state === "cancelled") await manager.cancelSession(value.conversationId);
    else await manager.sweepAbandoned(DAY, Date.now() + DAY + 1000);
    expect((await handoffs.status("alice", value.handoffId)).executionState).toBe("failed");
  });
  it("settles a persisted abandoned execution without hydrating its session", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", { ...input(), prompt: "write a file" });
    await handoffs.finalize("alice", value.handoffId, []);
    await vi.waitFor(async () => expect((await manager.getSession(value.conversationId))?.status).toBe("awaiting_approval"));
    await manager.shutdown(); manager = makeManager();
    await manager.sweepAbandoned(DAY, Date.now() + DAY + 1000);
    expect(await store.readRecord(value.conversationId)).toMatchObject({ status: "abandoned", handoffDispatch: { state: "failed" } });
  });
  it("keeps an old uncertain dispatch separate from a later successful manual turn across restarts", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input());
    await handoffs.finalize("alice", value.handoffId, []);
    await manager.shutdown();
    const record = (await store.readRecord(value.conversationId))!;
    record.handoffDispatch!.state = "unknown"; record.status = "failed"; await store.saveRecord(record);
    manager = makeManager(); await manager.recoverHandoff(record.id);
    await manager.postMessage(record.id, "a separate manual turn");
    await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
    await manager.shutdown(); manager = makeManager();
    await manager.recoverHandoff(record.id); await manager.recoverHandoff(record.id);
    expect(await store.readRecord(record.id)).toMatchObject({ status: "idle", handoffDispatch: { state: "unknown" } });
  });
  it("serializes recovery before a concurrent session mutation", async () => {
    const { value } = await handoffs.prepare("alice", input());
    await handoffs.finalize("alice", value.handoffId, []);
    await manager.shutdown(); manager = makeManager();
    const record = (await store.readRecord(value.conversationId))!;
    record.handoffDispatch = { id: randomUUID(), state: "running" }; record.status = "running";
    await store.saveRecord(record);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const read = store.readRecord.bind(store);
    const spy = vi.spyOn(store, "readRecord").mockImplementationOnce(async id => { const snapshot = await read(id); await blocked; return snapshot; });
    const recovery = manager.recoverHandoff(record.id);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const turn = manager.postMessage(record.id, "a manual follow-up");
    await new Promise(resolve => setTimeout(resolve, 20));
    try { expect(spy).toHaveBeenCalledTimes(1); } finally { release(); }
    await Promise.all([recovery, turn]);
    await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
    expect((await store.readEvents(record.id)).filter(e => e.type === "user_message")).toHaveLength(1);
  });
  it("recovers the same actor-scoped preparation after restart and rejects changed input", async () => {
    const request = input(), first = await handoffs.prepare("alice", request);
    await manager.shutdown(); manager = makeManager(); handoffs = new HandoffStore(manager, settings, null, () => now);
    expect(await handoffs.prepare("alice", request)).toMatchObject({ created: false, value: { handoffId: first.value.handoffId } });
    await expect(handoffs.prepare("alice", { ...request, prompt: "different" })).rejects.toMatchObject({ status: 409 });
    const other = await handoffs.prepare("bob", request); expect(other.value.handoffId).not.toBe(first.value.handoffId);
    await expect(handoffs.status("bob", first.value.handoffId)).rejects.toMatchObject({ status: 404 });
  });
  it("blocks pending turns and hides reservations from ordinary history", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input());
    expect(await manager.listSessions()).toEqual([]);
    await expect(manager.postMessage(value.conversationId, "bypass")).rejects.toMatchObject({ code: "handoff_pending" });
    expect((await store.readEvents(value.conversationId)).some(e => e.type === "user_message")).toBe(false);
  });
  it("uses IDs for attachment retries and keeps two files with the same display name", async () => {
    const { value } = await handoffs.prepare("alice", input());
    const first = randomUUID(), second = randomUUID();
    const put = (id: string, bytes: string) => handoffs.upload("alice", value.handoffId, id, "image.png", "image/png", Readable.from([bytes]));
    expect((await put(first, "image one")).created).toBe(true);
    expect((await put(first, "image one")).created).toBe(false);
    await expect(put(first, "changed")).rejects.toMatchObject({ status: 409 });
    await put(second, "image two");
    await expect(handoffs.finalize("alice", value.handoffId, [first])).rejects.toMatchObject({ status: 409 });
    const finalized = await handoffs.finalize("alice", value.handoffId, [first, second]);
    expect(finalized.result?.disposition).toBe("draft");
    const session = await manager.getSession(value.conversationId);
    expect(session?.handoffDraft?.attachments).toHaveLength(2);
    const names = session!.handoffDraft!.attachments.map(a => a.name);
    expect(new Set(names).size).toBe(2);
    expect(await readFile(store.attachmentPath(value.conversationId, names[0]!)!, "utf8")).toBe("image one");
    expect((await handoffs.finalize("alice", value.handoffId, [second, first])).result).toEqual(finalized.result);
    await expect(put(randomUUID(), "later")).rejects.toMatchObject({ status: 409 });
  });
  it("does not finalize an interrupted upload and permits the same ID to be retried", async () => {
    const { value } = await handoffs.prepare("alice", input()); const id = randomUUID();
    const broken = Readable.from((async function* () { yield "part"; throw new Error("connection lost"); })());
    await expect(handoffs.upload("alice", value.handoffId, id, "file.txt", "text/plain", broken)).rejects.toThrow("connection lost");
    expect((await handoffs.status("alice", value.handoffId)).attachments).toEqual([]);
    await expect(handoffs.finalize("alice", value.handoffId, [id])).rejects.toMatchObject({ status: 409 });
    expect((await handoffs.upload("alice", value.handoffId, id, "file.txt", "text/plain", Readable.from(["complete"]))).created).toBe(true);
  });
  it("accepts the guaranteed ten arbitrary 10 MB files and rejects an oversized file", async () => {
    const { value } = await handoffs.prepare("alice", input()); const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = randomUUID(); ids.push(id);
      await handoffs.upload("alice", value.handoffId, id, "opaque.data", "application/octet-stream", Readable.from([Buffer.alloc(10_000_000)]));
    }
    expect((await handoffs.finalize("alice", value.handoffId, ids)).attachments).toHaveLength(10);
    const next = await handoffs.prepare("alice", input());
    await expect(handoffs.upload("alice", next.value.handoffId, randomUUID(), "large.data", "application/octet-stream", Readable.from([Buffer.alloc(26 * 1024 * 1024)]))).rejects.toMatchObject({ status: 413 });
  });
  it("keeps an empty context-only handoff as a draft even with immediate start enabled", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", { ...input(), prompt: "" });
    expect((await handoffs.finalize("alice", value.handoffId, [])).result?.disposition).toBe("draft");
    expect((await store.readEvents(value.conversationId)).filter(e => e.type === "user_message")).toHaveLength(0);
  });
  it("serializes concurrent uploads and finalization and rejects clock skew", async () => {
    await expect(handoffs.prepare("alice", { ...input(), requestId: createAssistantRequestId(now + 300_001) })).rejects.toMatchObject({ status: 400 });
    const { value } = await handoffs.prepare("alice", input());
    const attachmentId = randomUUID();
    const upload = handoffs.upload("alice", value.handoffId, attachmentId, "file", "application/octet-stream", Readable.from(["bytes"]));
    const finalize = handoffs.finalize("alice", value.handoffId, [attachmentId]);
    const cancel = handoffs.cancel("alice", value.handoffId);
    const outcomes = await Promise.allSettled([upload, finalize, cancel]);
    expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1].status).toBe("fulfilled");
    expect(outcomes[2]).toMatchObject({ status: "rejected", reason: { status: 409 } });
  });
  it("records one immediate dispatch across retries and settings changes", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input());
    const first = await handoffs.finalize("alice", value.handoffId, []);
    expect(first.result).toMatchObject({ disposition: "accepted" });
    await settings.update({ immediateHandoffs: false });
    expect((await handoffs.finalize("alice", value.handoffId, [])).result).toEqual(first.result);
    expect((await store.readEvents(value.conversationId)).filter(e => e.type === "user_message")).toHaveLength(1);
  });
  it("reports native startup uncertainty without replaying or leaving the composer running", async () => {
    const adapter = new FakeHarnessAdapter();
    adapter.start = () => { throw new Error("native startup interrupted"); };
    manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, settings);
    handoffs = new HandoffStore(manager, settings, null, () => now);
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input());
    expect((await handoffs.finalize("alice", value.handoffId, [])).executionState).toBe("unknown");
    expect((await manager.getSession(value.conversationId))?.status).toBe("failed");
    await handoffs.finalize("alice", value.handoffId, []);
    expect((await store.readEvents(value.conversationId)).filter(e => e.type === "user_message")).toHaveLength(1);
  });
  it("does not dispatch from GET and never replays an uncertain native execution", async () => {
    await settings.update({ immediateHandoffs: true });
    const { value } = await handoffs.prepare("alice", input());
    // Simulate a durable finalization written immediately before a crash.
    const file = path.join(root, "handoffs", value.handoffId, "record.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.state = "finalized"; raw.result = { conversationId: value.conversationId, disposition: "accepted", dispatchId: randomUUID(), open: { endpoint: "http", path: "/assistant" } };
    await writeFile(file, JSON.stringify(raw));
    await handoffs.status("alice", value.handoffId);
    expect((await store.readEvents(value.conversationId)).filter(e => e.type === "user_message")).toHaveLength(0);
    const record = (await manager.getSession(value.conversationId))!;
    record.handoffDispatch!.state = "unknown"; await store.saveRecord(record);
    await handoffs.finalize("alice", value.handoffId, []);
    expect((await store.readEvents(value.conversationId)).filter(e => e.type === "user_message")).toHaveLength(0);
  });
  it("expires and cancels only pending preparations, retaining replay protection after transcript deletion", async () => {
    const request = input(), { value } = await handoffs.prepare("alice", request);
    const regular = await manager.createSession({ createdBy: "alice" });
    now += DAY + 1; await handoffs.sweep();
    expect((await handoffs.status("alice", value.handoffId)).state).toBe("expired");
    expect(await manager.getSession(value.conversationId)).toBeNull();
    expect(await manager.getSession(regular.id)).not.toBeNull();
    expect((await handoffs.prepare("alice", request)).created).toBe(false);
    now += 30 * DAY; await handoffs.sweep();
    await expect(handoffs.prepare("alice", request)).rejects.toMatchObject({ status: 410 });
    const fresh = await handoffs.prepare("alice", input());
    expect((await handoffs.cancel("alice", fresh.value.handoffId)).state).toBe("cancelled");
    expect((await handoffs.cancel("alice", fresh.value.handoffId)).state).toBe("cancelled");
  });
  it("does not recreate finalized conversations deleted by their owner", async () => {
    const request = input(), { value } = await handoffs.prepare("alice", request);
    await handoffs.finalize("alice", value.handoffId, []);
    await expect(handoffs.cancel("alice", value.handoffId)).rejects.toMatchObject({ status: 409 });
    await manager.deleteSession(value.conversationId, "alice");
    expect((await handoffs.prepare("alice", request)).value.conversationId).toBe(value.conversationId);
    await handoffs.finalize("alice", value.handoffId, []);
    expect(await manager.getSession(value.conversationId)).toBeNull();
  });
});
