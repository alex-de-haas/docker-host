// Run from the repository root with node --import tsx. Credentials stay in memory/private profiles.
// --kind codex --host-home /path/to/.codex --model gpt-6-luna --plan /tmp/synthetic-plan.md --repeat 2
// Claude uses ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from the invoking environment.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AgentConnections, type ConnectionBinding } from "../../../apps/harness/src/connections/registry.js";
import { SettingsStore } from "../../../apps/harness/src/settings/store.js";
import { TranslationService, TIMEOUT_SECONDS } from "../../../apps/harness/src/translation/service.js";
import { runTranslation, type TranslationRuntime, type TranslationTiming } from "../../../apps/harness/src/translation/native.js";

class MeasuredConnections extends AgentConnections {
  preparationMilliseconds = 0;
  cleanupMilliseconds = 0;
  override async withTranslationRuntime<T>(binding: ConnectionBinding, action: (runtime: TranslationRuntime) => Promise<T>): Promise<T> {
    const start = performance.now();
    let actionEnded: number | undefined;
    try {
      return await super.withTranslationRuntime(binding, async runtime => {
        this.preparationMilliseconds = performance.now() - start;
        try { return await action(runtime); } finally { actionEnded = performance.now(); }
      });
    } finally { this.cleanupMilliseconds = actionEnded === undefined ? 0 : performance.now() - actionEnded; }
  }
}

const { values } = parseArgs({ options: {
  kind: { type: "string", default: "codex" }, "host-home": { type: "string" },
  plan: { type: "string" }, repeat: { type: "string", default: "2" }, output: { type: "string" },
  "include-output": { type: "boolean", default: false },
  model: { type: "string" }, "continue-on-error": { type: "boolean", default: false },
} });
if (!values.plan || !["codex", "claude"].includes(values.kind!)) throw new Error("Supply --kind and --plan.");
const repeats = Number(values.repeat);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Repeat must be 1–10.");
const root = await mkdtemp(path.join(os.tmpdir(), "hosty-translation-benchmark-"));
const secrets = new Map<string, string>();
const registry = new MeasuredConnections(path.join(root, "data"), path.join(root, "cache"), {
  get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); },
  delete: async key => { secrets.delete(key); },
});
const kind = values.kind as "codex" | "claude";
const reports: unknown[] = [];
try {
  const secret = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (kind === "codex" && !values["host-home"]) throw new Error("Codex needs --host-home.");
  if (kind === "claude" && !secret) throw new Error("Claude needs an existing credential in its environment.");
  const connection = await registry.update(kind === "codex"
    ? { name: "Benchmark", kind, auth: "host-login", hostDirectory: path.resolve(values["host-home"]!) }
    : { name: "Benchmark", kind, auth: process.env.ANTHROPIC_API_KEY ? "api-key" : "claude-token", secret });
  const text = await readFile(values.plan, "utf8");
  let segments: { milliseconds: number; characters: number; succeeded: boolean; events: TranslationTiming[]; outputText?: string }[] = [];
  const service = new TranslationService(registry, new SettingsStore(path.join(root, "settings")), async (runtime, input, signal, options) => {
    const start = performance.now(); let succeeded = false;
    const events: TranslationTiming[] = [];
    let outputText: string | undefined;
    try { const result = await runTranslation(runtime, input, signal, { ...options, observe: event => events.push(event) }); succeeded = true; outputText = result; return result; }
    finally { segments.push({ milliseconds: Math.round(performance.now() - start), characters: [...JSON.parse(input).text].length, succeeded, events,
      ...(values["include-output"] && outputText ? { outputText } : {}) }); }
  });
  await service.configure(kind, connection.id, values.model ?? null);
  for (let index = 0; index < repeats; index++) {
    segments = [];
    registry.preparationMilliseconds = 0; registry.cleanupMilliseconds = 0;
    const start = performance.now();
    try {
      const result = await service.translate(kind, { text, targetLanguage: "ru", sourceLanguage: "en", format: "markdown" }, AbortSignal.timeout(TIMEOUT_SECONDS * 1000));
      const report = { kind, requestedModel: values.model ?? null, run: index + 1, inputCharacters: [...text].length, outputCharacters: [...result.text].length,
        milliseconds: Math.round(performance.now() - start), markdownValid: true, segments,
        preparationMilliseconds: Math.round(registry.preparationMilliseconds), cleanupMilliseconds: Math.round(registry.cleanupMilliseconds),
        ...(values["include-output"] ? { outputText: result.text } : {}) };
      reports.push(report); console.log(JSON.stringify(report));
    } catch (error) {
      const report = { kind, requestedModel: values.model ?? null, run: index + 1, inputCharacters: [...text].length, milliseconds: Math.round(performance.now() - start),
        code: (error as { code?: string }).code ?? "benchmark_failed", markdownValid: false, segments };
      reports.push(report); console.log(JSON.stringify(report)); process.exitCode = 1;
      if (!values["continue-on-error"]) break;
    }
  }
  if (values.output) await writeFile(values.output, JSON.stringify({ date: new Date().toISOString(), plan: values.plan, reports }, null, 2));
} finally { await registry.shutdown(); secrets.clear(); await rm(root, { recursive: true, force: true }); }
