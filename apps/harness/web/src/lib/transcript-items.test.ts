import { describe, expect, it } from "vitest";
import { transcriptItems } from "./transcript-items";
import type { AssistantEvent } from "./assistant-api";

const event = (seq: number, type: string, extra = {}): AssistantEvent => ({ seq, ts: "", type, ...extra });

describe("transcript activity", () => {
  it("groups calls without hiding approvals, questions or answer prose", () => {
    const items = transcriptItems([
      event(1, "user_message"), event(2, "tool_use", { toolName: "Read" }),
      event(3, "tool_use", { toolName: "ToolSearch" }), event(4, "tool_use", { toolName: "Grep" }),
      event(5, "approval_request"), event(6, "tool_use"), event(7, "question_request"),
      event(8, "assistant_text"), event(9, "tool_use"), event(10, "result"), event(11, "tool_use"),
    ], new Set());
    expect(items.map(item => item.key)).toEqual([
      "event-1", "activity-2", "event-5", "activity-6", "event-7", "event-8", "activity-9", "activity-11",
    ]);
    expect(items[1]).toMatchObject({ events: [{ seq: 2 }, { seq: 4 }] });
  });

  it("keeps a group's identity as more calls arrive and suppresses claimed uploads", () => {
    const events = [event(1, "attachment_added", { name: "report.txt" }), event(2, "tool_use")];
    const before = transcriptItems(events, new Set(["report.txt"]));
    const after = transcriptItems([...events, event(3, "tool_use")], new Set(["report.txt"]));
    expect(before[0].key).toBe(after[0].key);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ events: [{ seq: 2 }, { seq: 3 }] });
  });
});

it("attaches a late factual command result across prose and approvals without moving their order", () => {
  const items = transcriptItems([event(1, "user_message"), event(2, "tool_use", { toolName: "Bash", toolUseId: "first" }), event(3, "assistant_text"), event(4, "approval_request"), event(5, "command_result", { toolUseId: "first", status: "failed", exitCode: 2, durationMs: 4_000, summary: "1 failed" })], new Set());
  expect(items.map(item => item.key)).toEqual(["event-1", "activity-2", "event-3", "event-4"]);
  expect(items[1]).toMatchObject({ commandResults: { 2: { status: "failed", exitCode: 2, durationMs: 4_000, summary: "1 failed" } } });
});
it("never attributes a later user turn's or non-command tool result to a prior call", () => {
  const items = transcriptItems([event(1, "user_message"), event(2, "tool_use", { toolName: "Command", toolUseId: "same" }), event(3, "result", { status: "success" }), event(4, "user_message"), event(5, "command_result", { toolUseId: "same", status: "completed", exitCode: 0 }), event(6, "tool_use", { toolName: "Read", toolUseId: "read" }), event(7, "command_result", { toolUseId: "read", status: "completed" })], new Set());
  expect(items.find(item => item.key === "activity-2")).toMatchObject({ commandResults: {} });
  expect(items.filter(item => item.kind === "event" && item.event.type === "command_result").map(item => item.key)).toEqual(["event-5", "event-7"]);
});
it("keeps missing results unavailable and does not infer command success from the turn result", () => {
  expect(transcriptItems([event(1, "tool_use", { toolName: "Bash", toolUseId: "command" }), event(2, "result", { status: "success" })], new Set())[0]).toMatchObject({ commandResults: {} });
});
it("does not bind ambiguous native IDs and retains unmatched result records at their actual positions", () => {
  const items = transcriptItems([event(1, "tool_use", { toolName: "Command", toolUseId: "same" }), event(2, "command_result", { toolUseId: "same", status: "completed" }), event(3, "tool_use", { toolName: "Command", toolUseId: "same" }), event(4, "command_result", { toolUseId: "same", status: "failed" })], new Set());
  expect(items.filter(item => item.kind === "activity").every(item => Object.keys(item.commandResults).length === 0)).toBe(true);
  expect(items.filter(item => item.kind === "event").map(item => item.key)).toEqual(["event-2", "event-4"]);
});
it("deduplicates identical result delivery and makes conflicting results explicitly unknown", () => {
  const items = transcriptItems([event(1, "tool_use", { toolName: "Bash", toolUseId: "command" }), event(2, "command_result", { toolUseId: "command", status: "completed", exitCode: 0 }), event(3, "command_result", { toolUseId: "command", status: "failed", exitCode: 1 }), event(4, "command_result", { toolUseId: "command", status: "completed", exitCode: 0 })], new Set());
  expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ commandResults: { 1: { status: "unknown", conflict: true } } });
});

