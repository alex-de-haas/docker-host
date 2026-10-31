import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore, type SessionRecord, type StoredEvent } from "../sessions/store.js";
import { HistoryService, type HistoryActor } from "./service.js";
import type { HistoryShareCreate } from "@hosty-sdk/app/history";

const provider = { appId: "unrelated.harness.installation", installationId: "installation-one", key: "default" };
const owner: HistoryActor = { userId: "owner", principalId: "manual:owner", hostRole: "host.admin" };
const recipient: HistoryActor = { userId: "recipient", principalId: "oauth:recipient", hostRole: "host.admin" };
let root: string, sessions: SessionStore, history: HistoryService, now: number, record: SessionRecord;
const ref = () => ({ provider, id: record.id });
const entry = (seq: number) => ({ conversation: ref(), id: `event-${seq}` });
const event = async (seq: number, type: string, data: Record<string, unknown>) => sessions.appendEvent(record.id, { seq, type, ts: new Date(now + seq).toISOString(), ...data });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hosty-history-")); now = Date.parse("2026-10-31T12:00:00Z");
  sessions = new SessionStore(root); history = new HistoryService(sessions, provider, () => now);
  record = { id: randomUUID(), createdBy: owner.userId, title: "Private title", context: null, status: "idle", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), harnessSessionId: "secret-native", lastEventSeq: 0 };
  await sessions.createSession(record); await event(1, "user_message", { text: "public needle", attachments: ["private.txt"] });
  await event(2, "user_message", { text: "unselected secret" });
});
afterEach(async () => { history.close(); await rm(root, { recursive: true, force: true }); });
const share = async (extra: Partial<HistoryShareCreate> = {}) => history.share(owner, { ref: ref(), requestId: randomUUID(), expectedRevision: (await history.conversation(owner, ref())).revision,
  selection: { entryIds: [entry(1).id] }, recipientUserIds: [recipient.userId], includeAttachments: false, ...extra });

it("keeps other administrators out and excludes native state, tool inputs and account diagnostics", async () => {
  await expect(history.get(recipient, { entry: entry(1) })).rejects.toMatchObject({ code: "not_found", status: 404 });
  await expect(history.get({ ...owner, hostRole: "host.user" }, { entry: entry(1) })).rejects.toMatchObject({ status: 403 });
  await event(3, "tool_use", { toolName: "setup", toolUseId: "call-1", input: { password: "never-export" } });
  await event(4, "provider_usage", { accountToken: "never-export" });
  await event(5, "tool_result", { toolUseId: "call-1", output: "public output", status: "completed", truncated: true });
  const page = await history.read(owner, { conversation: ref() });
  expect(page.entries.map(e => e.data.kind)).toEqual(["message", "message", "tool_call", "tool_result"]);
  expect(page.entries[2]!.data).toMatchObject({ input: null, disclosure: "redacted" });
  expect(page.entries[3]!.data).toMatchObject({ disclosure: "truncated" });
  expect(JSON.stringify(page)).not.toContain("never-export"); expect(JSON.stringify(page)).not.toContain("secret-native");
  expect(page.coverage.state).toBe("partial");
});

it("shares only selected live entries without adjacent text, private title, attachments or private activity", async () => {
  await share();
  const initial = await history.conversation(recipient, ref());
  expect(initial.title).toBe("Shared conversation"); expect(initial.nativeSessions).toBeUndefined();
  const read = await history.read(recipient, { conversation: ref() });
  expect(read.entries).toHaveLength(1);
  expect(read.entries[0]!.data).toMatchObject({ parts: [{ type: "text", text: "public needle", format: "plain" }] });
  await expect(history.get(recipient, { entry: entry(2) })).rejects.toMatchObject({ code: "not_found" });
  expect((await history.search(recipient, { provider, q: "unselected" })).hits).toEqual([]);
  await event(3, "user_message", { text: "new private activity" });
  expect(await history.conversation(recipient, ref())).toEqual(initial);
  expect((await history.read(recipient, { conversation: ref() })).highWater).toBe(read.highWater);
  await expect(history.share(recipient, { ref: ref(), requestId: randomUUID(), expectedRevision: initial.revision, selection: { includeFutureEntries: true }, recipientUserIds: ["third"], includeAttachments: false })).rejects.toMatchObject({ status: 403 });
});

