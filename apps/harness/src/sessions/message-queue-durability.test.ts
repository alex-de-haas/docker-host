import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
import * as fs from "node:fs/promises";
import { SessionStore, type SessionRecord } from "./store.js";
import { MessageQueue } from "./message-queue.js";

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string, store: SessionStore, queue: MessageQueue, record: SessionRecord, synced: string[];
beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  root = await actual.mkdtemp(path.join(os.tmpdir(), "hosty-queue-directory-"));
  store = new SessionStore(root, path.join(root, "cache")); queue = new MessageQueue(store);
  record = { id: "chat", createdBy: "owner", status: "idle", title: null, context: null, harnessSessionId: null,
    createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastEventSeq: 0 };
  await store.createSession(record); synced = [];
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "r") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); synced.push(String(args[0])); };
    }
    return handle;
  });
});
afterEach(async () => { vi.restoreAllMocks(); await actual.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32").each(["upload", "workspace snapshot"])("flushes the new queue entry in its session parent before acknowledging first %s", async mode => {
  if (mode === "upload") await queue.upload(record, randomUUID(), "input.txt", Readable.from(["accepted bytes"]));
  else {
    const workspace = (await store.ensureWorkspace(record.id))!;
    await actual.writeFile(path.join(workspace, "input.txt"), "accepted bytes");
    await queue.retainAcceptedAttachments(record, ["input.txt"]);
  }
  const queueDirectory = store.messageQueueDirectory(record.id), sessionDirectory = path.dirname(queueDirectory);
  const files = synced.indexOf(path.join(queueDirectory, "files")), parent = synced.indexOf(queueDirectory), session = synced.indexOf(sessionDirectory);
  expect(files).toBeGreaterThanOrEqual(0); expect(parent).toBeGreaterThan(files); expect(session).toBeGreaterThan(parent);
});

it.skipIf(process.platform === "win32")("does not acknowledge a first upload when its new queue entry cannot be flushed in the session directory", async () => {
  const sessionDirectory = path.dirname(store.messageQueueDirectory(record.id));
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "r" && String(args[0]) === sessionDirectory)
      handle.sync = async () => { throw Object.assign(new Error("Parent directory flush failed"), { code: "EIO" }); };
    return handle;
  });
  await expect(queue.upload(record, randomUUID(), "input.txt", Readable.from(["must not acknowledge"])))
    .rejects.toMatchObject({ code: "session_storage_uncertain" });
  expect(store.recoveryIssues()).toContainEqual(expect.objectContaining({ sessionId: record.id, code: "session_storage_uncertain" }));
});

it.skipIf(process.platform === "win32")("flushes the session boundary again when retrying an upload after uncertain directory creation and store reopen", async () => {
  const sessionDirectory = path.dirname(store.messageQueueDirectory(record.id)), uploadId = randomUUID();
  let failParent = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle);
    if (args[1] === "r") handle.sync = async () => {
      if (String(args[0]) === sessionDirectory && failParent) {
        failParent = false; throw Object.assign(new Error("Uncertain queue directory creation"), { code: "EIO" });
      }
      await sync(); synced.push(String(args[0]));
    };
    return handle;
  });
  await expect(queue.upload(record, uploadId, "input.txt", Readable.from(["accepted bytes"])))
    .rejects.toMatchObject({ code: "session_storage_uncertain" });
  store = new SessionStore(root, path.join(root, "cache")); queue = new MessageQueue(store);
  record = (await store.readRecord(record.id))!; synced = [];
  await expect(queue.upload(record, uploadId, "input.txt", Readable.from(["accepted bytes"]))).resolves.toMatchObject({ id: uploadId });
  expect(synced).toContain(sessionDirectory);
});


it.skipIf(process.platform === "win32").each(["blob", "receipt"])("refuses a sealed upload retry and settles the retained %s publication after reopen", async stage => {
  const uploadId = randomUUID(), bytes = "accepted bytes", directory = store.messageQueueDirectory(record.id);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const publicationDirectory = path.join(directory, stage === "blob" ? "files" : "uploads");
  const target = path.join(publicationDirectory, stage === "blob" ? digest : uploadId + ".json");
  let failPublication = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle);
    if (args[1] === "r") handle.sync = async () => {
      if (String(args[0]) === publicationDirectory && failPublication
        && await actual.stat(target).then(() => true, () => false)) {
        failPublication = false; throw Object.assign(new Error("Published entry flush is uncertain"), { code: "EIO" });
      }
      await sync(); synced.push(String(args[0]));
    };
    return handle;
  });
  const upload = () => queue.upload(record, uploadId, "input.txt", Readable.from([bytes]));
  await expect(upload()).rejects.toMatchObject({ code: "session_storage_uncertain" });
  const sealedRetry = await upload().then(value => ({ accepted: value }), error => ({ error }));
  store = new SessionStore(root, path.join(root, "cache")); queue = new MessageQueue(store);
  record = (await store.readRecord(record.id))!; synced = [];
  await expect(upload()).resolves.toMatchObject({ id: uploadId, name: `q-${uploadId}-input.txt`, size: Buffer.byteLength(bytes) });
  expect(sealedRetry).toMatchObject({ error: { code: "session_storage_uncertain" } });
  expect(synced).toContain(publicationDirectory);
  expect(synced).toContain(path.dirname(directory));
});
