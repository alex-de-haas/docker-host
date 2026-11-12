import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as persistence from "../persistence.js";
import { retentionBusy } from "./retention.js";
import { SessionStore, type SessionRecord, type StoredEvent } from "./store.js";

let dir: string, store: SessionStore;
const record = (id = "one"): SessionRecord => ({ id, createdBy: "owner", status: "idle", title: null,
  context: null, harnessSessionId: null, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastEventSeq: 0 });
const event = (seq: number): StoredEvent => ({ seq, type: "user_message", ts: "2026-11-12T00:00:00.000Z", text: `input ${seq}` });
const journal = () => path.join(dir, "sessions", "one", "events.ndjson");
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "hosty-session-store-")); store = new SessionStore(dir); await store.createSession(record()); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("durable source sessions", () => {
  it("protects unresolved admissions and corrupt retained source from automatic retention", () => {
    expect(retentionBusy(record())).toBe(false);
    expect(retentionBusy({ ...record(), sourceAdmission: { runId: "uncertain-native-run", state: "dispatching" } })).toBe(true);
    expect(retentionBusy({ ...record(), storageRecovery: { state: "required", code: "session_storage_corrupt", message: "Recovery required" } })).toBe(true);
  });
  it("allocates concurrent callback identities inside the durable append lane", async () => {
    const events = Array.from({ length: 12 }, (_, index) => ({ ...event(1), text: `callback ${index}` }));
    await Promise.all(events.map(value => store.appendEvent("one", value, { after: 0 })));
    expect((await store.readEvents("one")).map(value => value.seq)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(new Set(events.map(value => value.seq)).size).toBe(12);
  });

  it("recovers append-before-checkpoint high water and refuses a reused identity", async () => {
    await store.appendEvent("one", event(1));
    store = new SessionStore(dir);
    expect((await store.readRecord("one"))!.lastEventSeq).toBe(1);
    await store.saveRecord(record());
    expect(JSON.parse(await readFile(path.join(dir, "sessions", "one", "record.json"), "utf8")).lastEventSeq).toBe(1);
    await store.appendEvent("one", event(2));
    await expect(store.appendEvent("one", event(2))).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect((await store.readEvents("one")).map(e => e.seq)).toEqual([1, 2]);
  });

  it.each(["{\"seq\":2", "\0\0\0", "{\"seq\":2,\"text\":\"partial\0\0"])("archives a proven torn final append before the next write: %j", async tail => {
    const prefix = JSON.stringify(event(1)) + "\n";
    await writeFile(journal(), prefix + tail);
    expect((await store.readEvents("one")).map(e => e.seq)).toEqual([1]);
    await store.appendEvent("one", event(2));
    expect((await store.readEvents("one")).map(e => e.seq)).toEqual([1, 2]);
    const artifacts = await readdir(path.join(dir, "sessions", "one", "recovery"));
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(dir, "sessions", "one", "recovery", artifacts[0]!), "utf8")).toBe(tail);
  });

  it.each([Buffer.from("Я").subarray(0, 1), Buffer.from("🙂").subarray(0, 2), Buffer.from("🙂").subarray(0, 3)])("archives an EOF-truncated UTF-8 scalar inside incomplete final JSON: %j", async fragment => {
    const prefix = JSON.stringify(event(1)) + "\n";
    const tail = Buffer.concat([Buffer.from('{"seq":2,"text":"unfinished '), fragment]);
    await writeFile(journal(), Buffer.concat([Buffer.from(prefix), tail]));
    expect((await store.readEvents("one")).map(value => value.seq)).toEqual([1]);
    await store.appendEvent("one", event(2));
    expect((await store.readEvents("one")).map(value => value.seq)).toEqual([1, 2]);
    const [artifact] = await readdir(path.join(dir, "sessions", "one", "recovery"));
    expect(await readFile(path.join(dir, "sessions", "one", "recovery", artifact!))).toEqual(tail);
  });

  it("does not replace or skip damaged UTF-8 before a line break", async () => {
    const raw = Buffer.concat([Buffer.from(JSON.stringify(event(1)) + "\n"), Buffer.from('{"seq":2,"text":"'), Buffer.from([0xd0]), Buffer.from('"}\n' + JSON.stringify(event(3)) + "\n")]);
    await writeFile(journal(), raw);
    await expect(store.readEvents("one")).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect(await readFile(journal())).toEqual(raw);
  });

  it.each(["", "\0\0"])("retains a complete final JSON event without a newline before %j", async tail => {
    await writeFile(journal(), JSON.stringify(event(1)) + tail);
    await store.appendEvent("one", event(2));
    expect((await store.readEvents("one")).map(e => e.seq)).toEqual([1, 2]);
  });

  it.each([
    JSON.stringify(event(1)) + "\n{bad}\n" + JSON.stringify(event(3)) + "\n",
    JSON.stringify(event(1)) + "\n" + JSON.stringify(event(1)) + "\n",
    JSON.stringify(event(2)) + "\n" + JSON.stringify(event(1)) + "\n",
    JSON.stringify(event(1)) + "\n{bad}",
  ])("isolates interior/conflicting corruption without making it a deletion", async raw => {
    await store.createSession(record("healthy")); await writeFile(journal(), raw);
    await expect(store.readEvents("one")).rejects.toMatchObject({ sessionId: "one", code: "session_storage_corrupt" });
    const inventory = await store.listRecordInventory();
    expect(inventory.records.map(r => r.id).sort()).toEqual(["healthy", "one"]);
    expect(inventory.unavailableIds).toEqual(["one"]);
    expect(inventory.records.find(r => r.id === "one")?.storageRecovery).toMatchObject({ state: "required" });
    await expect(store.appendEvent("one", event(4))).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect(await readFile(journal(), "utf8")).toBe(raw);
  });

  it("distinguishes absent records, corrupt records and missing acknowledged transcripts", async () => {
    expect(await store.readRecord("absent")).toBeNull();
    await writeFile(path.join(dir, "sessions", "one", "record.json"), "\0\0");
    await expect(store.readRecord("one")).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect((await store.listRecordInventory()).unavailableIds).toEqual(["one"]);
    await store.createSession(record("missing-events"));
    await writeFile(path.join(dir, "sessions", "missing-events", "record.json"), JSON.stringify({ ...record("missing-events"), lastEventSeq: 2 }));
    expect((await store.readRecord("missing-events"))?.storageRecovery).toMatchObject({ state: "required" });
  });

  it("refuses same-process tail repair when an acknowledged checkpoint references the damaged input", async () => {
    await store.appendEvent("one", event(1)); await store.appendEvent("one", event(2));
    await store.saveRecord({ ...record(), lastEventSeq: 2 });
    const damaged = JSON.stringify(event(1)) + '\n{"seq":2,"text":"torn';
    await writeFile(journal(), damaged);
    await expect(store.appendEvent("one", event(3), { after: 2 })).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect(await readFile(journal(), "utf8")).toBe(damaged);
    await expect(readdir(path.join(dir, "sessions", "one", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not turn a settled source write into rejection when a projection fails", async () => {
    const observer = vi.fn().mockRejectedValueOnce(new Error("synthetic projection failure")).mockResolvedValue(undefined);
    store.observeChanges(observer);
    await expect(store.appendEvent("one", event(1))).resolves.toBeUndefined();
    expect(store.projectionIssues()).toEqual([{ sessionId: "one", code: "history_projection_unavailable", message: expect.any(String) }]);
    await store.saveRecord(record());
    expect(store.projectionIssues()).toEqual([]);
  });

  it("keeps a deleted identity absent after a stale session folder is restored", async () => {
    await store.appendEvent("one", event(1));
    const originalRecord = await readFile(path.join(dir, "sessions", "one", "record.json"));
    const originalEvents = await readFile(journal());
    await store.deleteSession("one"); await store.deleteSession("one");
    await mkdir(path.join(dir, "sessions", "one"));
    await writeFile(path.join(dir, "sessions", "one", "record.json"), originalRecord); await writeFile(journal(), originalEvents);
    store = new SessionStore(dir);
    expect(await store.readRecord("one")).toBeNull(); expect(await store.readEvents("one")).toEqual([]);
    expect((await store.listRecordInventory()).records).toEqual([]);
    await expect(store.saveRecord(record())).rejects.toMatchObject({ code: "session_storage_corrupt" });
    await expect(store.appendEvent("one", event(2))).rejects.toMatchObject({ code: "session_storage_corrupt" });
    await expect(store.createSession(record())).rejects.toMatchObject({ code: "session_storage_corrupt" });
    const tombstone = JSON.parse(await readFile(path.join(dir, "session-deletions", "one.json"), "utf8"));
    expect(tombstone).toEqual({ version: 1, sessionId: "one" });
  });

  it("reports corrupt deletion evidence even when its source folder is absent", async () => {
    await store.deleteSession("one");
    await writeFile(path.join(dir, "session-deletions", "one.json"), "\0");
    store = new SessionStore(dir);
    await expect(store.readRecord("one")).rejects.toMatchObject({ code: "session_storage_corrupt" });
    expect((await store.listRecordInventory()).unavailableIds).toEqual(["one"]);
  });

  it("seals an uncertain append until reopening inspects its committed bytes", async () => {
    const append = persistence.durableAppendFile;
    vi.spyOn(persistence, "durableAppendFile").mockImplementationOnce(async (target, bytes) => {
      await append(target, bytes); throw new persistence.DurableWriteError(target, new Error("synthetic lost flush acknowledgement"));
    });
    await expect(store.appendEvent("one", event(1))).rejects.toMatchObject({ code: "session_storage_uncertain" });
    await expect(store.saveRecord(record())).rejects.toMatchObject({ code: "session_storage_uncertain" });
    expect((await store.readRecord("one"))?.storageRecovery).toMatchObject({ code: "session_storage_uncertain" });
    store = new SessionStore(dir);
    expect((await store.readRecord("one"))!.lastEventSeq).toBe(1);
    await store.appendEvent("one", event(2));
    expect((await store.readEvents("one")).map(e => e.seq)).toEqual([1, 2]);
  });
});