it("supports explicit future-inclusive sharing and exact replay across restart without repeating mutations", async () => {
  const request: HistoryShareCreate = { ref: ref(), requestId: randomUUID(), expectedRevision: (await history.conversation(owner, ref())).revision, selection: { includeFutureEntries: true }, recipientUserIds: [recipient.userId], includeAttachments: true, label: "Shared work" };
  const receipt = await history.share(owner, request);
  history.close(); history = new HistoryService(sessions, provider, () => now);
  expect(await history.share(owner, request)).toEqual(receipt);
  expect((await history.shares(owner, ref())).shares).toHaveLength(1);
  await expect(history.share(owner, { ...request, label: "changed" })).rejects.toMatchObject({ code: "request_conflict" });
  await event(3, "user_message", { text: "future entry" });
  expect((await history.get(recipient, { entry: entry(3) })).data).toMatchObject({ kind: "message" });
  expect((await history.conversation(recipient, ref())).title).toBe("Shared work");
});

it("binds snapshot cursors to principal/query/lifetime and rechecks revocation before returning bytes", async () => {
  const grant = await share({ selection: { includeFutureEntries: true } });
  const first = await history.read(recipient, { conversation: ref(), limit: 1 }); expect(first.nextCursor).not.toBeNull();
  const query = { conversation: ref(), limit: 1, cursor: first.nextCursor! };
  const second = await history.read(recipient, query); expect(second.entries[0]!.ref.id).toBe("event-2");
  expect(await history.read(recipient, query)).toEqual(second);
  await expect(history.read({ ...recipient, principalId: "other-client" }, query)).rejects.toMatchObject({ code: "cursor_expired" });
  await expect(history.read(recipient, { ...query, limit: 2 })).rejects.toMatchObject({ code: "cursor_expired" });
  await history.share(owner, { ref: ref(), grantId: grant.grant.id, requestId: randomUUID(), expectedRevision: (await history.conversation(owner, ref())).revision }, true);
  await expect(history.read(recipient, query)).rejects.toMatchObject({ code: "not_found" });
  expect((await history.search(recipient, { provider, q: "needle" })).hits).toEqual([]);
  const own = await history.read(owner, { conversation: ref(), limit: 1 }); now += 900001;
  await expect(history.read(owner, { conversation: ref(), limit: 1, cursor: own.nextCursor! })).rejects.toMatchObject({ code: "cursor_expired" });
});

it("removes deleted source payloads from the projection and all snapshots without waiting for another reader", async () => {
  await history.read(owner, { conversation: ref(), limit: 1 });
  expect((await readdir(history.storage.root)).some(f => f.startsWith("snapshot-"))).toBe(true);
  await sessions.deleteSession(record.id);
  for (const name of await readdir(history.storage.root)) {
    const text = await readFile(path.join(history.storage.root, name), "utf8");
    expect(text).not.toContain("public needle"); expect(text).not.toContain("unselected secret");
  }
  const state = await history.storage.read(); expect(state.changes.filter(c => c.type === "delete")).toHaveLength(2);
  expect(state.changes.every(c => !("payload" in c))).toBe(true);
  await expect(history.get(owner, { entry: entry(1) })).rejects.toMatchObject({ code: "not_found" });
});

it("keeps entry ordering identity while a streamed entry revision advances and normalizes literal source search", async () => {
  await event(3, "assistant_text", { text: "Straße " });
  const first = await history.get(owner, { entry: entry(3) });
  await event(4, "assistant_text", { text: "Σίσυφος" });
  const next = await history.get(owner, { entry: entry(3) });
  expect(next.sequence).toBe(first.sequence); expect(BigInt(next.revision)).toBeGreaterThan(BigInt(first.revision));
  await expect(history.get(owner, { entry: entry(3), expectedRevision: first.revision })).rejects.toMatchObject({ code: "revision_conflict" });
  const hits = await history.search(owner, { provider, q: "ＳＴＲＡＳＳＥ" }); expect(hits.hits).toHaveLength(1);
  expect(hits.hits[0]!.entry).toEqual(entry(3));
  expect((await history.search(owner, { provider, q: ".*" })).hits).toHaveLength(0);
});

