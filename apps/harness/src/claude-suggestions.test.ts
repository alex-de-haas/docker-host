import { expect, it, vi } from "vitest";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
import type { HarnessEvent } from "./harness/adapter.js";
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
it.each([true, false])("Claude requests suggestions only when enabled (%s), with no extra turn", async enabled => {
  const events: HarnessEvent[] = [];
  queryMock.mockImplementation(() => Object.assign((async function* () {
    yield { type: "system", subtype: "init", session_id: "native" };
    yield { type: "prompt_suggestion", session_id: "native", suggestion: "too early" };
    yield { type: "result", subtype: "success", session_id: "native" };
    yield { type: "prompt_suggestion", session_id: "other", suggestion: "wrong session" };
    yield { type: "prompt_suggestion", session_id: "native", suggestion: "Следующий шаг?" };
    yield { type: "prompt_suggestion", session_id: "native", suggestion: "duplicate" };
  })(), { interrupt: async () => {}, close: () => {} }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "s", cwd: "/tmp", promptSuggestions: enabled, onEvent: e => events.push(e) });
  run.send("test"); await vi.waitFor(() => expect(events.some(e => e.type === "result")).toBe(true));
  expect(queryMock.mock.lastCall?.[0].options.promptSuggestions).toBe(enabled);
  expect(events.filter(e => e.type === "prompt_suggestion")).toEqual(enabled ? [{ type: "prompt_suggestion", text: "Следующий шаг?" }] : []);
  expect(events.filter(e => e.type === "tool_use")).toEqual([]);
  await run.stop();
});
it("does not accept suggestions following a failed Claude result", async () => {
  const events: HarnessEvent[] = [];
  queryMock.mockImplementation(() => Object.assign((async function* () {
    yield { type: "system", subtype: "init", session_id: "native" };
    yield { type: "result", subtype: "success", is_error: true, session_id: "native" };
    yield { type: "prompt_suggestion", session_id: "native", suggestion: "wrong" };
  })(), { interrupt: async () => {}, close: () => {} }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "s", cwd: "/tmp", promptSuggestions: true, onEvent: e => events.push(e) });
  run.send("test"); await vi.waitFor(() => expect(events.some(e => e.type === "result")).toBe(true));
  expect(events.find(e => e.type === "result")).toMatchObject({ status: "failed" });
  expect(events.filter(e => e.type === "prompt_suggestion")).toEqual([]); await run.stop();
});
