import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { HarnessEvent, HarnessRun } from "./adapter.js";

const sdk = vi.hoisted(() => ({ messages: [] as Record<string, unknown>[], finish: () => {}, options: undefined as Record<string, unknown> | undefined }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: ({ options }: { options: Record<string, unknown> }) => {
  sdk.options = options;
  return { async *[Symbol.asyncIterator]() { for (const message of sdk.messages) yield message; await new Promise<void>(resolve => { sdk.finish = resolve; }); },
    interrupt: async () => { sdk.finish(); }, close: () => { sdk.finish(); }, applyFlagSettings: async () => {} };
} }));
import { ClaudeHarnessAdapter } from "./claude.js";

let run: HarnessRun | undefined;
afterEach(async () => { await run?.stopAndWait?.(); run = undefined; sdk.messages = []; sdk.options = undefined; });
describe("Claude SDK child provenance", () => {
  it("keeps parent-tool child text and completion separate from root context and native binding", async () => {
    sdk.messages = [
      { type: "system", subtype: "init", session_id: "native-root", model: "model" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "parent-agent-tool", name: "Agent", input: { prompt: "Delegate" } }] } },
      { type: "system", subtype: "init", session_id: "different-child-session", parent_tool_use_id: "parent-agent-tool", model: "child-model" },
      { type: "stream_event", parent_tool_use_id: "parent-agent-tool", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child" } } },
      { type: "assistant", parent_tool_use_id: "parent-agent-tool", message: { content: [{ type: "text", text: "Child answer" }] } },
      { type: "result", parent_tool_use_id: "parent-agent-tool", session_id: "different-child-session", subtype: "success" },
      { type: "assistant", message: { content: [{ type: "text", text: "Root continues" }] } },
    ];
    const events: HarnessEvent[] = [];
    run = new ClaudeHarnessAdapter({ ANTHROPIC_API_KEY: "isolated-test-placeholder" }).start({ sessionId: "logical-session", cwd: "/private/tmp", onEvent: event => events.push(event) }); run.send("Start");
    await vi.waitFor(() => expect(events.some(event => event.type === "assistant_text" && event.text === "Root continues")).toBe(true));
    expect(events.filter(event => event.type === "harness_session")).toEqual([{ type: "harness_session", harnessSessionId: "native-root" }]);
    const child = events.find(event => event.type === "assistant_text" && event.text === "Child answer");
    expect(child?.source?.agentId).toBe("claude-child:parent-agent-tool"); expect(child?.source?.parentAgentId).toBe("root");
    expect(events.find(event => event.type === "result")?.source).toEqual(child?.source);
    expect(events.find(event => event.type === "assistant_text" && event.text === "Root continues")?.source).toBeUndefined();
    expect(events.some(event => event.type === "error")).toBe(false);
  });
  it("uses the SDK's explicit agent identity for unlinked child permission requests", async () => {
    const events: HarnessEvent[] = [];
    run = new ClaudeHarnessAdapter({ ANTHROPIC_API_KEY: "isolated-test-placeholder" }).start({ sessionId: "logical-session", cwd: "/private/tmp", onEvent: event => events.push(event) }); run.send("Start");
    await vi.waitFor(() => expect(sdk.options?.canUseTool).toBeTypeOf("function"));
    const callback = sdk.options!.canUseTool as (tool: string, input: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
    const pending = callback("Write", { path: "example.txt" }, { toolUseID: "child-call", agentID: "explicit-agent" });
    const event = events.find(value => value.type === "approval_request"); expect(event?.source).toEqual({ agentId: "claude-agent:explicit-agent" });
    if (event?.type !== "approval_request") throw new Error("Expected the native pending approval");
    run.resolveApproval(event.approvalId, "deny"); await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });
  it("forwards the pinned SDK executable and graceful-close signal to the managed process transport", async () => {
    const child = new EventEmitter(), spawn = vi.fn(() => child as never);
    run = new ClaudeHarnessAdapter({ ANTHROPIC_API_KEY: "isolated-test-placeholder" }).start({ sessionId: "logical-session", cwd: "/private/tmp", processTransport: { spawn }, onEvent() {} });
    await vi.waitFor(() => expect(sdk.options?.spawnClaudeCodeProcess).toBeTypeOf("function"));
    expect(sdk.options).not.toHaveProperty("pathToClaudeCodeExecutable");
    const callback = sdk.options!.spawnClaudeCodeProcess as (input: Record<string, unknown>) => unknown, controller = new AbortController();
    callback({ command: "/pinned-sdk/vendor/claude", args: ["--print"], cwd: "/isolated/workspace", env: { TEST_FIXTURE: "1" }, signal: controller.signal });
    expect(spawn).toHaveBeenCalledWith("claude", ["--print"], { command: "/pinned-sdk/vendor/claude", cwd: "/isolated/workspace", env: { TEST_FIXTURE: "1" }, signal: controller.signal });
    child.emit("close", 0, null);
  });
});