it("admits one of two conflicting share revisions and treats decimal null options from Core as omitted", async () => {
  const request: HistoryShareCreate = { ref: ref(), requestId: randomUUID(), expectedRevision: (await history.conversation(owner, ref())).revision,
    selection: { includeFutureEntries: true }, recipientUserIds: [recipient.userId], includeAttachments: false };
  const results = await Promise.allSettled([history.share(owner, request), history.share(owner, { ...request, requestId: randomUUID() })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict" } });
  expect((await history.list(owner, { provider, title: null, cursor: null, limit: 50 } as unknown as Parameters<HistoryService["list"]>[1])).conversations).toHaveLength(1);
  expect((await history.read(owner, { conversation: ref(), kinds: null } as unknown as Parameters<HistoryService["read"]>[1])).entries).toHaveLength(2);
});

it("checks current attachment disclosure and file revision, refuses links and bounds source ranges", async () => {
  const { writeFile, symlink, unlink } = await import("node:fs/promises");
  history.close(); sessions = new SessionStore(root, path.join(root, "cache")); history = new HistoryService(sessions, provider, () => now);
  await sessions.ensureWorkspace(record.id);
  const file = sessions.attachmentPath(record.id, "private.txt")!; await writeFile(file, "attachment text");
  const current = await history.get(owner, { entry: entry(1) });
  const part = current.data.kind === "message" ? current.data.parts.find(p => p.type === "attachment")! : undefined;
  expect(part?.type).toBe("attachment"); if (part?.type !== "attachment") throw new Error("Missing attachment");
  const input = { entry: entry(1), attachmentId: "private.txt", revision: part.revision };
  expect(await history.attachment(owner, input)).toMatchObject({ name: "private.txt", sizeBytes: 15 });
  expect((await history.attachment(owner, { ...input, offset: 0, length: 10 }, true)).toString()).toBe("attachment");
  await expect(history.attachment(owner, { ...input, offset: 0, length: 1024 * 1024 + 1 }, true)).rejects.toMatchObject({ code: "invalid_range" });
  await share(); await expect(history.attachment(recipient, input)).rejects.toMatchObject({ code: "not_found" });
  await writeFile(file, "changed"); await expect(history.attachment(owner, input)).rejects.toMatchObject({ code: "not_found" });
  await unlink(file); await writeFile(path.join(root, "outside.txt"), "outside secret"); await symlink(path.join(root, "outside.txt"), file);
  const absent = await history.get(owner, { entry: entry(1) });
  const absentPart = absent.data.kind === "message" ? absent.data.parts.find(p => p.type === "attachment") : undefined;
  await expect(history.attachment(owner, { ...input, revision: absentPart?.type === "attachment" ? absentPart.revision : "1" })).rejects.toMatchObject({ code: "not_found" });
});

it("exports only an approved owned partition and supplies deletion changes without retaining old payloads", async () => {
  const invocation = { ...owner, version: 2 as const, callerAppId: null, callerInstallation: null, kind: "conversation-history" as const,
    key: provider.key, operation: "exports.snapshot", resourceIds: [], export: { grantId: "approved", revision: "1", ownerUserId: owner.userId, provider, conversationIds: [record.id] } };
  const snapshot = await history.export(invocation, { scope: invocation.export }, false);
  expect("entries" in snapshot && snapshot.entries).toHaveLength(2);
  if (!("changeCursor" in snapshot)) throw new Error("Missing snapshot");
  await event(3, "assistant_text", { text: "will be deleted" });
  await sessions.deleteSession(record.id);
  const changes = await history.export({ ...invocation, operation: "exports.changes" }, { scope: invocation.export, cursor: snapshot.changeCursor }, true);
  expect("changes" in changes && changes.changes.some(c => c.type === "delete")).toBe(true);
  let delivered = false; await history.deliver(owner, changes, () => { delivered = true; }); expect(delivered).toBe(true);
  expect(JSON.stringify(changes)).not.toContain("will be deleted");
  expect(JSON.stringify(changes)).not.toContain("public needle");
  await expect(history.export(invocation, { scope: { ...invocation.export, conversationIds: null } }, false)).rejects.toMatchObject({ code: "permission_denied" });
  const unapproved = { ...invocation, export: null };
  await expect(history.export(unapproved, { scope: invocation.export }, false)).rejects.toMatchObject({ code: "permission_denied" });
});

it("does not export shared-to-me history and preserves stable cursor binding across consent revision acknowledgements", async () => {
  await share({ selection: { includeFutureEntries: true } });
  const invocation = { ...recipient, version: 2 as const, callerAppId: null, callerInstallation: null, kind: "conversation-history" as const,
    key: provider.key, operation: "exports.snapshot", resourceIds: [], export: { grantId: "recipient-approved", revision: "1", ownerUserId: recipient.userId, provider, conversationIds: null } };
  const snapshot = await history.export(invocation, { scope: invocation.export }, false);
  expect("entries" in snapshot && snapshot.entries).toEqual([]);
  if (!("changeCursor" in snapshot)) throw new Error("Missing snapshot");
  const next = { ...invocation, export: { ...invocation.export, revision: "2" } };
  expect(await history.export(next, { scope: next.export, cursor: snapshot.changeCursor }, true)).toMatchObject({ changes: [] });
  await expect(history.export({ ...next, principalId: "another-consumer" }, { scope: next.export, cursor: snapshot.changeCursor }, true)).rejects.toMatchObject({ code: "rescan_required" });
});

it("returns an explicit rescan after a retained change gap instead of pretending the old index is current", async () => {
  const invocation = { ...owner, version: 2 as const, callerAppId: null, callerInstallation: null, kind: "conversation-history" as const,
    key: provider.key, operation: "exports.snapshot", resourceIds: [], export: { grantId: "approved", revision: "1", ownerUserId: owner.userId, provider, conversationIds: null } };
  const snapshot = await history.export(invocation, { scope: invocation.export }, false);
  if (!("changeCursor" in snapshot)) throw new Error("Missing snapshot");
  await event(3, "user_message", { text: "later" }); now += 8 * 86400000;
  await expect(history.export(invocation, { scope: invocation.export, cursor: snapshot.changeCursor }, true)).rejects.toMatchObject({ code: "rescan_required" });
});


it("scopes live notifications to visible entry IDs and rechecks sharing on reconnect", async () => {
  const grant = await share();
  const first = await history.notifications(recipient, { conversation: ref(), waitSeconds: 0 });
  expect(first.rescanRequired).toBe(true);
  await event(3, "user_message", { text: "private new message" });
  const hidden = await history.notifications(recipient, { conversation: ref(), cursor: first.cursor, waitSeconds: 0 });
  expect(hidden.changes).toEqual([]); expect(hidden.revision).toBe(first.revision);
  expect(hidden.rescanRequired).toBe(false);
  const another = await history.notifications({ ...recipient, principalId: "another-client" }, { conversation: ref(), cursor: hidden.cursor, waitSeconds: 0 });
  expect(another.rescanRequired).toBe(true);
  await history.share(owner, { ref: ref(), grantId: grant.grant.id, requestId: randomUUID(), expectedRevision: (await history.conversation(owner, ref())).revision }, true);
  await expect(history.notifications(recipient, { conversation: ref(), cursor: hidden.cursor, waitSeconds: 0 })).rejects.toMatchObject({ code: "not_found" });
});

it("wakes a bounded live wait on source writes and serves no transcript in notification data", async () => {
  const first = await history.notifications(owner, { conversation: ref(), waitSeconds: 0 });
  const waiting = history.notifications(owner, { conversation: ref(), cursor: first.cursor, waitSeconds: 20 });
  await event(3, "user_message", { text: "new text stays at source" });
  const change = await waiting;
  expect(change.changes).toEqual([{ type: "upsert", entryId: "event-3", revision: "1" }]);
  expect(JSON.stringify(change)).not.toContain("new text stays at source");
  let delivered = false; await history.deliver(owner, change, () => { delivered = true; }); expect(delivered).toBe(true);
});

it("invalidates shared continuations and pending delivery when overlapping disclosure expires", async () => {
  await event(3, "user_message", { text: "later shared needle", attachments: ["private.txt"] });
  await share({ selection: { includeFutureEntries: true } });
  await share({ selection: { includeFutureEntries: true }, includeAttachments: true, expiresAt: new Date(now + 1000).toISOString(), label: "Temporary attachment access" });
  const first = await history.read(recipient, { conversation: ref(), limit: 1 });
  expect(first.nextCursor).toBeTruthy();
  const pending = await history.get(recipient, { entry: entry(3) });
  expect(pending.data).toMatchObject({ kind: "message", parts: expect.arrayContaining([expect.objectContaining({ type: "attachment" })]) });
  now += 1001;
  await expect(history.read(recipient, { conversation: ref(), limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "cursor_expired" });
  let delivered = false;
  await expect(history.deliver(recipient, pending, () => { delivered = true; })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(delivered).toBe(false);
  const current = await history.get(recipient, { entry: entry(3) });
  expect(current.data).toMatchObject({ kind: "message", parts: [{ type: "text", text: "later shared needle" }] });
  await history.deliver(recipient, current, () => { delivered = true; }); expect(delivered).toBe(true);
});
