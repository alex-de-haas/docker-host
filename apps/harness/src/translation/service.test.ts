import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentConnections } from "../connections/registry.js";
import { SettingsStore } from "../settings/store.js";
import { parseTranslation, TranslationService } from "./service.js";
import { translationEnvironment, translationText, type TranslationOptions } from "./native.js";

let root: string, registry: AgentConnections, settings: SettingsStore, service: TranslationService;
let secrets: Map<string, string>;
const run = vi.fn(async (_runtime, input: string, _signal: AbortSignal, _options?: TranslationOptions) => JSON.parse(input).text.replaceAll("Read a book", "Прочитать книгу"));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "translation-test-"));
  secrets = new Map();
  registry = new AgentConnections(path.join(root, "data"), path.join(root, "cache"), {
    get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  settings = new SettingsStore(path.join(root, "settings"));
  run.mockClear(); service = new TranslationService(registry, settings, run);
});
afterEach(async () => { await registry.shutdown(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const input = { text: "# Read a book\n\n- [ ] D1. Read a book.\n", targetLanguage: "ru", format: "markdown" };
async function connect(kind: "codex" | "claude" = "codex") {
  const connection = await registry.update({ name: kind, kind, auth: "api-key", secret: "synthetic-only" });
  await service.configure(kind, connection.id); return connection;
}

it("requires explicit selection, stores both variants, and never follows the chat default", async () => {
  await expect(service.translate("codex", input, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
  const codex = await connect(), claude = await connect("claude");
  await registry.setDefault(claude.id);
  expect((await new SettingsStore(path.join(root, "settings")).read()).translationConnections).toMatchObject({ codex: { connectionId: codex.id }, claude: { connectionId: claude.id } });
  await expect(service.configure("codex", claude.id)).rejects.toMatchObject({ status: 400 });
  await expect(service.configure("codex", undefined)).rejects.toMatchObject({ status: 400 });
  await registry.update({ secret: "replacement" }, codex.id);
  expect(await service.capabilities("codex")).toMatchObject({ ready: false });
  await expect(service.translate("codex", input, new AbortController().signal)).rejects.toMatchObject({ code: "translation_connection_changed" });
  expect(run).not.toHaveBeenCalled();
});
it("translates a long Markdown plan in bounded segments and cleans isolated credentials", async () => {
  await connect();
  const text = "---\nsummary: Read a book\n---\n\n" + Array.from({ length: 800 }, (_, i) => `- [ ] D${i + 1}. Read a book.\n`).join("");
  const result = await service.translate("codex", { ...input, text }, new AbortController().signal);
  expect(result.text).toContain("summary: Read a book");
  expect(result.text).toContain("D800. Прочитать книгу.");
  expect(run.mock.calls.length).toBeGreaterThan(1);
  for (const [runtime, payload] of run.mock.calls) {
    expect([...JSON.parse(payload).text].length).toBeLessThanOrEqual(16000);
    expect(runtime.env).not.toHaveProperty("HOSTY_APP_SERVICE_TOKEN");
    await expect(readFile(path.join(runtime.home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readdir(path.join(root, "cache", "translation-runs"))).toEqual([]);
});
it("persists independent model IDs, preserves legacy defaults and supports an explicit reset", async () => {
  const codex = await connect(), claude = await connect("claude");
  await service.translate("codex", input, AbortSignal.timeout(5000));
  expect(run.mock.lastCall?.[3]).toEqual({ model: null });
  await service.configure("codex", codex.id, "custom-codex-model");
  await service.configure("claude", claude.id, "haiku");
  await service.configure("codex", codex.id); // Older clients only update the connection.
  expect((await new SettingsStore(path.join(root, "settings")).read()).translationModels)
    .toEqual({ codex: "custom-codex-model", claude: "haiku" });
  expect((await service.configuration()).variants.map(v => [v.key, v.model]))
    .toEqual([["codex", "custom-codex-model"], ["claude", "haiku"]]);
  await service.translate("codex", input, AbortSignal.timeout(5000));
  expect(run.mock.lastCall?.[3]).toEqual({ model: "custom-codex-model" });
  await service.translate("claude", input, AbortSignal.timeout(5000));
  expect(run.mock.lastCall?.[3]).toEqual({ model: "haiku" });
  await service.configure("codex", null, null);
  expect((await settings.read()).translationModels).toEqual({ codex: null, claude: "haiku" });
});
it.each(["", " ", "--model", "a\nb", "sonnet,haiku", "x".repeat(129), 42, {}])("rejects invalid model %j without changing settings", async model => {
  const c = await connect();
  await service.configure("codex", c.id, "gpt-6-luna");
  await expect(service.configure("codex", null, model)).rejects.toMatchObject({ code: "translation_model_invalid", status: 400 });
  expect((await settings.read()).translationModels?.codex).toBe("gpt-6-luna");
  expect((await settings.read()).translationConnections?.codex?.connectionId).toBe(c.id);
});
it("uses one model snapshot across segments and never retries another model after inference fails", async () => {
  const c = await connect();
  await service.configure("codex", c.id, "gpt-6-luna");
  run.mockImplementationOnce(async (_runtime, payload) => {
    await service.configure("codex", c.id, "gpt-6.1-sol");
    return JSON.parse(payload).text;
  });
  const text = Array.from({ length: 800 }, (_, i) => `- [ ] D${i + 1}. Read a book.\n`).join("");
  await service.translate("codex", { ...input, text }, AbortSignal.timeout(5000));
  expect(run.mock.calls.length).toBeGreaterThan(1);
  expect(run.mock.calls.every(call => call[3]?.model === "gpt-6-luna")).toBe(true);
  run.mockClear(); run.mockRejectedValueOnce(new Error("Synthetic model unavailable"));
  await expect(service.translate("codex", input, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "translation_failed" });
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.lastCall?.[3]).toEqual({ model: "gpt-6.1-sol" });
});
it("refuses changed task states rather than returning a corrupted plan", async () => {
  await connect(); run.mockImplementationOnce(async (_r, payload) => JSON.parse(payload).text.replace("[ ]", "[x]"));
  await expect(service.translate("codex", input, new AbortController().signal)).rejects.toMatchObject({ code: "translation_markdown_changed" });
});
it("releases the lease on cancellation and rejects concurrent inference/account replacement", async () => {
  const c = await connect();
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  run.mockImplementationOnce(async (_r, _p, signal) => { onStarted(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); });
  const controller = new AbortController();
  const pending = service.translate("codex", input, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "translation_cancelled" });
  await started;
  await expect(service.translate("codex", input, controller.signal)).rejects.toMatchObject({ status: 429 });
  await expect(registry.update({ secret: "new" }, c.id)).rejects.toMatchObject({ code: "provider_in_use" });
  await expect(registry.reserve((await registry.binding(c.id))!)).rejects.toMatchObject({ status: 409 });
  controller.abort(); await rejected;
  expect(await readdir(path.join(root, "cache", "translation-runs"))).toEqual([]);
  await expect(service.translate("codex", input, new AbortController().signal)).resolves.toMatchObject({ targetLanguage: "ru" });
});
it("does not race an active chat reservation", async () => {
  const c = await connect(); const release = await registry.reserve((await registry.binding(c.id))!);
  try { await expect(service.translate("codex", input, new AbortController().signal)).rejects.toMatchObject({ status: 429 }); }
  finally { release(); }
});
it("writes refreshed host credentials back and rejects account replacement during renewal", async () => {
  const host = path.join(root, "host"); await import("node:fs/promises").then(fs => fs.mkdir(host));
  const original = JSON.stringify({ OPENAI_API_KEY: "synthetic-host-key" });
  await writeFile(path.join(host, "auth.json"), original);
  const c = await registry.update({ name: "host", kind: "codex", auth: "host-login", hostDirectory: host });
  const binding = (await registry.binding(c.id))!;
  const refreshed = JSON.stringify({ OPENAI_API_KEY: "synthetic-host-key", last_refresh: "new" });
  await registry.withTranslationRuntime(binding, async runtime => { await writeFile(path.join(runtime.home, "auth.json"), refreshed); });
  expect(await readFile(path.join(host, "auth.json"), "utf8")).toBe(refreshed);
  await expect(registry.withTranslationRuntime(binding, async runtime => {
    await writeFile(path.join(host, "auth.json"), "replacement");
    await writeFile(path.join(runtime.home, "auth.json"), original);
  })).rejects.toMatchObject({ code: "translation_credentials_unavailable" });
  expect(await readFile(path.join(host, "auth.json"), "utf8")).toBe("replacement");
});
it.each([{}, { ...input, text: "" }, { ...input, targetLanguage: "ru; run shell" }, { ...input, format: "html" }, { ...input, tools: ["shell"] }, { ...input, text: "x".repeat(128001) }])("rejects malformed or oversized input", value => {
  expect(() => parseTranslation(value)).toThrow(); expect(run).not.toHaveBeenCalled();
});
it("bounds output and strips unrelated child credentials", () => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "private"); vi.stubEnv("ANTHROPIC_API_KEY", "other-account"); vi.stubEnv("CODEX_HOME", "/operator");
  expect(translationEnvironment()).not.toHaveProperty("HOSTY_APP_SERVICE_TOKEN");
  expect(translationEnvironment()).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(translationEnvironment()).not.toHaveProperty("CODEX_HOME");
  for (const value of [{ text: "" }, { text: "x", extra: true }, { text: "x".repeat(128001) }]) expect(() => translationText(value)).toThrow();
});
