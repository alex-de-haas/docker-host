import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../persistence.js", async original => {
  const actual = await original<typeof import("../persistence.js")>();
  return { ...actual, durableWriteFile: vi.fn(actual.durableWriteFile) };
});
import * as io from "../persistence.js";
import { HistoryStorage, type SourceConversation } from "./storage.js";
import { ExportCursors } from "./export-cursors.js";
const actual = await vi.importActual<typeof import("../persistence.js")>("../persistence.js");
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "hosty-history-storage-")); vi.mocked(io.durableWriteFile).mockReset().mockImplementation(actual.durableWriteFile); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const provider = { appId: "source", installationId: "installation", key: "default" };
function source(id: string, text: string): SourceConversation {
  const ref = { id, provider };
  return { metadata: { ref, revision: "1", ownerUserId: "owner", title: text, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", capabilities: [] },
    entries: [{ ref: { conversation: ref, id: "event-1" }, sequence: "1", revision: "1", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", actor: { kind: "user", id: "owner" }, data: { kind: "message", role: "user", parts: [{ type: "text", text, format: "plain" }], state: "complete" } }], fingerprint: "a".repeat(64), acl: 3 };
}
async function fixture() {
  const storage = new HistoryStorage(root), state = await storage.read();
  state.conversations.one = source("one", "first private payload"); state.conversations.two = source("two", "second private payload");
  state.sequence = 4; state.floor = 4;
  await storage.write(state); return { storage, state };
}
it("publishes payload-free authority and immutable per-conversation generations", async () => {
  const { storage, state } = await fixture(), initial = { ...state.partitions };
  expect(await readFile(path.join(storage.root, "manifest.json"), "utf8")).not.toContain("private payload");
  state.conversations.one!.metadata.title = "new title"; await storage.write(state);
  expect(state.partitions!.two).toEqual(initial.two); expect(state.partitions!.one).not.toEqual(initial.one);
  expect(await readdir(path.join(storage.root, "partitions"))).toHaveLength(2);
  expect((await new HistoryStorage(root).read()).conversations.one!.metadata.title).toBe("new title");
});
it("isolates one corrupt committed partition and preserves its reference during healthy writes", async () => {
  const { storage, state } = await fixture(), broken = state.partitions!.one!;
  await writeFile(path.join(storage.root, "partitions", `${broken.hash}.json`), "\0".repeat(30));
  const partial = await new HistoryStorage(root).read(); expect(partial.unavailable).toEqual(["one"]); expect(Object.keys(partial.conversations)).toEqual(["two"]);
  partial.conversations.two!.metadata.title = "healthy edit"; await storage.write(partial);
  const next = await new HistoryStorage(root).read(); expect(next.partitions!.one).toEqual(broken); expect(next.unavailable).toEqual(["one"]);
  expect(next.sequence).toBe(4); expect(next.conversations.two!.metadata.title).toBe("healthy edit");
});
it.each(["missing", "corrupt"])("fails closed for a %s authority manifest without restoring older generations", async mode => {
  const { storage } = await fixture(), manifest = path.join(storage.root, "manifest.json");
  if (mode === "missing") await rm(manifest); else await writeFile(manifest, "\0".repeat(50));
  await expect(new HistoryStorage(root).read()).rejects.toMatchObject({ code: "history_recovery_required", status: 503 });
  expect(await readdir(path.join(storage.root, "partitions"))).toHaveLength(2);
});
it.each([false, true])("reopens only the authoritative generation after an interrupted publication (published=%s)", async published => {
  const { storage, state } = await fixture(); state.conversations.one!.metadata.title = "candidate title";
  state.sequence = 5; state.changes.push({ sequence: "5", at: "2026-11-12T00:00:00Z", owner: "owner", conversation: "one", entry: "event-1", revision: "2", type: "upsert" });
  vi.mocked(io.durableWriteFile).mockImplementation(async (target, content) => {
    if (target.endsWith("manifest.json")) {
      if (published) await actual.durableWriteFile(target, content);
      throw new io.DurableWriteError(target, new Error("simulated lost acknowledgement"));
    }
    await actual.durableWriteFile(target, content);
  });
  await expect(storage.write(state)).rejects.toMatchObject({ code: "history_recovery_required" });
  await expect(storage.write(state)).rejects.toMatchObject({ code: "history_recovery_required" });
  const restarted = await new HistoryStorage(root).read();
  expect(restarted.conversations.one!.metadata.title).toBe(published ? "candidate title" : "first private payload");
  expect(restarted.sequence).toBe(published ? 5 : 4); expect(restarted.unavailable).toEqual([]);
});
it("starts a fresh format without importing legacy transcripts, access grants or cursor identity", async () => {
  const old = path.join(root, "conversation-history"); await mkdir(old);
  await writeFile(path.join(old, "state.json"), "legacy inaccessible private payload");
  const oldCursor = await new ExportCursors(old).issue("scope", "4");
  const storage = new HistoryStorage(root), state = await storage.read();
  expect(state.conversations).toEqual({}); expect(state.shares).toEqual([]); expect(state.sequence).toBe(0);
  const cursors = new ExportCursors(storage.root); await expect(cursors.read("scope", oldCursor)).rejects.toMatchObject({ code: "rescan_required" });
  const cursor = await cursors.issue("scope", "0"); expect(await new ExportCursors(storage.root).read("scope", cursor)).toBe(0);
});
it("refuses to initialize over interrupted publication evidence", async () => {
  const storage = new HistoryStorage(root); await mkdir(storage.root); await writeFile(path.join(storage.root, "manifest.json.interrupted.tmp"), "candidate");
  await expect(storage.read()).rejects.toMatchObject({ code: "history_recovery_required" });
});
