import { afterEach, expect, it, vi } from "vitest";
import { CodexChildren } from "./codex-children.js";
import type { HarnessEvent, HarnessEventSource } from "@hosty/agent-provider-runtime/harness/adapter";

afterEach(() => vi.useRealTimers());
const activity = (kind: string, id = kind === "completed" ? "subagent-completed-child-turn" : "spawn-call", child = "child-thread") => ({
  threadId: "root-thread", turnId: "root-turn", item: { type: "subAgentActivity", id, kind,
    agentThreadId: child, agentPath: "/root/fixture", model: "fixture", reasoningEffort: "medium" },
});
const command = { type: "commandExecution", id: "child-command", command: "printf fixture", status: "completed", exitCode: 0, aggregatedOutput: "child-marker", durationMs: 3 };
const history = (items: unknown[] = [command]) => ({ thread: { id: "child-thread", parentThreadId: "root-thread", turns: [
  { id: "old-child-turn", items: [{ ...command, id: "old-command", aggregatedOutput: "old-marker" }] },
  { id: "child-turn", items },
] } });
function fixture(value: unknown = history()) {
  const events: HarnessEvent[] = [], sources = new Map<string, HarnessEventSource>();
  const read = vi.fn(async (_id: string): Promise<unknown> => value);
  const observer = new CodexChildren("adapter-run", sources, read, event => events.push(event), () => true);
  const observe = (params: Record<string, unknown>) => observer.observe(params, "root-thread", "root-turn", 1);
  return { events, sources, read, observer, observe };
}

it("projects the actual0.167 started/completed forms and only the exact completed child turn", async () => {
  const f = fixture();
  f.observe(activity("started")); f.observe(activity("completed")); await f.observer.finish(1);
  expect(f.read).toHaveBeenCalledExactlyOnceWith("child-thread");
  const spawn = f.events.find(event => event.type === "tool_use" && event.toolName === "Agent: spawn");
  const child = f.events.filter(event => event.type === "tool_use" && event.toolName === "Command");
  expect(child).toEqual([expect.objectContaining({ source: { agentId: "child-thread", parentAgentId: "root", parentToolCallId: spawn?.type === "tool_use" ? spawn.toolUseId : "missing" } })]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command_result", exitCode: 0, source: expect.objectContaining({ agentId: "child-thread" }) }));
  expect(f.events.some(event => JSON.stringify(event).includes("old-marker"))).toBe(false);
  expect(f.events.some(event => event.type === "result" || event.type === "agent_status" && event.stopConfirmed)).toBe(false);
});

it("reads the active assignment before completion and the exact final answer from the verified child turn", async () => {
  const events: HarnessEvent[] = [], prompt = { type: "userMessage", content: [{ type: "text", text: "Check versions" }] };
  const final = { type: "agentMessage", phase: "final_answer", text: "Versions agree" };
  const value = history([prompt, { ...final, phase: "commentary", text: "Working" }, final, { ...final, delivery: "async", text: "A question" }]);
  const observer = new CodexChildren("run", new Map(), async () => value, event => events.push(event), () => true,
    async () => ({ data: [{ id: "child-turn", rootTurnId: "root-turn", status: "inProgress", items: [prompt] }] }));
  observer.observe(activity("started"), "root-thread", "root-turn", 1);
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "agent_status", state: "running", prompt: "Check versions" })));
  observer.observe(activity("completed"), "root-thread", "root-turn", 1);
  await observer.finish(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent_status", state: "succeeded", prompt: "Check versions", response: "Versions agree" }));
  expect(JSON.stringify(events)).not.toContain("A question");
});

it("ignores foreign/stale root activity and never infers a parent from agentPath or receiverAgents", async () => {
  const f = fixture();
  f.observe({ ...activity("started"), turnId: "stale-root-turn" });
  f.observe({ ...activity("started"), threadId: "foreign-thread" });
  f.observe({ ...activity("started"), item: { ...activity("started").item, type: "collabAgentToolCall", receiverAgents: [{ agentPath: "/root/foreign" }] } });
  f.observe(activity("completed"));
  await f.observer.finish(1);
  expect(f.sources.size).toBe(0); expect(f.read).not.toHaveBeenCalled();
  expect(f.events.filter(event => event.type === "tool_use")).toEqual([]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
});

it("deduplicates repeated activity/history without inventing duplicate tool starts", async () => {
  const f = fixture();
  f.observe(activity("started")); f.observe(activity("started"));
  f.observe(activity("completed")); f.observe(activity("completed"));
  await f.observer.finish(1);
  f.observe(activity("completed"));
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.events.filter(event => event.type === "tool_use")).toHaveLength(2);
});

it.each(["wrong-thread", "wrong-parent", "wrong-turn", "oversized"])("rejects %s child history with explicit partial coverage", async kind => {
  const value = history();
  if (kind === "wrong-thread") value.thread.id = "foreign-thread";
  if (kind === "wrong-parent") value.thread.parentThreadId = "foreign-parent";
  if (kind === "wrong-turn") value.thread.turns[1]!.id = "different-turn";
  if (kind === "oversized") (value as unknown as Record<string, unknown>).extra = "x".repeat(2 * 1024 * 1024);
  const f = fixture(value); f.observe(activity("started")); f.observe(activity("completed")); await f.observer.finish(1);
  expect(f.events.some(event => event.type === "command_result")).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
});

