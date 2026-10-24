import { expect, it, vi } from "vitest";
import type { HarnessEvent } from "./harness/adapter.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
const proposal = (id: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "fixture" } }] } });
const completion = (id: string, output: unknown = { stdout: "Tests 14 passed (14)\nsecret", stderr: "secret", interrupted: false }, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent, tool_use_result: output, message: { content: [{ type: "tool_result", tool_use_id: id, content: "raw secret" }] } });
it("correlates concurrent and child commands once by factual IDs, omits raw output and ignores unmatched/replayed/late results", async () => {
  const events: HarnessEvent[] = [];
  const messages = [proposal("a"), proposal("b"), proposal("a", "child"), completion("b"), completion("a", undefined, "child"), completion("foreign"),
    completion("a"), completion("a"), { ...proposal("replay"), isReplay: true }, completion("replay"),
    { type: "result", subtype: "success" }, completion("b")];
  queryMock.mockImplementation(() => Object.assign((async function* () { yield* messages; })(), { interrupt: async () => {}, close: () => {} }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "test", cwd: "/tmp", onEvent: event => events.push(event) }); run.send("test");
  await vi.waitFor(() => expect(events.find(event => event.type === "result")).toBeDefined());
  const starts = events.filter((event): event is Extract<HarnessEvent, { type: "tool_use" }> => event.type === "tool_use" && !!event.toolUseId);
  const results = events.filter(event => event.type === "command_result");
  expect(starts).toHaveLength(3); expect(results).toHaveLength(3);
  expect(new Set(starts.map(event => event.type === "tool_use" && event.toolUseId)).size).toBe(3);
  expect(results.map(event => event.toolUseId)).toEqual([starts[1]!.toolUseId, starts[2]!.toolUseId, starts[0]!.toolUseId]);
  expect(results.every(event => event.status === "completed" && event.exitCode === undefined && event.durationMs === undefined)).toBe(true);
  expect(JSON.stringify(results)).not.toMatch(/secret|stdout|stderr|raw/); await run.stop();
});
it("does not turn a denied Bash call into execution even if a late native result claims completion", async () => {
  const events: HarnessEvent[] = [];
  queryMock.mockImplementation((args: { options: { canUseTool: (name: string, input: unknown, context: unknown) => Promise<unknown> } }) => Object.assign((async function* () {
    yield proposal("denied");
    const permission = args.options.canUseTool("Bash", { command: "fixture" }, { toolUseID: "denied" });
    await vi.waitFor(() => expect(events.find(event => event.type === "approval_request")).toBeDefined());
    await permission; yield completion("denied"); yield completion("denied"); yield { type: "result", subtype: "success" };
  })(), { interrupt: async () => {}, close: () => {} }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "test", cwd: "/tmp", onEvent: event => events.push(event) }); run.send("test");
  await vi.waitFor(() => expect(events.find(event => event.type === "approval_request")).toBeDefined());
  const request = events.find(event => event.type === "approval_request")!; expect(request.type === "approval_request" && run.resolveApproval(request.approvalId, "deny")).toBe(true);
  await vi.waitFor(() => expect(events.find(event => event.type === "result")).toBeDefined());
  expect(events.filter(event => event.type === "command_result")).toEqual([]); await run.stop();
});

it("keeps a reused raw ID unknown across turns without disabling a later genuinely new command", async () => {
  const events: HarnessEvent[] = [];
  let nextTurn = () => {};
  const resume = new Promise<void>(resolve => { nextTurn = resolve; });
  queryMock.mockImplementation(() => Object.assign((async function* () {
    yield proposal("old"); yield completion("old"); yield { type: "result", subtype: "success" };
    await resume;
    yield proposal("old"); yield completion("old");
    yield proposal("new"); yield completion("new"); yield { type: "result", subtype: "success" };
  })(), { interrupt: async () => {}, close: () => {} }));
  const run = new ClaudeHarnessAdapter().start({ sessionId: "test", cwd: "/tmp", onEvent: event => events.push(event) });
  run.send("first"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1));
  run.send("second"); nextTurn(); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(2));
  const starts = events.filter(event => event.type === "tool_use");
  expect(starts).toHaveLength(3); expect(starts[1]!.toolUseId).toBeUndefined();
  expect(starts[0]!.toolUseId).not.toBe(starts[2]!.toolUseId);
  expect(events.filter(event => event.type === "command_result")).toHaveLength(2); await run.stop();
});
