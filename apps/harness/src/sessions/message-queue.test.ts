import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { SessionStore, type SessionRecord } from "./store.js";
import { MessageQueue, type QueueCommand } from "./message-queue.js";
import { SessionManager } from "./manager.js";
import { AuditReporter } from "../audit.js";
import { ProviderDirectory } from "../settings/providers.js";
import { resolveAppSession } from "../app-session.js";
import { retentionBusy } from "./retention.js";
import type { DevelopmentClient } from "./development.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";

vi.mock("../app-session.js", async original => ({ ...await original<typeof import("../app-session.js")>(), resolveAppSession: vi.fn() }));
let dir: string, store: SessionStore, queue: MessageQueue, record: SessionRecord, manager: SessionManager;
let sent: string[], starts: HarnessStartOptions[];
const adapter: HarnessAdapter = {
  name: "queue-test", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => { starts.push(options); return { send: text => { sent.push(text); }, stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {},
    setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false }; },
};
const build = (development: DevelopmentClient | null = null) => {
  const providers = new ProviderDirectory(null, null, "gateway");
  vi.spyOn(providers, "readApps").mockResolvedValue([]);
  return new SessionManager(store, adapter, new AuditReporter(null, null, "gateway"), dir, null, providers, null, null, null, null, null, development);
};
const command = (value: QueueCommand, target = record) => ({ requestId: randomUUID(), expectedRevision: queue.state(target).revision, command: value });
const enqueue = (text: string, attachments: string[] = []) => ({ type: "enqueue" as const, entryId: randomUUID(), text, attachments });
const liveCommand = async (value: QueueCommand, credential = "fixture-current-authority") => manager.messageQueueCommand(record.id, "owner", {
  requestId: randomUUID(), expectedRevision: (await manager.messageQueue(record.id, "owner")).revision, command: value,
}, credential);
const finish = async () => { starts.at(-1)!.onEvent({ type: "result", status: "success" }); };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-message-queue-")); store = new SessionStore(dir, path.join(dir, "cache")); queue = new MessageQueue(store);
  starts = []; sent = []; manager = build(); record = await manager.createSession({ createdBy: "owner" });
  vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "owner", hostRole: "host.admin" } });
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("durable queue commands and immutable attachments", () => {
  it("replays UUID receipts before revision checks and never resurrects a retired entry identity", async () => {
    const value = enqueue("first"), request = command(value);
    const accepted = await queue.command(record, request);
    await queue.command(record, command({ type: "delete", entryId: value.entryId }));
    expect((await queue.command(record, request)).result).toEqual(accepted.result);
    expect(queue.snapshot(record).entries).toEqual([]);
    await expect(queue.command(record, command(value))).rejects.toMatchObject({ code: "queue_entry_exists" });
    await expect(queue.command(record, command({ ...value, text: "different" }))).rejects.toMatchObject({ code: "queue_entry_conflict" });
    await expect(queue.command(record, { ...request, command: { ...value, text: "different" } })).rejects.toMatchObject({ code: "queue_request_conflict" });
    expect(retentionBusy({ ...record, messageQueue: undefined })).toBe(false);
  });
  it("rejects stale revisions without changing queue order", async () => {
    const first = command(enqueue("one")), second = command(enqueue("two"));
    await queue.command(record, first);
    await expect(queue.command(record, second)).rejects.toMatchObject({ code: "queue_revision_conflict" });
    expect(queue.snapshot(record).entries.map(e => e.text)).toEqual(["one"]); expect(retentionBusy(record)).toBe(true);
  });
  it("recovers editing with a new reservation and preserves original content, attachments and the stashed draft", async () => {
    const workspace = await store.ensureWorkspace(record.id); await writeFile(path.join(workspace!, "image.txt"), "image");
    const value = enqueue("original", ["image.txt"]); await queue.command(record, command(value));
    const reserved = await queue.command(record, command({ type: "reserve_edit", entryId: value.entryId, viewId: "view-one", stashedDraft: { text: "later draft", attachments: ["image.txt"] } }));
    const oldReservation = reserved.result.reservationId!, attachedName = reserved.queue.entries[0]!.attachments[0]!.name;
    await queue.command(record, command({ type: "update_edit", entryId: value.entryId, reservationId: oldReservation, viewId: "view-one", text: "edited", attachments: [attachedName] }));
    await manager.shutdown(); manager = build();
    const restored = (await store.readRecord(record.id))!;
    const recovered = await queue.command(restored, command({ type: "recover_edit", entryId: value.entryId, viewId: "view-two" }, restored));
    expect(recovered.queue.entries[0]!.edit).toMatchObject({ text: "edited", generation: 2, stashedDraft: { text: "later draft", attachments: [{ displayName: "image.txt" }] } });
    await expect(queue.command(restored, command({ type: "save_edit", entryId: value.entryId, reservationId: oldReservation, viewId: "view-one", text: "stale", attachments: [] }, restored))).rejects.toMatchObject({ code: "queue_edit_conflict" });
    await queue.command(restored, command({ type: "cancel_edit", entryId: value.entryId, reservationId: recovered.result.reservationId!, viewId: "view-two" }, restored));
    expect(queue.snapshot(restored).entries[0]).toMatchObject({ text: "original", state: "queued", attachments: [{ displayName: "image.txt" }] });
    await rm(path.join(workspace!, "image.txt"));
    const stash = recovered.queue.entries[0]!.edit!.stashedDraft;
    await queue.command(restored, command(enqueue(stash.text, stash.attachments.map(file => file.name)), restored));
    expect(queue.snapshot(restored).entries[1]!.attachments[0]).toMatchObject({ displayName: "image.txt", size: 5 });
    for (const row of [...queue.snapshot(restored).entries]) await queue.command(restored, command({ type: "delete", entryId: row.id }, restored));
    expect((await queue.attachment(restored, stash.attachments[0]!.id)).bytes.toString()).toBe("image");
  });
  it("uses the queued snapshot when a running agent changes its workspace file", async () => {
    const workspace = await store.ensureWorkspace(record.id); await writeFile(path.join(workspace!, "source.txt"), "operator upload");
    const value = enqueue("inspect", ["source.txt"]); await queue.command(record, command(value));
    await writeFile(path.join(workspace!, "source.txt"), "changed by agent");
    const current = queue.state(record).entries[0]!;
    current.attempt = { clientRequestId: randomUUID(), text: current.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    const materialized = await queue.materialize(record, current);
    expect(await readFile(store.attachmentPath(record.id, materialized[0]!)!, "utf8")).toBe("operator upload");
    expect(materialized[0]).not.toBe("source.txt");
    expect(await readFile(path.join(workspace!, "source.txt"), "utf8")).toBe("changed by agent");
    expect(JSON.stringify(queue.snapshot(record))).not.toContain("digest");
    expect((await queue.attachment(record, current.attachments[0]!.id)).bytes.toString()).toBe("operator upload");
  });
  it("reconciles stable upload identities without duplicate filenames and rejects changed bytes", async () => {
    const uploadId = randomUUID();
    const first = await queue.upload(record, uploadId, "файл.txt", Readable.from(["bytes"]));
    expect(await queue.upload(record, uploadId, "файл.txt", Readable.from(["bytes"]))).toEqual(first);
    await expect(queue.upload(record, uploadId, "файл.txt", Readable.from(["changed"]))).rejects.toMatchObject({ code: "queue_upload_conflict" });
    await queue.command(record, command(enqueue("", [first.name])));
    expect(queue.snapshot(record).entries[0]!.attachments[0]).toMatchObject({ id: uploadId, displayName: "файл.txt", size: 5 });
  });
  it("does not acknowledge a corrupted immutable target left by an interrupted disk write", async () => {
    const file = await queue.upload(record, randomUUID(), "file.txt", Readable.from(["complete bytes"]));
    await queue.command(record, command(enqueue("inspect", [file.name])));
    const digest = queue.state(record).entries[0]!.attachments[0]!.digest;
    await writeFile(path.join(store.messageQueueDirectory(record.id), "files", digest), "partial");
    await expect(queue.upload(record, randomUUID(), "retry.txt", Readable.from(["complete bytes"]))).rejects.toMatchObject({ code: "queue_attachment_changed" });
    await expect(queue.attachment(record, file.id)).rejects.toMatchObject({ code: "queue_attachment_changed" });
  });
  it("blocks a missing retained attachment rather than sending an incomplete message", async () => {
    const uploaded = await queue.upload(record, randomUUID(), "file.txt", Readable.from(["bytes"]));
    await queue.command(record, command(enqueue("check", [uploaded.name])));
    const current = queue.state(record).entries[0]!;
    await rm(path.join(store.messageQueueDirectory(record.id), "files", current.attachments[0]!.digest));
    current.attempt = { clientRequestId: randomUUID(), text: current.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    await expect(queue.materialize(record, current)).rejects.toMatchObject({ code: "queue_attachment_missing" });
  });
  it("releases deleted queue-only bytes and safely reopens the original upload UUID", async () => {
    const uploadId = randomUUID(), uploaded = await queue.upload(record, uploadId, "file.txt", Readable.from(["original"]));
    const value = enqueue("inspect", [uploaded.name]); await queue.command(record, command(value));
    await queue.command(record, command({ type: "delete", entryId: value.entryId }));
    expect(await readdir(path.join(store.messageQueueDirectory(record.id), "files"))).toEqual([]);
    expect(await queue.upload(record, uploadId, "file.txt", Readable.from(["original"]))).toEqual(uploaded);
    await expect(queue.upload(record, uploadId, "file.txt", Readable.from(["different"]))).rejects.toMatchObject({ code: "queue_upload_conflict" });
    await queue.command(record, command(enqueue("again", [uploaded.name])));
  });
  it("bounds retained attachment identities even for duplicate bytes and frees deleted identities", async () => {
    const rows = [];
    for (let index = 0; index < 20; index++) {
      const file = await queue.upload(record, randomUUID(), `file-${index}.txt`, Readable.from(["same bytes"]));
      const row = enqueue(String(index), [file.name]); rows.push(row); await queue.command(record, command(row));
    }
    await expect(queue.upload(record, randomUUID(), "over.txt", Readable.from(["same bytes"]))).rejects.toMatchObject({ code: "queue_attachment_capacity" });
    await queue.command(record, command({ type: "delete", entryId: rows[0]!.entryId }));
    await expect(queue.upload(record, randomUUID(), "replacement.txt", Readable.from(["same bytes"]))).resolves.toMatchObject({ size: 10 });
  });
  it("reuses materialized attachment paths across turns and preserves the workspace quota", async () => {
    const file = await queue.upload(record, randomUUID(), "file.txt", Readable.from(["bytes"]));
    await queue.command(record, command(enqueue("inspect", [file.name])));
    const entry = queue.state(record).entries[0]!; let names: string[] = [];
    for (let index = 0; index < 25; index++) {
      entry.attempt = { clientRequestId: randomUUID(), text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
      const current = await queue.materialize(record, entry);
      if (names.length) expect(current).toEqual(names); names = current;
    }
    expect(await readdir((await store.ensureWorkspace(record.id))!)).toEqual(names);
  });
  it("does not follow a legacy predictable materialization temp symlink", async () => {
    const file = await queue.upload(record, randomUUID(), "file.txt", Readable.from(["queued bytes"]));
    await queue.command(record, command(enqueue("inspect", [file.name])));
    const entry = queue.state(record).entries[0]!;
    entry.attempt = { clientRequestId: randomUUID(), text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    const target = store.attachmentPath(record.id, file.name)!, outside = path.join(dir, "preserved.txt");
    await store.ensureWorkspace(record.id); await writeFile(outside, "preserve existing bytes"); await symlink(outside, target + ".tmp");
    expect(await queue.materialize(record, entry)).toEqual([file.name]);
    expect(await readFile(outside, "utf8")).toBe("preserve existing bytes"); expect(await readFile(target, "utf8")).toBe("queued bytes");
  });
  it("refuses capacity overflow without evicting any accepted message", async () => {
    const values = Array.from({ length: 100 }, (_, index) => enqueue(String(index)));
    for (const value of values) await queue.command(record, command(value));
    await expect(queue.command(record, command(enqueue("overflow")))).rejects.toMatchObject({ code: "queue_capacity" });
    expect(queue.snapshot(record).entries.map(entry => entry.id)).toEqual(values.map(value => value.entryId));
  });
});

describe("background dispatch and receipt recovery", () => {
  it("continues ordered messages without a browser subscription and rejects legacy overtaking", async () => {
    await liveCommand(enqueue("first")); await vi.waitFor(() => expect(sent).toEqual(["first"]));
    await liveCommand(enqueue("second")); await liveCommand(enqueue("third"));
    await expect(manager.postMessage(record.id, "overtake")).rejects.toMatchObject({ code: "queue_pending" });
    await finish(); await vi.waitFor(() => expect(sent).toEqual(["first", "second"]));
    await finish(); await vi.waitFor(() => expect(sent).toEqual(["first", "second", "third"]));
    await finish(); await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries).toEqual([]));
    expect((await store.readEvents(record.id)).filter(e => e.type === "user_message")).toHaveLength(3);
  });
  it("requires current owner authority before dispatch and refreshes queued chats after restart", async () => {
    await liveCommand(enqueue("saved"), "");
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).waiting?.code).toBe("queue_sign_in_required"));
    await manager.shutdown(); manager = build(); await manager.recoverMessageQueues();
    vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "someone-else", hostRole: "host.admin" } });
    await manager.refreshActorCredentials("owner", "wrong-actor-authority");
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).waiting?.code).toBe("queue_sign_in_required")); expect(sent).toEqual([]);
    vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: "owner", hostRole: "host.admin" } });
    await manager.refreshActorCredentials("owner", "fresh-owner-authority"); await vi.waitFor(() => expect(sent).toEqual(["saved"]));
  });
  it("pauses pending messages on Stop and resumes only on explicit action", async () => {
    await liveCommand(enqueue("first")); await vi.waitFor(() => expect(sent).toHaveLength(1));
    await liveCommand(enqueue("second")); await manager.cancelSession(record.id);
    const paused = await manager.messageQueue(record.id, "owner"); expect(paused.paused).toBe(true); expect(sent).toEqual(["first"]);
    await liveCommand({ type: "resume" }); await vi.waitFor(() => expect(sent).toEqual(["first", "second"]));
  });
  it("does not advance past an editing head or a native question", async () => {
    await liveCommand({ type: "pause" }); const first = enqueue("first"); await liveCommand(first); await liveCommand(enqueue("second"));
    await liveCommand({ type: "reserve_edit", entryId: first.entryId, viewId: "editor", stashedDraft: { text: "draft", attachments: [] } });
    await liveCommand({ type: "resume" }); await new Promise(resolve => setImmediate(resolve)); expect(sent).toEqual([]);
    const reserved = (await manager.messageQueue(record.id, "owner")).entries[0]!.edit!;
    await liveCommand({ type: "cancel_edit", entryId: first.entryId, reservationId: reserved.reservationId, viewId: "editor" });
    await vi.waitFor(() => expect(sent).toEqual(["first"]));
    starts[0]!.onEvent({ type: "question_request", questionId: "question", questions: [{ header: "Choice", question: "Choose?", multiSelect: false, options: [] }] });
    await vi.waitFor(async () => expect((await manager.getSession(record.id))!.status).toBe("awaiting_question")); expect(sent).toHaveLength(1);
  });
  it("retains unknown admission after a lost provider acknowledgement and never sends it twice", async () => {
    vi.spyOn(adapter, "start").mockImplementationOnce(options => { starts.push(options); return {
      send: text => { sent.push(text); throw new Error("acknowledgement lost"); }, stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {},
      setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false,
    }; });
    const value = enqueue("once"); await liveCommand(value);
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries[0]?.state).toBe("unknown"));
    await manager.shutdown(); manager = build(); await manager.recoverMessageQueues();
    await liveCommand({ type: "retry", entryId: value.entryId });
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).paused).toBe(true)); expect(sent).toEqual(["once"]);
  });
  it("recovers a frozen pre-admission claim with the original UUID and current claim-time settings", async () => {
    const value = enqueue("retained claim"); await queue.command(record, command(value));
    const entry = queue.state(record).entries[0]!, clientRequestId = randomUUID();
    entry.state = "sending"; entry.attempt = { clientRequestId, text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 7, withoutAppDetails: false };
    record.selectionRevision = 7; await store.saveRecord(record);
    await manager.shutdown(); manager = build(); await manager.recoverMessageQueues();
    await manager.refreshActorCredentials("owner", "restored-authority"); await vi.waitFor(() => expect(sent).toEqual(["retained claim"]));
    const events = (await store.readEvents(record.id)).filter(e => e.type === "user_message");
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ clientRequestId, selectionRevision: 7 });
    expect(await manager.messageReceipt(record.id, clientRequestId, "owner")).toMatchObject({ state: "accepted" });
  });
  it("retires a crash-retained accepted claim without restored credentials or a second provider send", async () => {
    const value = enqueue("already accepted"); await queue.command(record, command(value));
    const entry = queue.state(record).entries[0]!, clientRequestId = randomUUID();
    entry.state = "sending"; entry.attempt = { clientRequestId, text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    await store.saveRecord(record); await store.saveMessageReceipt(record.id, { clientRequestId, actorUserId: "owner", state: "accepted", fingerprint: "a".repeat(64), eventSeq: 2 });
    await manager.shutdown(); manager = build(); await manager.recoverMessageQueues();
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries).toEqual([])); expect(sent).toEqual([]);
  });
  it("pauses a frozen attempt when its settings revisions changed rather than substituting another payload", async () => {
    const value = enqueue("pinned"); await queue.command(record, command(value));
    const entry = queue.state(record).entries[0]!;
    entry.state = "sending"; entry.attempt = { clientRequestId: randomUUID(), text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    record.selectionRevision = 1; await store.saveRecord(record);
    await manager.shutdown(); manager = build(); await manager.recoverMessageQueues(); await manager.refreshActorCredentials("owner", "restored-authority");
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries[0]?.error?.code).toBe("selection_conflict"));
    expect(sent).toEqual([]); expect((await manager.messageQueue(record.id, "owner")).paused).toBe(true);
  });
  it("does not infer native exit from an idle record after coordinator replacement", async () => {
    await liveCommand(enqueue("first")); await vi.waitFor(() => expect(sent).toEqual(["first"]));
    await liveCommand({ type: "pause" }); await liveCommand(enqueue("second")); await finish();
    await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
    await manager.shutdown();
    await manager.observations.change(state => { for (const run of state.runs) if (run.conversation === record.id) { run.stopConfirmed = false; run.generation = null; } });
    manager = build(); await manager.recoverMessageQueues(); await liveCommand({ type: "resume" });
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).waiting?.code).toBe("worker_recovery_required"));
    expect(sent).toEqual(["first"]);
  });
  it("fences settings changes between a durable claim and actual admission", async () => {
    const original = manager.postMessage.bind(manager);
    vi.spyOn(manager, "postMessage").mockImplementationOnce(async (...args) => {
      (await manager.getSession(record.id))!.autonomyRevision = 1;
      return original(...args);
    });
    const value = enqueue("review settings"); await liveCommand(value);
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries[0]?.error?.code).toBe("queue_settings_conflict"));
    const originalAttempt = (await manager.messageQueue(record.id, "owner")).entries[0]!.attempt!.clientRequestId;
    expect(sent).toEqual([]);
    await liveCommand({ type: "retry", entryId: value.entryId }); await vi.waitFor(() => expect(sent).toEqual(["review settings"]));
    expect((await store.readEvents(record.id)).find(event => event.type === "user_message")!.clientRequestId).not.toBe(originalAttempt);
  });
  it("keeps unreadable admission evidence locked instead of treating it as a missing receipt", async () => {
    const value = enqueue("uncertain"); await queue.command(record, command(value));
    const entry = queue.state(record).entries[0]!, clientRequestId = randomUUID();
    entry.state = "sending"; entry.attempt = { clientRequestId, text: entry.text, attachments: [], appContextRevision: 0, selectionRevision: 0, withoutAppDetails: false };
    await store.saveRecord(record); await store.saveMessageReceipt(record.id, { clientRequestId, actorUserId: "owner", state: "unknown", fingerprint: "a".repeat(64) });
    await writeFile(path.join(dir, "sessions", record.id, "message-requests", clientRequestId + ".json"), "torn receipt");
    await manager.recoverMessageQueues();
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries[0]?.error?.code).toBe("queue_receipt_unavailable"));
    const snapshot = await manager.messageQueue(record.id, "owner"); expect(snapshot.entries[0]!.state).toBe("unknown"); expect(snapshot.paused).toBe(true); expect(sent).toEqual([]);
  });
  it("exposes Retry when receipt storage becomes unreadable after an ambiguous provider send", async () => {
    let dispatched = false;
    const read = store.readMessageReceipt.bind(store);
    vi.spyOn(store, "readMessageReceipt").mockImplementation(async (...input) => {
      if (dispatched) throw new Error("Receipt storage unavailable");
      return read(...input);
    });
    vi.spyOn(adapter, "start").mockImplementationOnce(options => { starts.push(options); return {
      send: text => { sent.push(text); dispatched = true; throw new Error("Provider acknowledgement lost"); },
      stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false,
    }; });
    await liveCommand(enqueue("uncertain send"));
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries[0]?.error?.code).toBe("queue_receipt_unavailable"));
    const snapshot = await manager.messageQueue(record.id, "owner");
    expect(snapshot.paused).toBe(true); expect(snapshot.entries[0]!.state).toBe("unknown"); expect(snapshot.entries[0]!.attempt?.clientRequestId).toBeTruthy();
    expect(sent).toEqual(["uncertain send"]);
  });
  it("keeps an accepted UUID tombstone after dispatch and rejects another request for that entry", async () => {
    const value = enqueue("single"); await liveCommand(value); await vi.waitFor(() => expect(sent).toEqual(["single"]));
    await vi.waitFor(async () => expect((await manager.messageQueue(record.id, "owner")).entries).toHaveLength(0));
    await expect(liveCommand(value)).rejects.toMatchObject({ code: "queue_entry_exists" }); expect(sent).toEqual(["single"]);
  });
  it("serializes concurrent mutations and excludes another owner", async () => {
    await expect(manager.messageQueue(record.id, "intruder")).rejects.toThrow();
    await expect(manager.messageQueueCommand(record.id, "intruder", command(enqueue("no")))).rejects.toThrow();
    const revision = (await manager.messageQueue(record.id, "owner")).revision;
    const results = await Promise.allSettled([1, 2].map(index => manager.messageQueueCommand(record.id, "owner", {
      requestId: randomUUID(), expectedRevision: revision, command: enqueue(String(index)),
    })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "queue_revision_conflict" } });
  });
  it("rejects ordinary enqueues into immutable task attempts or unresolved handoffs", async () => {
    record.taskExecutionId = randomUUID();
    await expect(liveCommand(enqueue("task bypass"))).rejects.toMatchObject({ code: "task_managed_session" });
    delete record.taskExecutionId; record.handoffPending = true;
    await expect(liveCommand(enqueue("handoff bypass"))).rejects.toMatchObject({ code: "handoff_pending" });
    expect(sent).toEqual([]);
  });
  it("accepts a finalized handoff draft into the queue exactly once", async () => {
    record.handoffPending = true; await store.saveRecord(record);
    await manager.releaseHandoff(record.id, { text: "prepared handoff", attachments: [] });
    await liveCommand(enqueue("edited handoff"));
    expect((await manager.getSession(record.id))?.handoffDraft).toBeUndefined();
    expect((await store.readRecord(record.id))?.handoffDraft).toBeUndefined();
    await vi.waitFor(() => expect(sent).toEqual(["edited handoff"]));
  });
  it("refuses a new queued execution when Core reports a closed workspace", async () => {
    await manager.shutdown();
    const development = { available: true, call: vi.fn().mockResolvedValue({ state: "completed" }) } as unknown as DevelopmentClient;
    manager = build(development); record = await manager.createSession({ createdBy: "owner" });
    await expect(liveCommand(enqueue("closed workspace"))).rejects.toMatchObject({ code: "workspace_closed" });
    expect((await manager.messageQueue(record.id, "owner")).entries).toEqual([]); expect(sent).toEqual([]);
  });
});