it("does not poison completed history with an earlier interrupted observation", async () => {
  const f = fixture(); f.observe(activity("started")); f.observe(activity("interrupted", "interrupt-call"));
  expect(f.read).not.toHaveBeenCalled();
  f.observe(activity("completed")); await f.observer.finish(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command_result", exitCode: 0 }));
  expect(f.events.filter(event => event.type === "agent_status").every(event => !event.stopConfirmed)).toBe(true);
});

it("derives nested lineage only from the exact verified child turn, rejecting stale live child activity", async () => {
  const spawn = { ...activity("started", "grandchild-spawn", "grandchild-thread").item };
  const completed = { ...activity("completed", "subagent-completed-grandchild-turn", "grandchild-thread").item };
  const f = fixture(history([spawn, completed]));
  f.read.mockImplementation(async id => id === "child-thread" ? history([spawn, completed])
    : { thread: { id, parentThreadId: "child-thread", turns: [{ id: "grandchild-turn", items: [command] }] } });
  f.observe(activity("started"));
  f.observe({ threadId: "child-thread", turnId: "stale-child-turn", item: { ...spawn, agentThreadId: "foreign-grandchild" } });
  expect(f.sources.has("foreign-grandchild")).toBe(false);
  f.observe(activity("completed")); await f.observer.finish(1);
  expect(f.read.mock.calls.map(call => call[0])).toEqual(["child-thread", "grandchild-thread"]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command_result", source: expect.objectContaining({ agentId: "grandchild-thread", parentAgentId: "child-thread" }) }));
});

it("bounds all child reads together and drops metadata arriving after finalization", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release!: (value: unknown) => void;
  f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  for (let index = 0; index < 12; index++) {
    f.observe(activity("started", "spawn-" + index, "child-" + index));
    f.observe(activity("completed", "subagent-completed-turn-" + index, "child-" + index));
  }
  expect(f.read).toHaveBeenCalledTimes(8);
  const finished = f.observer.finish(1);
  await vi.advanceTimersByTimeAsync(5001); await finished;
  release(history()); await Promise.resolve();
  expect(f.events.some(event => event.type === "command_result")).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
});

it("preserves unknown command outcomes rather than manufacturing an exit or stop proof", async () => {
  const f = fixture(history([{ ...command, status: "inProgress", exitCode: null }]));
  f.observe(activity("started")); f.observe(activity("completed")); await f.observer.finish(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command_result", status: "unknown" }));
  expect(f.events.filter(event => event.type === "command_result").some(event => event.exitCode !== undefined)).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "native_effect", state: "unknown", source: expect.objectContaining({ agentId: "child-thread" }) }));
});

it("marks child history partial when the root finishes before any child completion", async () => {
  const f = fixture(); f.observe(activity("started")); await f.observer.finish(1);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
  expect(f.events.filter(event => event.type === "agent_status")).toEqual([expect.objectContaining({ state: "running", stopConfirmed: false })]);
});

it("invalidates completed child coverage when another interaction has no verified completion", async () => {
  const f = fixture(); f.observe(activity("started")); f.observe(activity("completed"));
  await vi.waitFor(() => expect(f.events.some(event => event.type === "command_result")).toBe(true));
  f.observe(activity("interacted", "followup-call")); await f.observer.finish(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
});


it("keeps verified completed child history complete when its native close reports interrupted", async () => {
  const f = fixture(); f.observe(activity("started")); f.observe(activity("completed"));
  await vi.waitFor(() => expect(f.events.some(event => event.type === "command_result")).toBe(true));
  f.observe(activity("interrupted", "close-completed-child"));
  await f.observer.finish(1);
  expect(f.events.filter(event => event.type === "notice")).toEqual([]);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.events.filter(event => event.type === "agent_status").every(event => !event.stopConfirmed)).toBe(true);
});

it("accepts an already admitted completed-history read finishing after child close", async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  f.observe(activity("started")); f.observe(activity("completed"));
  f.observe(activity("interrupted", "close-while-reading"));
  const finished = f.observer.finish(1);
  release(history()); await finished;
  expect(f.events.filter(event => event.type === "notice")).toEqual([]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command_result", exitCode: 0 }));
  expect(f.read).toHaveBeenCalledTimes(1);
});

it("keeps an interrupted child partial when an intervening interaction supersedes the completed read", async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  f.observe(activity("started")); f.observe(activity("completed"));
  f.observe(activity("interacted", "later-interaction"));
  f.observe(activity("interrupted", "close-later-interaction"));
  const finished = f.observer.finish(1);
  release(history()); await finished;
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
  expect(f.events.filter(event => event.type === "agent_status").every(event => !event.stopConfirmed)).toBe(true);
});

it("keeps active or previously observed unverified interrupted children partial", async () => {
  const f = fixture();
  f.sources.set("child-thread", { agentId: "child-thread", parentAgentId: "root", parentToolCallId: "observed-spawn" });
  f.observe(activity("interrupted", "interrupt-unverified-child"));
  await f.observer.finish(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "notice", incomplete: ["tools"] }));
  expect(f.read).not.toHaveBeenCalled();
  expect(f.events.some(event => event.type === "command_result")).toBe(false);
});
