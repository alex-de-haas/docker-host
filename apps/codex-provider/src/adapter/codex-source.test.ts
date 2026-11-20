import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexHarnessAdapter } from "./codex.js";
import { isNodeEntry, resolveCodexCommand } from "./codex-binary.js";
import type { HarnessEvent } from "@hosty/agent-provider-runtime/harness/adapter";

describe("Codex app-server collaboration summaries", () => {
  it("accepts only root-linked collaboration records and never treats child completion as root output", async () => {
    const events: HarnessEvent[] = [], requests: string[] = [], responses: Record<string, unknown>[] = [], stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      stdin: new Writable({ write(chunk, _encoding, done) {
        for (const line of String(chunk).trim().split("\n")) {
          const value = JSON.parse(line) as { id?: number; method?: string }; if (value.id !== undefined && !value.method) { responses.push(value); continue; } if (value.id === undefined || !value.method) continue;
          requests.push(value.method);
          const result = value.method === "thread/start" ? { thread: { id: "root-thread" }, model: "model" }
            : value.method === "turn/start" ? { turn: { id: "root-turn" } }
            : value.method === "mcpServerStatus/list" ? { data: [], nextCursor: null }
            : value.method === "account/read" ? { account: { type: "apiKey" } } : {};
          queueMicrotask(() => stdout.write(JSON.stringify({ id: value.id, result }) + "\n"));
        }
        done();
      } }), kill: (_signal?: string) => { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; } });
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const run = new CodexHarnessAdapter({ apiKey: "isolated-test-placeholder", dataDir: "/private/tmp", isolated: true }).start({ sessionId: "logical-session", cwd: "/private/tmp", model: "model", reasoningEffort: "medium", processTransport: { spawn }, onEvent: event => events.push(event) });
    try {
      run.send("Start"); await vi.waitFor(() => expect(requests).toContain("turn/start"));
      const command = resolveCodexCommand();
      expect(spawn).toHaveBeenCalledWith(isNodeEntry(command) ? process.execPath : command, expect.arrayContaining(["-c", "features.multi_agent=true"]), expect.any(Object));
      const notification = (method: string, params: Record<string, unknown>) => stdout.write(JSON.stringify({ method, params }) + "\n");
      const item = { type: "collabAgentToolCall", id: "collab-call", senderThreadId: "root-thread", receiverThreadIds: ["child-thread"], tool: "spawnAgent", prompt: "Research the fixture", status: "completed", agentsStates: { "child-thread": { status: "completed", message: "Native child output" } } };
      notification("item/completed", { threadId: "foreign-thread", turnId: "foreign-turn", item: { ...item, senderThreadId: "foreign-thread", receiverThreadIds: ["foreign-child"] } });
      notification("item/completed", { threadId: "root-thread", turnId: "root-turn", item: {
        ...item, id: "unobserved-wait", tool: "wait", receiverThreadIds: ["another-chat"],
        agentsStates: { "another-chat": { status: "completed", message: "Foreign final answer" } },
      } });
      notification("item/completed", { threadId: "root-thread", turnId: "root-turn", item: { ...item, agentsStates: {} } });
      notification("item/completed", { threadId: "root-thread", turnId: "root-turn", item: { ...item, id: "known-wait", tool: "wait", prompt: "Wrong task" } });
      stdout.write(JSON.stringify({ id: 9001, method: "item/fileChange/requestApproval", params: { threadId: "child-thread", turnId: "child-turn", itemId: "child-item" } }) + "\n");
      await vi.waitFor(() => expect(events.some(event => event.type === "approval_request")).toBe(true));
      const approval = events.find(event => event.type === "approval_request");
      expect(approval?.source?.agentId).toBe("child-thread");
      if (approval?.type !== "approval_request") throw new Error("Expected the observed child's approval");
      expect(run.resolveApproval(approval.approvalId, "deny")).toBe(true);
      notification("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } });
      stdout.write(JSON.stringify({ id: 9000, method: "item/fileChange/requestApproval", params: { threadId: "foreign-thread", turnId: "foreign-turn", itemId: "foreign-item" } }) + "\n");
      notification("item/agentMessage/delta", { threadId: "root-thread", turnId: "root-turn", itemId: "root-message", delta: "Root continues" });
      await vi.waitFor(() => expect(events.some(event => event.type === "assistant_delta" && event.text === "Root continues")).toBe(true));
      expect(events.filter(event => event.type === "agent_status")).toEqual([
        expect.objectContaining({ agentId: "child-thread", state: "running", prompt: "Research the fixture" }),
        expect.objectContaining({ agentId: "child-thread", parentAgentId: "root", state: "succeeded", stopConfirmed: false, response: "Native child output" }),
      ]);
      expect(JSON.stringify(events)).not.toContain("Foreign final answer");
      expect(events.some(event => event.type === "result")).toBe(false);
      expect(events.filter(event => event.type === "harness_session")).toEqual([{ type: "harness_session", harnessSessionId: "root-thread" }]);
      expect(events.some(event => JSON.stringify(event).includes("foreign-child"))).toBe(false);
      expect(responses).toContainEqual(expect.objectContaining({ id: 9000, error: expect.objectContaining({ code: -32602 }) }));
      expect(events.filter(event => event.type === "approval_request")).toHaveLength(1);
    } finally { await run.stopAndWait?.(); }
  });
});


