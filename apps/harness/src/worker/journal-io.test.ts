import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkerJournal } from "./journal.js";
import type { WorkerRunRequest } from "./contracts.js";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rename).mockReset().mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename);
  for (const action of cleanup.splice(0).reverse()) await action();
});
const request = (): WorkerRunRequest => ({ conversationId: "chat", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat" }, input: "test", options: {}, autoAllowedPrefixes: [] });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-journal-io-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(root); await journal.initialize();
  return journal;
}
it("retries a temporary Windows sharing violation without changing run identity or usage certainty", async () => {
  const journal = await fixture(), clock = vi.spyOn(performance, "now").mockReturnValue(0);
  await journal.accept("run", request()); await journal.update("run", "running");
  clock.mockReturnValue(1000);
  const before = vi.mocked(rename).mock.calls.length;
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
  await journal.sample("run");
  expect(vi.mocked(rename).mock.calls.length - before).toBe(2);
  expect((await journal.load("run")).receipt).toMatchObject({ state: "running", usage: { activeMs: 1000, unknown: false } });
});
it("does not lose elapsed usage when a sample cannot commit", async () => {
  const journal = await fixture(), clock = vi.spyOn(performance, "now").mockReturnValue(0);
  await journal.accept("run", request()); await journal.update("run", "running");
  clock.mockReturnValue(1000);
  vi.mocked(rename).mockRejectedValue(Object.assign(new Error("disk unavailable"), { code: "ENOSPC" }));
  await expect(journal.sample("run")).rejects.toMatchObject({ code: "ENOSPC" });
  expect((await journal.load("run")).receipt.usage?.activeMs).toBe(0);
  vi.mocked(rename).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename);
  clock.mockReturnValue(2000);
  await journal.sample("run");
  expect((await journal.load("run")).receipt.usage).toMatchObject({ activeMs: 2000, unknown: false });
});
