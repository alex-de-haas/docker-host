import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { FileHandle } from "node:fs/promises";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});
import * as fs from "node:fs/promises";
import { SessionStore, type SessionRecord } from "../sessions/store.js";
import { HistoryService } from "./service.js";
import { attachmentFile } from "./attachments.js";

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const provider = { appId: "independent.history", installationId: "installation", key: "history" };
const actor = { userId: "owner", principalId: "reader", hostRole: "host.admin" };
const bytes = Buffer.from("immutable accepted input ".repeat(2048));
const digest = createHash("sha256").update(bytes).digest("hex");
const revision = BigInt("0x" + digest.slice(0, 32)).toString();
let root: string, target: string, sessions: SessionStore, history: HistoryService, reads: number;
const record: SessionRecord = { id: "chat", createdBy: "owner", status: "idle", title: null, context: null,
  harnessSessionId: null, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastEventSeq: 0 };
const append = (seq: number, type: string, rest: Record<string, unknown>) => sessions.appendEvent(record.id, { seq, type, ts: record.createdAt, ...rest });
beforeEach(async () => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  root = await actual.mkdtemp(path.join(os.tmpdir(), "hosty-attachment-generation-")); sessions = new SessionStore(root);
  await sessions.createSession({ ...record, sourceAttachments: [{ id: "file", name: "proof.txt", digest, size: bytes.length }] });
  const directory = path.join(sessions.messageQueueDirectory(record.id), "files"); await actual.mkdir(directory, { recursive: true });
  target = path.join(directory, digest); await actual.writeFile(target, bytes); reads = 0;
  vi.mocked(fs.readFile).mockImplementation(async (...args) => { if (args[0] === target) reads++; return actual.readFile(...args); });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === target) {
      const read = handle.readFile.bind(handle);
      handle.readFile = ((...options: Parameters<FileHandle["readFile"]>) => { reads++; return read(...options); }) as FileHandle["readFile"];
    }
    return handle;
  });
  history = new HistoryService(sessions, provider);
});
afterEach(async () => { history.close(); vi.restoreAllMocks(); await actual.rm(root, { recursive: true, force: true }); });

it("does not reread immutable payloads for repeated history references and streaming source updates", async () => {
  await append(1, "user_message", { text: "inspect", attachments: ["proof.txt", "proof.txt"], attachmentDigests: { "proof.txt": digest } });
  await append(2, "user_message", { text: "inspect again", attachments: ["proof.txt"], attachmentDigests: { "proof.txt": digest } });
  for (let seq = 3; seq < 9; seq++) await append(seq, "assistant_text", { text: `stream frame ${seq}` });
  await history.read(actor, { conversation: { provider, id: record.id } });
  expect(reads).toBe(1);
  expect(await attachmentFile(sessions, record.id, "proof.txt", { revision, offset: 0, length: bytes.length }, digest)).toEqual(bytes);
  expect(reads).toBe(2);
});

it("revalidates a replaced physical generation and still verifies every actual payload read", async () => {
  await attachmentFile(sessions, record.id, "proof.txt", undefined, digest); expect(reads).toBe(1);
  const replacement = target + ".replacement"; await actual.writeFile(replacement, bytes); await actual.rename(replacement, target);
  await attachmentFile(sessions, record.id, "proof.txt", undefined, digest); expect(reads).toBe(2);
  await attachmentFile(sessions, record.id, "proof.txt", undefined, digest); expect(reads).toBe(2);
  await actual.writeFile(target, Buffer.alloc(bytes.length, 120));
  await expect(attachmentFile(sessions, record.id, "proof.txt", { revision, offset: 0, length: 1 }, digest)).rejects.toMatchObject({ code: "session_storage_corrupt" });
  expect(reads).toBe(3);
});

it("fences same-size corruption on metadata reconciliation and never treats a missing cached file as available", async () => {
  const exact = new Date("2026-11-12T00:00:00.000Z"); await actual.utimes(target, exact, exact);
  const before = await actual.stat(target, { bigint: true });
  await attachmentFile(sessions, record.id, "proof.txt", undefined, digest);
  await actual.writeFile(target, Buffer.alloc(bytes.length, 120)); await actual.utimes(target, exact, exact);
  const after = await actual.stat(target, { bigint: true });
  expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs);
  await expect(attachmentFile(sessions, record.id, "proof.txt", undefined, digest)).rejects.toMatchObject({ code: "session_storage_corrupt" });
  expect(reads).toBe(2);
  await actual.unlink(target);
  await expect(attachmentFile(sessions, record.id, "proof.txt", undefined, digest)).rejects.toMatchObject({ code: "session_storage_corrupt" });
});
