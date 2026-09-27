import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  afterEach(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const input = () => ({ requestId: createAssistantRequestId(now), prompt: "Please inspect this", appIds: [] });
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
