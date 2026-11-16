import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerJournal } from "./journal.js";
import type { WorkerRunRequest } from "./contracts.js";
import * as persistence from "../persistence.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const action of cleanup.splice(0).reverse()) await action(); });
const request: WorkerRunRequest = { conversationId: "chat", binding: { connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat" }, input: "synthetic", options: {}, autoAllowedPrefixes: [] };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-journal-corrupt-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(root); await journal.initialize();
  return { root, journal };
}
it.each(["\0".repeat(24), "{", JSON.stringify({ version: 1 })])("isolates an unreadable run without forgetting its identity (%j)", async content => {
  const { root, journal } = await fixture();
  await journal.accept("healthy", request); await journal.update("healthy", "running");
  await writeFile(path.join(root, "damaged.json"), content);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const reopened = new WorkerJournal(root); await reopened.initialize();
  expect((await reopened.load("healthy")).receipt.state).toBe("interrupted");
  expect((await reopened.accept("healthy", request)).fresh).toBe(false);
  await expect(reopened.load("damaged")).rejects.toMatchObject({ status: 503, code: "run_storage_unavailable" });
  await expect(reopened.accept("damaged", request)).rejects.toMatchObject({ code: "run_storage_unavailable" });
  await expect(reopened.prune()).resolves.toBeUndefined();
  expect(await readFile(path.join(root, "damaged.json"), "utf8")).toBe(content);
  expect(warning).toHaveBeenCalledWith("[worker] Retained execution requires storage recovery.", { runId: "damaged", code: "run_storage_unavailable" });
  expect((await reopened.accept("unrelated", { ...request, conversationId: "another" })).fresh).toBe(true);
});
it("seals a run's writes after an uncertain persistence outcome without blocking another run", async () => {
  const { root, journal } = await fixture();
  vi.spyOn(persistence, "durableWriteFile").mockRejectedValueOnce(new persistence.DurableWriteError(path.join(root, "uncertain.json"), new Error("synthetic sync failure")));
  await expect(journal.accept("uncertain", request)).rejects.toMatchObject({ uncertain: true });
  await expect(journal.accept("uncertain", request)).rejects.toMatchObject({ code: "run_storage_uncertain" });
  expect((await journal.accept("healthy", request)).fresh).toBe(true);
});
it("does not report successful acceptance after publication returned an uncertain outcome", async () => {
  const { root, journal } = await fixture(), write = persistence.durableWriteFile;
  vi.spyOn(persistence, "durableWriteFile").mockImplementationOnce(async (target, bytes) => {
    await write(target, bytes);
    throw new persistence.DurableWriteError(target, new Error("synthetic directory flush failure"));
  });
  await expect(journal.accept("published", request)).rejects.toMatchObject({ uncertain: true });
  expect(JSON.parse(await readFile(path.join(root, "published.json"), "utf8")).receipt.state).toBe("accepted");
  await expect(journal.accept("published", request)).rejects.toMatchObject({ code: "run_storage_uncertain" });
  const reopened = new WorkerJournal(root); await reopened.initialize();
  expect((await reopened.accept("published", request))).toMatchObject({ fresh: false, receipt: { state: "interrupted" } });
});
