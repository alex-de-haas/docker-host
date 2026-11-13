import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PromptTemplateStore } from "./store.js";
import type { PromptTemplate } from "./types.js";

let directory: string, store: PromptTemplateStore;
const template = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({ id: randomUUID(), name: "Pull request", shortcut: "pr", text: "Review the changes.", ...overrides });
const save = (revision: number, templates: PromptTemplate[]) => ({ revision, requestId: randomUUID(), templates });
const file = (user = "owner") => path.join(directory, "preferences", "prompt-templates", createHash("sha256").update(user).digest("hex") + ".json");
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "harness-prompt-templates-")); store = new PromptTemplateStore(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("starts empty without a write and persists create, edit and delete across reopening", async () => {
  expect(await store.read("owner")).toEqual({ revision: 0, templates: [] });
  expect(await readdir(directory)).toEqual([]);
  const entry = template({ name: " Обзор ", shortcut: "PR", text: " \nПривет @literal /literal\n\t " });
  const first = await store.save("owner", save(0, [entry]));
  expect(first).toEqual({ revision: 1, templates: [{ ...entry, name: "Обзор", shortcut: "pr" }] });
  store = new PromptTemplateStore(directory);
  expect(await store.read("owner")).toEqual(first);
  const edited = await store.save("owner", save(1, [{ ...first.templates[0]!, text: "Changed" }]));
  expect(edited.templates[0]?.text).toBe("Changed");
  await store.save("owner", save(edited.revision, []));
  expect(await new PromptTemplateStore(directory).read("owner")).toEqual({ revision: 3, templates: [] });
});

it("isolates users and derives safe paths from authenticated user IDs", async () => {
  const entry = template();
  await store.save("owner", save(0, [entry]));
  expect(await store.read("other")).toEqual({ revision: 0, templates: [] });
  await store.save("../../other", save(0, [{ ...entry, text: "Other owner's prompt" }]));
  expect((await store.read("owner")).templates).toEqual([entry]);
  expect((await store.read("../../other")).templates[0]?.text).toBe("Other owner's prompt");
  expect(await readdir(path.dirname(file()))).toHaveLength(2);
});

it("serializes concurrent edits so a stale view cannot overwrite a successful save", async () => {
  const outcomes = await Promise.allSettled([store.save("owner", save(0, [template()])), store.save("owner", save(0, []))]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  expect(rejected).toMatchObject({ reason: { status: 409, code: "prompt_templates_changed" } });
  expect((await store.read("owner")).revision).toBe(1);
});

it("reconciles an uncertain save after restart without undoing newer edits or writing again", async () => {
  const request = save(0, [template()]);
  await store.save("owner", request);
  const latest = await store.save("owner", save(1, [template({ shortcut: "new", text: "Newer change" })]));
  const persisted = await readFile(file(), "utf8");
  await utimes(file(), new Date(0), new Date(0));
  const modified = (await stat(file())).mtimeMs;
  store = new PromptTemplateStore(directory);
  expect(await store.save("owner", request)).toEqual(latest);
  expect(await readFile(file(), "utf8")).toBe(persisted);
  expect((await stat(file())).mtimeMs).toBe(modified);
  await expect(store.save("owner", { ...request, templates: [] })).rejects.toMatchObject({ status: 409, code: "prompt_template_request_reused" });
  await expect(store.save("owner", save(0, []))).rejects.toMatchObject({ status: 409, code: "prompt_templates_changed" });
  expect(await store.read("owner")).toEqual(latest);
});

it("retains a bounded durable replay window and accepts request key order changes", async () => {
  const first = save(0, [template()]);
  await store.save("owner", first);
  const reordered = { templates: first.templates.map(entry => ({ text: entry.text, shortcut: entry.shortcut, name: entry.name, id: entry.id })), requestId: first.requestId, revision: 0 };
  expect((await store.save("owner", reordered)).revision).toBe(1);
  for (let revision = 1; revision <= 32; revision++) await store.save("owner", save(revision, []));
  const persisted = JSON.parse(await readFile(file(), "utf8")) as { receipts: { requestId: string }[] };
  expect(persisted.receipts).toHaveLength(32);
  expect(persisted.receipts.some(receipt => receipt.requestId === first.requestId)).toBe(false);
  await expect(store.save("owner", first)).rejects.toMatchObject({ code: "prompt_templates_changed" });
});

it("rejects malformed, duplicate and over-limit input without changing the library", async () => {
  const entry = template();
  const cases: unknown[] = [null, {}, save(-1, []), { ...save(0, []), requestId: "not-a-uuid" },
    { ...save(0, []), ownerId: "someone-else" }, save(0, [entry, { ...entry, shortcut: "other" }]),
    save(0, [entry, template({ shortcut: "PR" })]), save(0, [template({ id: "invalid" })]),
    save(0, [template({ name: " " })]), save(0, [template({ name: "n".repeat(121) })]),
    save(0, [template({ shortcut: "!pr" })]), save(0, [template({ shortcut: "p".repeat(41) })]),
    save(0, [template({ shortcut: "пр" })]), save(0, [template({ text: " \n\t" })]),
    save(0, [template({ text: "p".repeat(16001) })]), save(0, [{ ...entry, ownerId: "other" } as PromptTemplate]),
    save(0, Array.from({ length: 101 }, (_, index) => template({ shortcut: "p" + index }))),
    save(0, Array.from({ length: 12 }, (_, index) => template({ shortcut: "p" + index, text: "界".repeat(16000) })))];
  for (const input of cases) expect(() => store.save("owner", input)).toThrow(expect.objectContaining({ code: "prompt_templates_invalid" }));
  expect(await store.read("owner")).toEqual({ revision: 0, templates: [] });
  expect(await readdir(directory)).toEqual([]);
});

it("never replaces an unreadable or malformed persisted library", async () => {
  await mkdir(path.dirname(file()), { recursive: true });
  for (const broken of ["{broken", JSON.stringify({ version: 1, revision: 1, templates: [], receipts: [{ requestId: randomUUID(), hash: "bad", revision: 1 }] })]) {
    await writeFile(file(), broken);
    await expect(store.read("owner")).rejects.toThrow();
    await expect(store.save("owner", save(0, []))).rejects.toThrow();
    expect(await readFile(file(), "utf8")).toBe(broken);
  }
});
