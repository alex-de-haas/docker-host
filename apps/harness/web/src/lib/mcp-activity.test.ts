import { expect, it } from "vitest";
import type { AssistantEvent } from "./assistant-api";
import { observedMcpActivity } from "./mcp-activity";

const event = (seq: number, type: string, extra = {}): AssistantEvent => ({ seq, ts: "", type, ...extra });
const call = (seq: number, toolUseId?: string, extra = {}) => event(seq, "tool_use", {
  toolName: "mcp__core__list_apps", ...(toolUseId ? { toolUseId } : {}), ...extra,
});
const result = (seq: number, toolUseId: string, status = "completed", extra = {}) => event(seq, "tool_result", { toolUseId, status, output: "", ...extra });

it("counts only recorded MCP calls and retains Hosty activity independently of a large catalog", () => {
  const catalog = event(1, "context_usage", { usage: { mcp: { tools: Array.from({ length: 778 }, (_, i) => ({ server: "catalog", name: `tool${i}` })) } } });
  const other = Array.from({ length: 300 }, (_, i) => call(i + 2, undefined, { toolName: `mcp__other__tool${i}` }));
  const activity = observedMcpActivity([catalog, ...other, call(302, "hosty")]);
  expect(activity.total).toBe(301);
  expect(activity.tools).toHaveLength(301);
  expect(activity.tools.find(tool => tool.server === "core")).toEqual({ server: "core", name: "list_apps", calls: 1, completed: 0, failed: 0, cancelled: 0, unknown: 1 });
});

it("keeps legacy calls without IDs unknown and never infers execution from approval or turn status", () => {
  const activity = observedMcpActivity([call(1), call(2), event(3, "approval_decision", { toolName: "mcp__core__list_apps", decision: "deny" }), event(4, "result", { status: "success" })]);
  expect(activity).toEqual({ total: 2, tools: [{ server: "core", name: "list_apps", calls: 2, completed: 0, failed: 0, cancelled: 0, unknown: 2 }] });
});

it("deduplicates replayed durable records before joining outcomes", () => {
  const first = call(1, "first"), completed = result(2, "first");
  const activity = observedMcpActivity([first, completed, first, completed, call(3, "second"), result(4, "second", "failed")]);
  expect(activity).toEqual({ total: 2, tools: [{ server: "core", name: "list_apps", calls: 2, completed: 1, failed: 1, cancelled: 0, unknown: 0 }] });
});

it("keeps distinct records sharing an ID ambiguous even when one result arrived earlier", () => {
  const activity = observedMcpActivity([call(1, "same"), result(2, "same"), call(3, "same", { toolName: "mcp__other__read" }), result(4, "same", "failed")]);
  expect(activity.total).toBe(2);
  expect(activity.tools.every(tool => tool.unknown === 1 && tool.completed === 0 && tool.failed === 0)).toBe(true);
});

it("allows repeated native IDs across turns while rejecting late results from the earlier turn", () => {
  const activity = observedMcpActivity([call(1, "same"), result(2, "same", "cancelled"), event(3, "result"), event(4, "user_message"), result(5, "same"), call(6, "same"), result(7, "same", "failed")]);
  expect(activity).toEqual({ total: 2, tools: [{ server: "core", name: "list_apps", calls: 2, completed: 0, failed: 1, cancelled: 1, unknown: 0 }] });
});

it.each(["user_message", "session_created", "result", "error", "session_status"])("does not join results across a %s boundary", type => {
  const activity = observedMcpActivity([call(1, "first"), event(2, type, { status: "idle" }), result(3, "first")]);
  expect(activity.tools[0]).toMatchObject({ calls: 1, completed: 0, unknown: 1 });
});

it("does not attach a result that precedes its call or has no unique matching MCP record", () => {
  const activity = observedMcpActivity([result(1, "first"), call(2, "first"), call(3, "collision"), event(4, "tool_use", { toolName: "Read", toolUseId: "collision" }), result(5, "collision")]);
  expect(activity.tools[0]).toMatchObject({ calls: 2, completed: 0, unknown: 2 });
});

it("counts reported terminal statuses while preserving unknown and conflicting outcomes", () => {
  const activity = observedMcpActivity([
    call(1, "completed"), result(2, "completed"), result(3, "completed"),
    call(4, "failed"), result(5, "failed", "failed"),
    call(6, "cancelled"), result(7, "cancelled", "cancelled"),
    call(8, "unknown"), result(9, "unknown", "unknown"),
    call(10, "conflict"), result(11, "conflict"), result(12, "conflict", "failed"), result(13, "conflict"),
    call(14, "changed-output"), result(15, "changed-output"), result(16, "changed-output", "completed", { output: "different" }),
    call(17, "invalid"), result(18, "invalid", "success"),
  ]);
  expect(activity).toEqual({ total: 7, tools: [{ server: "core", name: "list_apps", calls: 7, completed: 1, failed: 1, cancelled: 1, unknown: 4 }] });
});

it("uses explicit metadata instead of an ambiguous alias and skips invalid metadata", () => {
  const activity = observedMcpActivity([
    call(1, "explicit", { toolName: "mcp__wrong__alias", mcp: { server: "server__with__seams", tool: "tool__with__seams" } }), result(2, "explicit"),
    call(3, undefined, { mcp: null }), call(4, undefined, { mcp: { server: "core" } }), call(5, undefined, { mcp: { server: "core", tool: "bad\nname" } }),
    call(6, undefined, { mcp: { server: "core", tool: "x".repeat(257) } }), call(7, undefined, { mcp: { server: " ", tool: "read" } }),
    call(8, undefined, { toolName: `mcp__${"x".repeat(257)}__read` }), call(9, undefined, { toolName: "mcp__core__bad\u007fname" }),
  ]);
  expect(activity).toEqual({ total: 1, tools: [{ server: "server__with__seams", name: "tool__with__seams", calls: 1, completed: 1, failed: 0, cancelled: 0, unknown: 0 }] });
});

it("does not parse scripts, batches, subagents, approval names or orphan results as MCP calls", () => {
  expect(observedMcpActivity([
    event(1, "tool_use", { toolName: "functions.exec", input: 'await tools.mcp__core__list_apps({})' }),
    event(2, "tool_use", { toolName: "Task", input: { tool: "mcp__core__list_apps" } }),
    event(3, "approval_request", { toolName: "mcp__core__list_apps" }), result(4, "orphan"),
    call(5, undefined, { toolName: "mcp____read" }), call(6, undefined, { toolName: "mcp__core__" }),
    call(0), call(-1), call(Number.NaN),
  ])).toEqual({ total: 0, tools: [] });
});
