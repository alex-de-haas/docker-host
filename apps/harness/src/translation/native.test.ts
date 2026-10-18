import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTranslation, translationEnvironment, type TranslationRuntime, type TranslationTiming } from "./native.js";

const query = vi.hoisted(() => vi.fn());
const resolveSettings = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query, resolveSettings }));
let root: string, runtime: TranslationRuntime;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "translation-native-test-"));
  runtime = { kind: "codex", home: path.join(root, "profile"), cwd: path.join(root, "work"), env: translationEnvironment() };
  await mkdir(runtime.home); await mkdir(runtime.cwd); vi.clearAllMocks();
  resolveSettings.mockResolvedValue({ sources: [] });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function fakeCodex(body: string) {
  const file = path.join(root, "native.mjs");
  await writeFile(file, `import {writeFileSync} from 'node:fs';\n${body}`);
  vi.stubEnv("HOSTY_HARNESS_CODEX_COMMAND", file);
}
it.each([null, "gpt-6-luna"])("applies the restricted Codex profile with model %s, handles Unicode and ignores advisories", async model => {
  const capture = path.join(root, "args.json");
  await fakeCodex(`writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));
    for(const event of [{type:'thread.started',thread_id:'private-session'},{type:'turn.started'},
      {type:'item.completed',item:{type:'error',message:'synthetic advisory'}},
      {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'Пример 😀'})}},{type:'turn.completed'}]) {
      const bytes=Buffer.from(JSON.stringify(event)+'\\n'); for(const byte of bytes) process.stdout.write(Buffer.from([byte]));
    }`);
  const events: TranslationTiming[] = [];
  expect(await runTranslation(runtime, '{"text":"Example"}', AbortSignal.timeout(5000), { model, observe: event => events.push(event) })).toBe("Пример 😀");
  expect(events.map(event => event.phase)).toEqual(["spawned", "ready", "turn", "assistant", "result", "closed"]);
  expect(events.every(event => Object.keys(event).sort().join(",") === "milliseconds,phase")).toBe(true);
  expect(events.map(event => event.milliseconds)).toEqual(events.map(event => event.milliseconds).sort((a, b) => a - b));
  const args = JSON.parse(await readFile(capture, "utf8"));
  if (model) expect(args[args.indexOf("--model") + 1]).toBe(model);
  else expect(args).not.toContain("--model");
  for (const required of ["--ephemeral", "--sandbox", "read-only", "--output-schema", "features.shell_tool=false", "features.apps=false", "features.plugins=false", "features.hooks=false", "features.multi_agent=false", "project_doc_max_bytes=0"])
    expect(args).toContain(required);
});
it.each(["command_execution", "mcp_tool_call", "web_search"])("rejects a native %s attempt", async type => {
  await fakeCodex(`console.log(JSON.stringify({type:'item.started',item:{type:${JSON.stringify(type)}}}));setInterval(()=>{},1000);`);
  await expect(runTranslation(runtime, "test", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "translation_tool_refused" });
});
it("kills a stalled Codex process on cancellation", async () => {
  await fakeCodex("setInterval(()=>{},1000);");
  await expect(runTranslation(runtime, "test", AbortSignal.timeout(100))).rejects.toMatchObject({ name: "TimeoutError" });
});
it.each([[false, null], [true, null], [false, "claude-haiku-4-5-20251001"], [true, "haiku"]] as const)("configures isolated Claude (OAuth %s, model %s)", async (oauth, model) => {
  if (oauth) runtime.env.CLAUDE_CODE_OAUTH_TOKEN = "synthetic-test-token";
  const close = vi.fn();
  query.mockReturnValue({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", model: "test-model", session_id: "private-session" };
    yield { type: "assistant", message: { content: "private-content" } };
    yield { type: "result", subtype: "success", is_error: false, duration_api_ms: 42, duration_ms: 50, ttft_ms: 12,
      num_turns: 1, structured_output: { text: "Перевод" } };
  }, close });
  const events: TranslationTiming[] = [];
  expect(await runTranslation({ ...runtime, kind: "claude" }, "test", AbortSignal.timeout(5000), { model, observe: event => events.push(event) })).toBe("Перевод");
  expect(events.map(event => event.phase)).toEqual(["loaded", "spawned", "ready", "assistant", "result", "closed"]);
  expect(events.find(event => event.phase === "result")).toMatchObject({ apiMilliseconds: 42, nativeMilliseconds: 50, firstTokenMilliseconds: 12, turns: 1 });
  expect(JSON.stringify(events)).not.toContain("private-");
  expect(JSON.stringify(events)).not.toContain("Перевод");
  const options = query.mock.calls[0]![0].options;
  if (model) expect(options.model).toBe(model);
  else expect(options).not.toHaveProperty("model");
  expect(options).toMatchObject({ tools: [], skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], hooks: {}, permissionMode: "dontAsk", persistSession: false, maxTurns: 2 });
  expect(options.env.CLAUDE_CODE_SIMPLE).toBe(oauth ? undefined : "1");
  expect(options.env.CLAUDE_CODE_SAFE_MODE).toBe(oauth ? "1" : undefined);
  if (oauth) expect(options.managedSettings).toEqual({ disableAllHooks: true });
  expect(await options.canUseTool()).toMatchObject({ behavior: "deny" });
  expect(close).toHaveBeenCalledOnce();
});
it("refuses subscription translation before starting Claude when managed policy is present", async () => {
  resolveSettings.mockResolvedValue({ sources: [{ source: "managed", settings: { hooks: {} } }] });
  await expect(runTranslation({ ...runtime, kind: "claude", env: { ...runtime.env, CLAUDE_CODE_OAUTH_TOKEN: "synthetic" } },
    "test", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "translation_unavailable" });
  expect(query).not.toHaveBeenCalled();
});
it("rejects failed or malformed Claude structured results", async () => {
  const close = vi.fn();
  query.mockReturnValue({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, structured_output: { text: "bad", extra: "wrong" } }; }, close });
  await expect(runTranslation({ ...runtime, kind: "claude" }, "test", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "translation_result_invalid" });
  expect(close).toHaveBeenCalledOnce();
});
