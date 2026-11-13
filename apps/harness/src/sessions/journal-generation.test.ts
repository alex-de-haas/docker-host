import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import * as persistence from "../persistence.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import * as fs from "node:fs/promises";
import { SessionStore, type SessionRecord, type StoredEvent } from "./store.js";

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const record: SessionRecord = { id: "chat", createdBy: "owner", status: "idle", title: null, context: null,
  harnessSessionId: null, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastEventSeq: 0 };
const event = (seq: number): StoredEvent => ({ seq, type: "assistant_text", ts: record.createdAt, text: `frame ${seq}` });
let root: string, target: string, store: SessionStore, reads: number, bytesRead: number;
beforeEach(async () => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  root = await actual.mkdtemp(path.join(os.tmpdir(), "hosty-journal-generation-"));
  store = new SessionStore(root); await store.createSession({ ...record });
  target = path.join(root, "sessions", record.id, "events.ndjson"); reads = 0; bytesRead = 0;
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    const value = await actual.readFile(...args);
    if (args[0] === target) { reads++; bytesRead += Buffer.byteLength(value); }
    return value;
  });
});
afterEach(async () => { vi.restoreAllMocks(); await actual.rm(root, { recursive: true, force: true }); });

it("reconciles a long journal once across streaming append/checkpoint pairs and still validates actual history reads", async () => {
  const initial = JSON.stringify({ ...event(1), text: "retained history ".repeat(8192) }) + "\n";
  await actual.writeFile(target, initial);
  for (let seq = 2; seq <= 41; seq++) { await store.appendEvent(record.id, event(seq)); await store.saveRecord({ ...record }); }
  expect(reads).toBe(1); expect(bytesRead).toBe(Buffer.byteLength(initial));
  expect(await store.eventHighWater(record.id)).toBe(41); expect((await store.readRecord(record.id))?.lastEventSeq).toBe(41);
  expect(reads).toBe(1);
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual(Array.from({ length: 41 }, (_, index) => index + 1));
  expect(reads).toBe(2);
});

it("invalidates a warm generation after same-size corruption even when mtime is restored", async () => {
  await actual.writeFile(target, JSON.stringify(event(1)) + "\n");
  const exact = new Date("2026-11-12T00:00:00.000Z"); await actual.utimes(target, exact, exact);
  await store.saveRecord({ ...record }); const before = await actual.stat(target, { bigint: true });
  const raw = await actual.readFile(target); raw[0] = 91;
  await actual.writeFile(target, raw); await actual.utimes(target, exact, exact);
  const after = await actual.stat(target, { bigint: true }); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs);
  await expect(store.saveRecord({ ...record })).rejects.toMatchObject({ code: "session_storage_corrupt" });
  await expect(store.readEvents(record.id)).rejects.toMatchObject({ code: "session_storage_corrupt" });
  expect(await actual.readFile(target)).toEqual(raw);
});

it("rejects a disappeared warm journal rather than appending past an acknowledged checkpoint", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  await actual.unlink(target);
  await expect(store.appendEvent(record.id, event(2))).rejects.toMatchObject({ code: "session_storage_corrupt" });
  await expect(actual.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reconciles an externally replaced valid journal before advancing a warm high water", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  const replacement = target + ".replacement";
  await actual.writeFile(replacement, [event(1), event(2)].map(value => JSON.stringify(value)).join("\n") + "\n");
  await actual.rename(replacement, target);
  await store.appendEvent(record.id, event(3));
  expect(await store.eventHighWater(record.id)).toBe(3);
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1, 2, 3]);
});

it("keeps a newly torn warm tail uncached and archives its exact bytes before the next append", async () => {
  await store.appendEvent(record.id, event(1));
  const tail = Buffer.concat([Buffer.from('{"seq":2,"text":"unfinished '), Buffer.from("🙂").subarray(0, 3)]);
  await actual.appendFile(target, tail); reads = 0;
  expect(await store.eventHighWater(record.id)).toBe(1); expect(await store.eventHighWater(record.id)).toBe(1);
  expect(reads).toBe(2);
  await store.appendEvent(record.id, event(2));
  const [artifact] = await actual.readdir(path.join(root, "sessions", record.id, "recovery"));
  expect(await actual.readFile(path.join(root, "sessions", record.id, "recovery", artifact!))).toEqual(tail);
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1, 2]);
});

it("drops uncertain own-write metadata and cold-reconciles before reopening without duplicating the append", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  const append = persistence.durableAppendFile;
  vi.spyOn(persistence, "durableAppendFile").mockImplementationOnce(async (file, content) => {
    await append(file, content); throw new persistence.DurableWriteError(file, new Error("synthetic lost acknowledgement"));
  });
  await expect(store.appendEvent(record.id, event(2))).rejects.toMatchObject({ code: "session_storage_uncertain" });
  await expect(store.appendEvent(record.id, event(3))).rejects.toMatchObject({ code: "session_storage_uncertain" });
  store = new SessionStore(root);
  expect((await store.readRecord(record.id))?.lastEventSeq).toBe(2);
  await store.appendEvent(record.id, event(3));
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1, 2, 3]);
});

it("fences a reopened checkpoint whose pending outbox hides multiple missing transcript events", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  const checkpoint = { ...record, lastEventSeq: 5, appContextEvent: { ...event(5), type: "app_context_changed" } };
  const checkpointPath = path.join(root, "sessions", record.id, "record.json");
  await actual.writeFile(checkpointPath, JSON.stringify(checkpoint));
  store = new SessionStore(root);
  expect((await store.readRecord(record.id))?.storageRecovery).toMatchObject({ state: "required", code: "session_storage_corrupt" });
  expect((await store.listRecordInventory()).unavailableIds).toEqual([record.id]);
  expect(JSON.parse(await actual.readFile(checkpointPath, "utf8"))).toEqual(checkpoint);
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1]);
});

it("rejects checkpoint updates when a pending outbox hides a multi-event gap in a warm journal", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  const checkpoint = { ...record, lastEventSeq: 5, appContextEvent: { ...event(5), type: "app_context_changed" } };
  const checkpointPath = path.join(root, "sessions", record.id, "record.json");
  await actual.writeFile(checkpointPath, JSON.stringify(checkpoint));
  await expect(store.saveRecord({ ...checkpoint, title: "must not overwrite recovery evidence" }))
    .rejects.toMatchObject({ code: "session_storage_corrupt" });
  expect(JSON.parse(await actual.readFile(checkpointPath, "utf8"))).toEqual(checkpoint);
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1]);
});

it("preserves and completes the exact one-event pending context outbox after reopening", async () => {
  await store.appendEvent(record.id, event(1)); await store.saveRecord({ ...record });
  const outbox = { ...event(2), type: "app_context_changed", contextRequestId: "retained-context-request" };
  const checkpoint = { ...record, lastEventSeq: 2, appContextEvent: outbox };
  await store.saveRecord(checkpoint);
  store = new SessionStore(root);
  const retained = await store.readRecord(record.id);
  expect(retained).toMatchObject({ lastEventSeq: 2, appContextEvent: outbox });
  expect(retained?.storageRecovery).toBeUndefined();
  await expect(store.saveRecord({ ...retained!, title: "retained pending context" })).resolves.toBeUndefined();
  await store.appendEvent(record.id, outbox);
  await store.saveRecord({ ...retained!, appContextEvent: undefined });
  expect((await store.readEvents(record.id)).map(value => value.seq)).toEqual([1, 2]);
  expect((await store.readRecord(record.id))?.appContextEvent).toBeUndefined();
});
