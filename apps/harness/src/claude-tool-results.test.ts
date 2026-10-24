import { afterEach, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessRun } from "./harness/adapter.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
let run: HarnessRun | undefined;
afterEach(async () => { await run?.stop(); run = undefined; vi.clearAllMocks(); });
const proposal = (id: string, name = "mcp__hosty-core__list_apps", parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const completion = (id: string, content: unknown, parent: string | null = null, is_error?: boolean) => ({ type: "user", parent_tool_use_id: parent,
  tool_use_result: { accessToken: "private-envelope-token" }, message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(is_error === undefined ? {} : { is_error }) }] } });
function begin(messages: unknown[], events: HarnessEvent[]) {
  queryMock.mockReturnValue(Object.assign((async function* () { yield* messages; })(), { interrupt: async () => {}, close() {} }));
  run = new ClaudeHarnessAdapter().start({ sessionId: "chat", cwd: "/tmp", onEvent: event => events.push(event) });
  run.send("inspect");
}
it("correlates ordinary, concurrent and child tool outputs without copying structured provider envelopes", async () => {
  const events: HarnessEvent[] = [];
  begin([proposal("a"), proposal("b"), proposal("a", "Read", "child"), completion("b", [{ type: "text", text: "second output" }]),
    completion("a", "child output", "child"), completion("foreign", "unmatched"), completion("a", "first output"), completion("a", "duplicate"),
    { ...proposal("replayed"), isReplay: true }, completion("replayed", "replayed"), proposal("failed", "Read"), completion("failed", "not found", null, true),
    proposal("hidden", "ToolSearch"), completion("hidden", "hidden schema"), proposal("setup", "mcp__hosty-workspaces__environment_setup"), completion("setup", "private setup"),
    { type: "result", subtype: "success" }, completion("b", "late")], events);
  await vi.waitFor(() => expect(events.some(event => event.type === "result")).toBe(true));
  const results = events.filter(event => event.type === "tool_result");
  expect(results.map(event => [event.output, event.status])).toEqual([["second output", "completed"], ["child output", "completed"], ["first output", "completed"], ["not found", "failed"]]);
  for (const result of results) expect(events.filter(event => event.type === "tool_use" && event.toolUseId === result.toolUseId)).toHaveLength(1);
  expect(new Set(results.map(event => event.toolUseId)).size).toBe(4);
  expect(JSON.stringify(results)).not.toMatch(/private-envelope-token|hidden schema|private setup|unmatched|duplicate|replayed|late/);
});
it("retains bounded command output separately from the unchanged factual command metadata", async () => {
  const events: HarnessEvent[] = [];
  const finished = completion("command", "stdout " + "x".repeat(40000));
  finished.tool_use_result = { stdout: "Tests 2 passed (2)", stderr: "", interrupted: false } as never;
  begin([proposal("command", "Bash"), finished, { type: "result", subtype: "success" }], events);
  await vi.waitFor(() => expect(events.some(event => event.type === "result")).toBe(true));
  const result = events.find(event => event.type === "tool_result")!;
  expect(result).toMatchObject({ status: "completed", truncated: true });
  expect(result.type === "tool_result" && result.output).toHaveLength(32768);
  expect(events.find(event => event.type === "command_result")).toEqual({ type: "command_result", toolUseId: result.toolUseId, status: "completed", summary: "2 passed" });
});
it("omits output for a locally denied generic tool even if the provider later claims success", async () => {
  const events: HarnessEvent[] = [];
  queryMock.mockImplementation((args: { options: { canUseTool: (name: string, input: unknown, context: unknown) => Promise<unknown> } }) => Object.assign((async function* () {
    yield proposal("denied", "Write");
    const permission = args.options.canUseTool("Write", {}, { toolUseID: "denied" });
    await permission; yield completion("denied", "must not claim this ran"); yield completion("denied", "duplicate"); yield { type: "result", subtype: "success" };
  })(), { interrupt: async () => {}, close() {} }));
  run = new ClaudeHarnessAdapter().start({ sessionId: "chat", cwd: "/tmp", onEvent: event => events.push(event) }); run.send("edit");
  await vi.waitFor(() => expect(events.find(event => event.type === "approval_request")).toBeDefined());
  const approval = events.find(event => event.type === "approval_request")!;
  expect(approval.type === "approval_request" && run.resolveApproval(approval.approvalId, "deny")).toBe(true);
  await vi.waitFor(() => expect(events.some(event => event.type === "result")).toBe(true));
  expect(events.filter(event => event.type === "tool_result")).toEqual([]);
});

it("does not claim a detached native tool placeholder is its final completion", async () => {
  const events: HarnessEvent[] = [];
  const deferred = { ...completion("fetch", "Tool still running"), tool_use_result: { detachedToolCall: true } };
  begin([proposal("fetch", "WebFetch"), deferred, { type: "result", subtype: "success" }], events);
  await vi.waitFor(() => expect(events.some(event => event.type === "result")).toBe(true));
  expect(events.find(event => event.type === "tool_result")).toMatchObject({ status: "unknown", output: "Tool still running" });
});
