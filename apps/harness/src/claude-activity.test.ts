import { expect, it, vi } from "vitest";
import type { HarnessEvent } from "./harness/adapter.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

it("observes Claude thinking and executing tools without mistaking a proposal or block stop for execution/completion", async () => {
  const events: HarnessEvent[] = [];
  const stream = (event: unknown) => ({ type: "stream_event", event });
  const messages = [
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private reasoning" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private reasoning" } }),
    stream({ type: "content_block_stop", index: 0 }),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/one", token: "secret" } }] } },
    { type: "tool_progress", tool_use_id: "a", tool_name: "Read" },
    { type: "tool_progress", tool_use_id: "a", tool_name: "Read" },
    { type: "tool_progress", tool_use_id: "b", tool_name: "Bash" },
    stream({ type: "content_block_stop", index: 1 }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "secret" }] } },
    { type: "tool_progress", tool_use_id: "a", tool_name: "Read" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "secret" }] } },
    stream({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" } }),
    stream({ type: "content_block_stop", index: 2 }),
    { type: "result", subtype: "success" },
  ];
  queryMock.mockImplementation(() => Object.assign((async function* () { yield* messages; })(), {
    interrupt: async () => {}, close: () => {},
  }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "test", cwd: "/tmp", onEvent: event => events.push(event) });
  run.send("test");
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("result"));
  const activity = events.filter(e => e.type === "activity").map(e => e.activity);
  expect(activity.map(a => [a.phase, a.tool?.toolName ?? null, a.toolCount])).toEqual([
    ["working", null, 0], ["thinking", null, 0], ["working", null, 0],
    ["working", "Read", 1], ["working", "Bash", 2], ["working", "Bash", 1],
    ["working", null, 0], ["responding", null, 0], ["working", null, 0], ["working", null, 0],
  ]);
  expect(JSON.stringify(activity)).not.toMatch(/secret|private reasoning/);
  expect(activity.find(a => a.tool?.toolName === "Read")?.tool?.detail).toBe("/one");
  await run.stop();
});
