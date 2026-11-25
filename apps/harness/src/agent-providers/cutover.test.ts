import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCleanProviderCutover, openProviderStore } from "./cutover.js";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const value = await publicProviderFixture(); fixtures.push(value); return value; }

it("accepts an empty installation and new public consumer conversations", async () => {
  const f = await fixture();
  await expect(assertCleanProviderCutover(f.store)).resolves.toBeUndefined();
  const record = await f.manager.createSession({ createdBy: f.owner });
  expect(record).toMatchObject({ agentConsumerVersion: 2, selection: f.selection });
  await expect(assertCleanProviderCutover(f.store)).resolves.toBeUndefined();
});

it("rejects legacy records without copying, adopting or deleting transcript/native history", async () => {
  const f = await fixture(), id = randomUUID(), now = new Date().toISOString();
  await f.store.createSession({ id, status: "idle", createdAt: now, updatedAt: now, createdBy: f.owner, harnessSessionId: "legacy-native-session",
    title: null, context: null, lastEventSeq: 0, harnessKind: "codex", connectionId: "legacy", connectionRevision: 1, retentionVersion: 1 });
  await f.store.appendEvent(id, { seq: 1, ts: now, type: "assistant_text", text: "Retained legacy history" });
  const native = path.join(f.root, "native-history"); await mkdir(native); await writeFile(path.join(native, "history.json"), "retained native bytes");
  const recordPath = path.join(f.store.dataDir, "sessions", id, "record.json"), before = await readFile(recordPath);
  await expect(assertCleanProviderCutover(f.store)).rejects.toThrow("provider cutover is required");
  expect(await readFile(recordPath)).toEqual(before);
  expect((await f.store.readEvents(id)).map(event => event.text)).toEqual(["Retained legacy history"]);
  expect(await readFile(path.join(native, "history.json"), "utf8")).toBe("retained native bytes");
  expect(f.starts).toEqual([]);
});

it("fails closed when the conversation inventory contains an unreadable legacy record", async () => {
  const f = await fixture(), id = randomUUID(), directory = path.join(f.store.dataDir, "sessions", id);
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "record.json"), "{invalid");
  await expect(assertCleanProviderCutover(f.store)).rejects.toThrow();
  expect(await readFile(path.join(directory, "record.json"), "utf8")).toBe("{invalid");
  expect(f.starts).toEqual([]);
});
it("preserves per-conversation damage isolation after the first verified cutover", async () => {
  const f = await fixture();
  await assertCleanProviderCutover(f.store);
  const healthy = await f.manager.createSession({ createdBy: f.owner });
  const id = randomUUID(), directory = path.join(f.store.dataDir, "sessions", id);
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "record.json"), "{damaged");
  await expect(assertCleanProviderCutover(f.store)).resolves.toBeUndefined();
  expect((await f.store.listRecordInventory()).unavailableIds).toContain(id);
  expect((await f.manager.getSession(healthy.id))?.id).toBe(healthy.id);
  expect(await readFile(path.join(directory, "record.json"), "utf8")).toBe("{damaged");
});

it("refuses a restored legacy record even after the installation cutover was verified", async () => {
  const f = await fixture(), id = randomUUID(), now = new Date().toISOString();
  await assertCleanProviderCutover(f.store);
  await f.store.createSession({ id, status: "idle", createdAt: now, updatedAt: now, createdBy: f.owner,
    harnessSessionId: "restored-native-session", title: null, context: null, lastEventSeq: 0, harnessKind: "codex", retentionVersion: 1 });
  await expect(assertCleanProviderCutover(f.store)).resolves.toBeUndefined();
  await expect(f.manager.postMessage(id, "Must not import or execute", f.credential, [], { actorUserId: f.owner }))
    .rejects.toMatchObject({ code: "provider_cutover_required" });
  expect(f.starts).toEqual([]);
  expect(await f.store.readEvents(id)).toEqual([]);
  expect((await f.store.readRecord(id))?.harnessSessionId).toBe("restored-native-session");
});

it("creates an empty v2 conversation namespace beside a drained v1 installation without altering its settings or chats", async () => {
  const f = await fixture(), now = new Date().toISOString(), id = randomUUID(), root = f.store.dataDir;
  await f.store.createSession({ id, status: "idle", createdAt: now, updatedAt: now, createdBy: f.owner,
    harnessSessionId: null, title: "Archived", lastEventSeq: 0, context: null, retentionVersion: 1 });
  await writeFile(path.join(root, "agent-consumer-format.json"), '{"version":1}');
  await writeFile(path.join(root, "settings.json"), "existing-settings");
  const oldFile = path.join(root, "sessions", id, "record.json"), before = await readFile(oldFile);
  const store = await openProviderStore(root, null);
  expect(store.dataDir).toBe(path.join(root, "execution-v2"));
  expect(await store.listRecords()).toEqual([]);
  expect(await readFile(oldFile)).toEqual(before);
  expect(await readFile(path.join(root, "settings.json"), "utf8")).toBe("existing-settings");
  expect((await openProviderStore(root, null)).dataDir).toBe(store.dataDir);
});

it("defers cutover of a marked v1 store until its recorded writer drains", async () => {
  const f = await fixture(), now = new Date().toISOString(), id = randomUUID(), root = f.store.dataDir;
  await f.store.createSession({ id, status: "running", createdAt: now, updatedAt: now, createdBy: f.owner,
    harnessSessionId: null, title: "Still running", lastEventSeq: 0, context: null, retentionVersion: 1 });
  await writeFile(path.join(root, "agent-consumer-format.json"), '{"version":1}');
  await expect(openProviderStore(root, null)).rejects.toThrow("unconfirmed writer");
  await expect(readFile(path.join(root, "execution-v2", "agent-consumer-format.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.store.readRecord(id))?.status).toBe("running");
});
