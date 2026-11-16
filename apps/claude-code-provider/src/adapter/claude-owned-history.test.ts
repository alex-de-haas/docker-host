import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ClaudeConnections as AgentConnections } from "../connections.js";
import { trackedAdapter } from "@hosty/agent-provider-runtime/tracked-adapter";
import { TrackedNativeProcesses } from "@hosty/agent-provider-runtime/tracked-process";
import { WorkerJournal } from "@hosty/agent-provider-runtime/worker/journal";
import type { HarnessEvent, HarnessRun } from "@hosty/agent-provider-runtime/harness/adapter";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
// Only inference is scripted. The separately spawned reader uses the real installed SDK read API.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (input: unknown) => sdk.query(input) }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); sdk.query.mockReset(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-owned-claude-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const secrets = new Map<string, string>(), data = path.join(root, "data"), cache = path.join(root, "cache");
  const registry = new AgentConnections(data, cache, { get: async key => secrets.get(key) ?? null,
    set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } });
  cleanup.push(() => registry.shutdown());
  const account = await registry.update({ name: "Owned fixture", kind: "claude", auth: "api-key", secret: "synthetic-no-inference" });
  const binding = (await registry.binding(account.id))!, home = await registry.executionHome(binding), history = (await registry.executionHistoryHome(binding))!;
  const cwd = await realpath(root), selected = path.join(cwd, "skills"); await mkdir(selected);
  return { root, data, cache, registry, account, binding, home, history, cwd, selected };
}

