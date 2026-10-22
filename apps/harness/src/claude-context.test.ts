import { afterEach, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessRun } from "./harness/adapter.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
let run: HarnessRun | undefined;
afterEach(async () => { await run?.stop(); run = undefined; vi.clearAllMocks(); });
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

it("samples main-session summaries, ignores subagents, and emits a final context measurement before result", async () => {
  const events: HarnessEvent[] = [], assistant = gate(), done = gate(), subagent = gate();
  const getContextUsage = vi.fn().mockResolvedValue({ totalTokens: 20, maxTokens: 100 });
  queryMock.mockReturnValue(Object.assign((async function* () {
    yield { type: "system", subtype: "init", session_id: "native" };
    await subagent.promise;
    yield { type: "assistant", parent_tool_use_id: "subagent", message: { id: "child", content: [] } };
    await assistant.promise;
    yield { type: "assistant", message: { id: "main", content: [] } };
    yield { type: "assistant", message: { id: "main", content: [] } };
    await done.promise;
    yield { type: "system", subtype: "compact_boundary" };
    yield { type: "result", subtype: "success" };
  })(), { getContextUsage, interrupt: async () => {}, close() { subagent.release(); assistant.release(); done.release(); } }));
  run = new ClaudeHarnessAdapter().start({ sessionId: "chat", cwd: "/tmp", onEvent: event => events.push(event) });
  run.send("hi");
  await vi.waitFor(() => expect(events.some(e => e.type === "context_usage")).toBe(true));
  subagent.release(); await new Promise(r => setTimeout(r, 10));
  expect(getContextUsage).toHaveBeenCalledTimes(1);
  assistant.release();
  await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2));
  getContextUsage.mockResolvedValue({ totalTokens: 8, maxTokens: 100 });
  done.release();
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("result"));
  expect(getContextUsage.mock.calls.every(args => args[0].detail === "summary")).toBe(true);
  const context = events.filter(e => e.type === "context_usage");
  expect(context.some(e => e.usage === null)).toBe(true);
  expect(context.at(-1)).toMatchObject({ usage: { usedTokens: 8, maxTokens: 100 } });
  expect(events.findIndex(e => e.type === "result")).toBeGreaterThan(events.lastIndexOf(context.at(-1)!));
});

it("keeps the successful result when context diagnostics fail or are unsupported", async () => {
  for (const getContextUsage of [undefined, vi.fn().mockRejectedValue(new Error("diagnostic unavailable"))]) {
    const events: HarnessEvent[] = [];
    queryMock.mockReturnValue(Object.assign((async function* () { yield { type: "result", subtype: "success" }; })(),
      { getContextUsage, interrupt: async () => {}, close() {} }));
    run = new ClaudeHarnessAdapter().start({ sessionId: "chat", cwd: "/tmp", onEvent: event => events.push(event) });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "result", status: "success" }));
    expect(events.some(e => e.type === "error")).toBe(false);
    await run.stop();
  }
});