it.each([event(2, "result", { status: "success" }), event(2, "error"), ...["idle", "cancelled", "failed", "abandoned"].map(status => event(2, "session_status", { status }))])("does not associate a late result after a terminal turn boundary: %j", boundary => {
  const items = transcriptItems([event(1, "tool_use", { toolName: "Command", toolUseId: "command:run:1" }), boundary, event(3, "command_result", { toolUseId: "command:run:1", status: "completed", exitCode: 0 })], new Set());
  expect(items[0]).toMatchObject({ commandResults: {} }); expect(items.at(-1)).toMatchObject({ key: "event-3", kind: "event" });
});


it("matches out-of-order tool outputs by call identity across prose while keeping groups stable", () => {
  const calls = [event(1, "user_message"), event(2, "tool_use", { toolName: "mcp__core__list_apps", toolUseId: "first" }), event(3, "tool_use", { toolName: "mcp__core__list_apps", toolUseId: "second" })];
  const items = transcriptItems([...calls, event(4, "assistant_text"), event(5, "tool_result", { toolUseId: "second", status: "failed", output: "second failed" }), event(6, "tool_result", { toolUseId: "first", status: "completed", output: "first result" })], new Set());
  expect(items.map(item => item.key)).toEqual(["event-1", "activity-2", "event-4"]);
  expect(items[1]).toMatchObject({ toolResults: { 2: { status: "completed", output: "first result" }, 3: { status: "failed", output: "second failed" } } });
});
it("does not assign output from a later turn or duplicated identity to another tool", () => {
  const call = (seq: number) => event(seq, "tool_use", { toolName: "Read", toolUseId: "same" });
  const result = (seq: number) => event(seq, "tool_result", { toolUseId: "same", status: "completed", output: "private-result" });
  const items = transcriptItems([call(1), result(2), call(3), result(4), event(5, "user_message"), result(6)], new Set());
  expect(items.filter(item => item.kind === "activity").every(item => Object.keys(item.toolResults).length === 0)).toBe(true);
  expect(items.filter(item => item.kind === "event" && item.event.type === "tool_result").map(item => item.key)).toEqual(["event-2", "event-4", "event-6"]);
});
it("deduplicates repeated output, preserves empty output and marks conflicting recorded output unavailable", () => {
  const call = event(1, "tool_use", { toolName: "Command", toolUseId: "command" });
  const result = event(2, "tool_result", { toolUseId: "command", status: "completed", output: "" });
  expect(transcriptItems([call, result, { ...result, seq: 3 }], new Set())[0]).toMatchObject({ toolResults: { 1: { status: "completed", output: "" } } });
  expect(transcriptItems([call, result, { ...result, seq: 3, output: "different" }], new Set())[0]).toMatchObject({ toolResults: { 1: { status: "unknown", output: "", conflict: true } } });
});

it("never shows hidden setup output or assigns a hidden duplicate identity to a visible call", () => {
  const visible = event(1, "tool_use", { toolName: "Read", toolUseId: "same" });
  const hidden = event(2, "tool_use", { toolName: "ToolSearch", toolUseId: "same" });
  const output = event(3, "tool_result", { toolUseId: "same", status: "completed", output: "private" });
  expect(transcriptItems([visible, hidden, output], new Set())[0]).toMatchObject({ toolResults: {} });
  expect(transcriptItems([{ ...hidden, toolName: "mcp__hosty-workspaces__environment_setup" }, output], new Set())).toHaveLength(1);
});
