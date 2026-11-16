import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { claudeHistoryEnvironment, readClaudeChildHistory, type ClaudeChildHistoryRequest } from "./claude-history.js";
import type { AgentProcessTransport, AgentSpawnOptions } from "@hosty/agent-provider-runtime/runtime/transport";

afterEach(() => vi.useRealTimers());
const request: ClaudeChildHistoryRequest = { version: 1, nativeHome: "/owned/native", executionHome: "/owned/execution", cwd: "/owned/workspace", nativeSessionId: "session",
  children: [{ agentId: "child", transcriptPath: "/owned/native/transcript", parentToolUseId: "parent",
    calls: [{ assistantUuid: "assistant", assistantMessageId: "message", toolUseId: "bash", input: { command: "printf héllo" } }] }] };
const match = { agentId: "child", parentToolUseId: "parent", assistantUuid: "assistant", assistantMessageId: "message", historyAssistantUuid: "durable-assistant", toolUseId: "bash", resultUuid: "result",
  result: { type: "tool_result", tool_use_id: "bash", content: "Interrompu — arrêt", is_error: true } };
function fixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  let options!: AgentSpawnOptions;
  const spawnTool = vi.fn((_args: string[], value: AgentSpawnOptions) => { options = value; return child; });
  const transport: AgentProcessTransport = { spawnTool, spawn: () => { throw new Error("No native query may be started by this reader"); } };
  const close = (code = 0) => child.emit("close", code, null);
  const output = (value: unknown) => stdout.write(Buffer.from(JSON.stringify(value)));
  return { child, stdout, transport, spawnTool, close, output, get options() { return options; } };
}
it("uses an owned minimal-environment helper and waits for close, preserving split UTF-8", async () => {
  const f = fixture(), result = readClaudeChildHistory(request, f.transport);
  const bytes = Buffer.from(JSON.stringify({ version: 1, nativeSessionId: "session", matches: [match] }));
  const split = bytes.indexOf(Buffer.from("—")) + 1;
  f.stdout.write(bytes.subarray(0, split)); f.stdout.write(bytes.subarray(split));
  let done = false; void result.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  f.close(); expect(await result).toEqual([match]);
  expect(f.options.env).toEqual(claudeHistoryEnvironment(request.nativeHome));
  expect(f.options.env).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(f.options.env).not.toHaveProperty("HOSTY_APP_TOKEN");
  expect(f.options.cwd).toBe(request.cwd); expect(f.spawnTool.mock.calls[0]![0]).toContain("--max-old-space-size=96");
});
it.each([
  { ...match, agentId: "foreign" }, { ...match, parentToolUseId: "another-parent" }, { ...match, assistantUuid: "old-assistant" },
  { ...match, assistantMessageId: "another-message" }, { ...match, historyAssistantUuid: undefined },
  { ...match, toolUseId: "other" }, { ...match, result: { ...match.result, is_error: false } },
])("rejects an unrelated or unproven helper result %j", async invalid => {
  const f = fixture(), result = readClaudeChildHistory(request, f.transport);
  f.output({ version: 1, nativeSessionId: "session", matches: [invalid] }); f.close(); expect(await result).toEqual([]);
});
it("rejects duplicate proofs and another native session", async () => {
  for (const value of [{ version: 1, nativeSessionId: "session", matches: [match, match] }, { version: 1, nativeSessionId: "foreign", matches: [match] }]) {
    const f = fixture(), result = readClaudeChildHistory(request, f.transport); f.output(value); f.close(); expect(await result).toEqual([]);
  }
});
it("aborts oversized output and still requires the owned helper's close", async () => {
  const f = fixture(), result = readClaudeChildHistory(request, f.transport);
  f.stdout.write(Buffer.alloc(128 * 1024 + 1)); expect(f.options.signal!.aborted).toBe(true);
  f.close(); expect(await result).toEqual([]);
});
it("returns no proof on a timed-out but closed helper", async () => {
  vi.useFakeTimers(); const f = fixture(), result = readClaudeChildHistory(request, f.transport);
  await vi.advanceTimersByTimeAsync(1200); expect(f.options.signal!.aborted).toBe(true);
  f.close(); expect(await result).toEqual([]);
});
it("does not convert unconfirmed helper exit into an SDK stop proof", async () => {
  vi.useFakeTimers(); const f = fixture(), result = readClaudeChildHistory(request, f.transport);
  const assertion = expect(result).rejects.toThrow("has not confirmed exit");
  await vi.advanceTimersByTimeAsync(2000); await assertion; f.close();
});
it("does not spawn an untracked helper", async () => {
  expect(await readClaudeChildHistory(request)).toEqual([]);
});
it("reports bounded failure codes and timing without echoing private kernel output", async () => {
  const f = fixture(), diagnostics: unknown[] = [], result = readClaudeChildHistory(request, f.transport, value => diagnostics.push(value));
  f.output({ version: 1, nativeSessionId: "session", matches: [], unavailable: [{ agentId: "child", reason: "captured_path_mismatch" },
    { agentId: "child", reason: "/private/secret/not-a-code" }] }); f.close(); expect(await result).toEqual([]);
  expect(diagnostics).toEqual([{ outcome: "unavailable", stdoutBytes: expect.any(Number), stderrBytes: 0,
    firstOutputMs: expect.any(Number), closedMs: expect.any(Number), reasons: ["captured_path_mismatch"] }]);
  expect(JSON.stringify(diagnostics)).not.toContain("/private"); expect(JSON.stringify(diagnostics)).not.toContain("child");
});
it("reports helper work timeout separately from its confirmed close", async () => {
  vi.useFakeTimers(); const f = fixture(), diagnostics: unknown[] = [], result = readClaudeChildHistory(request, f.transport, value => diagnostics.push(value));
  await vi.advanceTimersByTimeAsync(1200); f.close(); expect(await result).toEqual([]);
  expect(diagnostics).toMatchObject([{ outcome: "work_timeout", stdoutBytes: 0, closedMs: expect.any(Number) }]);
});