it.each([false, true])("uses registry-owned durable history through the real skill/transport pipeline; foreign redirect=%s", async foreign => {
  const f = await fixture(), nativeSessionId = randomUUID(), parent = "parent-agent", agentId = "owned-native-child", raw = "owned-child-bash";
  const originalUuid = randomUUID(), streamedUuid = originalUuid.slice(0, 24) + "000000000001", resultUuid = randomUUID();
  const input = { command: "printf model-free-fixture" }, messageId = "message-owned-fixture";
  const project = path.join(f.history.directories.projects!, f.cwd.replace(/[^a-zA-Z0-9]/g, "-")), directory = path.join(project, nativeSessionId, "subagents");
  await mkdir(directory, { recursive: true });
  const rootFile = path.join(project, nativeSessionId + ".jsonl"), transcript = path.join(directory, `agent-${agentId}.jsonl`);
  const base = { sessionId: nativeSessionId, cwd: f.cwd, isSidechain: true, userType: "external", timestamp: new Date().toISOString() };
  const assistant = { ...base, type: "assistant", uuid: originalUuid, parentUuid: null,
    message: { id: messageId, type: "message", role: "assistant", model: "fixture", stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "Fixture" }, { type: "tool_use", id: raw, name: "Bash", input }] } };
  await writeFile(rootFile, JSON.stringify({ ...base, type: "user", uuid: randomUUID(), parentUuid: null, message: { role: "user", content: "Owned fixture" } }) + "\n");
  await writeFile(transcript, JSON.stringify(assistant) + "\n");
  await writeFile(transcript.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ toolUseId: parent, parentAgentId: null }));
  const events: HarnessEvent[] = [], logs: string[] = []; vi.spyOn(console, "warn").mockImplementation(value => { logs.push(String(value)); });
  let started = false, queryOptions: any, native!: ChildProcessWithoutNullStreams, release!: () => void, interrupted!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; }), interrupt = new Promise<void>(resolve => { interrupted = resolve; });
  sdk.query.mockImplementation(({ options }) => {
    queryOptions = options;
    native = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.cwd, env: options.env });
    return { async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: nativeSessionId };
      yield { type: "assistant", uuid: randomUUID(), session_id: nativeSessionId, parent_tool_use_id: null,
        message: { id: "parent-message", content: [{ type: "tool_use", id: parent, name: "Agent", input: {} }] } };
      yield { type: "assistant", uuid: streamedUuid, session_id: nativeSessionId, agent_id: agentId, parent_tool_use_id: parent,
        message: { id: messageId, content: [{ type: "tool_use", id: raw, name: "Bash", input }] } };
      await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", session_id: nativeSessionId, agent_id: agentId,
        tool_use_id: raw, tool_name: "Bash", tool_input: input, cwd: f.cwd,
        transcript_path: path.join(options.env.CLAUDE_CONFIG_DIR, "projects", path.basename(project), nativeSessionId + ".jsonl") });
      started = true; await interrupt;
      yield { type: "user", session_id: nativeSessionId, parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: parent, content: "Stopped parent", is_error: true }] } };
      await finished;
    }, interrupt: async () => { interrupted(); }, close: () => {
      appendFileSync(transcript, JSON.stringify({ ...base, type: "user", uuid: resultUuid, parentUuid: originalUuid,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: raw, content: "Actual failed invocation", is_error: true }] } }) + "\n");
      native.kill("SIGTERM"); release();
    } };
  });
  const isolated = await f.registry.prepareAdapter(f.binding, { skillPath: f.selected, sessionDirectory: path.join(f.root, "session") });
  cleanup.push(() => isolated.dispose?.() ?? Promise.resolve());
  const id = randomUUID(), generation = randomUUID(), tracked = await TrackedNativeProcesses.create(f.data, id, generation);
  cleanup.push(() => tracked.stop());
  const run: HarnessRun = trackedAdapter(isolated, tracked).start({ sessionId: "consumer", cwd: f.cwd, autonomy: "autonomous", onEvent: event => events.push(event) });
  cleanup.push(() => run.stopAndWait!()); run.send("Fixture only; no inference");
  await vi.waitFor(() => expect(started).toBe(true));
  const executionHome = queryOptions.env.HOME;
  expect(await realpath(executionHome)).toBe(executionHome); // Includes the macOS /var→/private alias.
  expect(executionHome).not.toBe(f.home); expect(await realpath(path.join(executionHome, "projects"))).toBe(f.history.directories.projects!);
  if (foreign) {
    const other = path.join(f.cwd, "foreign-history"); await mkdir(other);
    await rm(path.join(executionHome, "projects")); await symlink(other, path.join(executionHome, "projects"), process.platform === "win32" ? "junction" : "dir");
  }
  await run.stopAndWait!();
  expect(await tracked.evidence()).toMatchObject({ allClosed: true, stopped: process.platform !== "win32", spawnCount: 2 });
  const childResults = events.filter(event => event.type === "tool_result" && event.source);
  expect(childResults).toHaveLength(foreign ? 0 : 1);
  if (!foreign) {
    expect(childResults[0]).toMatchObject({ status: "failed", output: "Actual failed invocation", source: { parentAgentId: "root" } });
    expect(events.find(event => event.type === "command_result" && event.source)).toMatchObject({ status: "unknown" });
  }
  const journal = new WorkerJournal(path.join(f.cwd, "journal")); await journal.initialize();
  await journal.accept(id, { conversationId: "consumer", binding: f.binding, selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "consumer" }, input: "fixture", options: {}, autoAllowedPrefixes: [] });
  await journal.update(id, "running"); for (const event of events) await journal.append(id, event); await journal.update(id, "cancelled");
  const receipt = (await journal.load(id)).receipt;
  expect(Object.keys(receipt.effects ?? {})).toHaveLength(foreign ? 1 : 0);
  expect(logs.some(line => line.includes(foreign ? '"outcome":"unavailable"' : '"outcome":"matched"'))).toBe(true);
  for (const line of logs) { expect(line).not.toContain(executionHome); expect(line).not.toContain("synthetic-no-inference"); expect(line).not.toContain(input.command); }
});

it("rejects a stale account revision and a redirected durable registry history root", async () => {
  const f = await fixture();
  await expect(f.registry.executionHistoryHome({ ...f.binding, connectionRevision: f.binding.connectionRevision + 1 })).rejects.toThrow("current connection");
  const other = path.join(f.cwd, "foreign"); await mkdir(other);
  await rm(f.history.directories.projects!, { recursive: true }); await symlink(other, f.history.directories.projects!, process.platform === "win32" ? "junction" : "dir");
  await expect(f.registry.executionHistoryHome(f.binding)).rejects.toThrow("owned location");
});
