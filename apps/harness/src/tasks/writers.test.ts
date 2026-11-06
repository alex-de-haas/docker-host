import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "./store.js";
import { TaskWriters, writeScope, writerConflict } from "./writers.js";
import type { DevelopmentWorkspace } from "../sessions/development.js";
let dir: string, store: TaskStore, writers: TaskWriters, sources: DevelopmentWorkspace[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "task-writers-"));
  await mkdir(path.join(dir, "repo"));
  store = new TaskStore(dir, { appId: "arbitrary.runner", installationId: "one", key: "default" }); writers = new TaskWriters(store);
  sources = [{ id: "repo", path: path.join(dir, "repo") }] as DevelopmentWorkspace[];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it("serializes overlapping writers across independent roots while allowing disjoint paths", async () => {
  await store.writeJournal("write-scope:first", { mode: "write", paths: ["src/ui"] });
  await store.writeJournal("write-scope:second", { mode: "read", paths: ["src/ui/app.ts"] });
  await store.writeJournal("write-scope:third", { mode: "write", paths: ["src/backend"] });
  expect(await writers.reserve("root-one", "first", "one", "shared", sources)).toBe(true);
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(false);
  expect(await writers.reserve("root-two", "third", "three", "shared", sources)).toBe(true);
  await writers.observe("one", { executionId: "one", revision: 1, state: "interrupted", stopConfirmed: false, createdAt: "now", updatedAt: "now" });
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(false);
  await writers.observe("one", { executionId: "one", revision: 2, state: "awaiting_input", stopConfirmed: false, nativeStopConfirmed: true, createdAt: "now", updatedAt: "now" });
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(true);
});
it("makes broad writes and lockfiles exclusive and rejects traversal", () => {
  expect(writeScope(undefined).mode).toBe("exclusive");
  expect(writeScope({ mode: "write", paths: ["package-lock.json"] }).mode).toBe("exclusive");
  expect(() => writeScope({ mode: "write", paths: ["src/../../escape"] })).toThrow();
  expect(() => writeScope({ mode: "write", paths: ["C:/escape"] })).toThrow();
  expect(writerConflict({ mode: "read", paths: ["src"] }, { mode: "read", paths: ["src/file"] })).toBe(false);
});
it("rejects symlink escape before claiming a writer reservation", async () => {
  await mkdir(path.join(dir, "outside")); await symlink(path.join(dir, "outside"), path.join(dir, "repo", "link"));
  await store.writeJournal("write-scope:task", { mode: "write", paths: ["link/file"] });
  await expect(writers.reserve("root", "task", "attempt", "workspace", sources)).rejects.toMatchObject({ code: "write_scope_escape" });
  expect(await store.journalEntries("writer:")).toHaveLength(0);
});

it.each([
  ["src/.", "src", "src/file.ts"],
  ["./src/.", "src", "src/file.ts"],
  ["src/./nested/.", "src/nested", "src/nested/file.ts"],
])("normalizes %s before storing and comparing writer claims", async (declared, normalized, conflicting) => {
  await mkdir(path.join(sources[0]!.path, normalized), { recursive: true });
  await store.writeJournal("write-scope:first", { mode: "write", paths: [declared] });
  await store.writeJournal("write-scope:second", { mode: "write", paths: [conflicting] });
  expect(await writers.reserve("root-one", "first", "one", "shared", sources)).toBe(true);
  expect(await store.readJournal("writer:one")).toMatchObject({ scope: { mode: "write", paths: [normalized] } });
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(false);
});

it.each(["alias", "alias/not-created/file.ts"])("makes an internal symlink scope exclusive: %s", async prefix => {
  await mkdir(path.join(sources[0]!.path, "src"));
  await symlink("src", path.join(sources[0]!.path, "alias"));
  await store.writeJournal("write-scope:first", { mode: "write", paths: [prefix] });
  await store.writeJournal("write-scope:second", { mode: "write", paths: ["src/not-created/file.ts"] });
  expect(await writers.reserve("root-one", "first", "one", "shared", sources)).toBe(true);
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(false);
  expect(await store.readJournal("writer:one")).toMatchObject({ scope: { mode: "exclusive", paths: [] } });
});

it("still rejects an escaping prefix after encountering an internal symlink", async () => {
  await mkdir(path.join(sources[0]!.path, "src"));
  await mkdir(path.join(dir, "outside"));
  await symlink("src", path.join(sources[0]!.path, "alias"));
  await symlink(path.join(dir, "outside"), path.join(sources[0]!.path, "escape"));
  await store.writeJournal("write-scope:task", { mode: "write", paths: ["alias", "escape/new-file"] });
  await expect(writers.reserve("root", "task", "attempt", "shared", sources)).rejects.toMatchObject({ code: "write_scope_escape" });
  expect(await store.journalEntries("writer:")).toHaveLength(0);
});

it("makes a dangling symlink ancestor exclusive before its target is created", async () => {
  await symlink("future-src", path.join(sources[0]!.path, "alias"));
  await store.writeJournal("write-scope:first", { mode: "write", paths: ["alias/new-file.ts"] });
  await store.writeJournal("write-scope:second", { mode: "write", paths: ["future-src/new-file.ts"] });
  expect(await writers.reserve("root-one", "first", "one", "shared", sources)).toBe(true);
  expect(await writers.reserve("root-two", "second", "two", "shared", sources)).toBe(false);
});