it("reads only an observed completed child and drains its typed command before the root result", async () => {
  const events: HarnessEvent[] = [], requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [], stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).trim().split("\n")) {
        const rpc = JSON.parse(line); if (rpc.id === undefined || !rpc.method) continue;
        requests.push(rpc);
        if (rpc.method === "thread/read") continue;
        const result = rpc.method === "thread/start" ? { thread: { id: "root-thread" }, model: "model" }
          : rpc.method === "turn/start" ? { turn: { id: "root-turn" } }
          : rpc.method === "mcpServerStatus/list" ? { data: [], nextCursor: null }
          : rpc.method === "account/read" ? { account: { type: "apiKey" } } : {};
        queueMicrotask(() => stdout.write(JSON.stringify({ id: rpc.id, result }) + "\n"));
      }
      done();
    } }), kill: (_signal?: string) => { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; } });
  const run = new CodexHarnessAdapter({ apiKey: "isolated-test-placeholder", dataDir: "/private/tmp", isolated: true }).start({ sessionId: "logical-session", cwd: "/private/tmp", model: "model", reasoningEffort: "medium", processTransport: { spawn: () => child as unknown as ChildProcessWithoutNullStreams }, onEvent: event => events.push(event) });
  const notification = (method: string, params: Record<string, unknown>) => stdout.write(JSON.stringify({ method, params }) + "\n");
  try {
    run.send("Start"); await vi.waitFor(() => expect(requests.some(rpc => rpc.method === "turn/start")).toBe(true));
    const started = { type: "subAgentActivity", id: "spawn-call", kind: "started", agentThreadId: "child-thread", agentPath: "/root/fixture" };
    notification("item/completed", { threadId: "root-thread", turnId: "old-root-turn", item: { ...started, agentThreadId: "foreign-child" } });
    notification("item/completed", { threadId: "root-thread", turnId: "old-root-turn", item: { type: "collabAgentToolCall", id: "stale-call", senderThreadId: "root-thread", receiverThreadIds: ["foreign-child"], tool: "spawnAgent", status: "completed" } });
    notification("item/completed", { threadId: "root-thread", turnId: "root-turn", item: started });
    notification("item/completed", { threadId: "root-thread", turnId: "root-turn", item: { ...started, id: "subagent-completed-child-turn", kind: "completed" } });
    await vi.waitFor(() => expect(requests.some(rpc => rpc.method === "thread/read")).toBe(true));
    const read = requests.find(rpc => rpc.method === "thread/read")!;
    expect(read.params).toEqual({ threadId: "child-thread", includeTurns: true });
    notification("turn/completed", { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events.some(event => event.type === "result")).toBe(false);
    stdout.write(JSON.stringify({ id: read.id, result: { thread: { id: "child-thread", parentThreadId: "root-thread", turns: [{ id: "child-turn", items: [
      { type: "commandExecution", id: "child-command", status: "completed", command: "printf fixture", exitCode: 0, aggregatedOutput: "child-marker", durationMs: 2 },
      { type: "agentMessage", id: "child-message", text: "Not root output" },
    ] }] } } }) + "\n");
    await vi.waitFor(() => expect(events.some(event => event.type === "result")).toBe(true));
    expect(events).toContainEqual(expect.objectContaining({ type: "command_result", exitCode: 0, source: expect.objectContaining({ agentId: "child-thread", parentAgentId: "root" }) }));
    const terminal = events.findIndex(event => event.type === "result"), command = events.findIndex(event => event.type === "command_result");
    expect(command).toBeLessThan(terminal);
    expect(requests.filter(rpc => rpc.method === "thread/read")).toHaveLength(1);
    expect(requests.some(rpc => rpc.method === "thread/resume")).toBe(false);
    expect(events.some(event => JSON.stringify(event).includes("foreign-child") || event.type === "assistant_text" && event.text === "Not root output")).toBe(false);
    expect(events.some(event => event.type === "agent_status" && event.stopConfirmed)).toBe(false);
  } finally { await run.stopAndWait?.(); }
});
