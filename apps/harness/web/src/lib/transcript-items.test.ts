import { describe, expect, it } from "vitest";
import { orderedHistory, transcriptItems } from "./transcript-items";
import type { AssistantEvent } from "./assistant-api";

const event = (seq: number, type: string, extra = {}): AssistantEvent => ({ seq, ts: "", type, ...extra });

describe("transcript activity", () => {
  it("places an older run's recovered answer in its original turn", () => {
    const providerSource = { runId: "old", generation: "first", provider: { installationId: "one", appId: "agent", key: "chat" } };
    const events = [event(1, "user_message"), event(2, "assistant_text", { providerSource }), event(3, "result", { providerSource }),
      event(4, "user_message"), event(5, "assistant_text"), event(6, "assistant_text", { providerSource, providerHistoryEarlier: true })];
    expect(transcriptItems(events, new Set()).map(item => item.key)).toEqual(["event-1", "event-2", "event-6", "event-4", "event-5"]);
  });

  it("inserts separate recovery markers between disjoint ranges without hiding the new message", () => {
    const scope = { sessionId: "s", epoch: "archive" };
    const msg = (seq: number, position: number) => event(seq, "assistant_text", {
      text: String(position), providerSource: { runId: "run" }, providerHistoryPosition: { ...scope, position },
    });
    const events = [msg(1, 140), msg(2, 185), msg(3, 211)];
    const gaps = [{ ...scope, from: 141, to: 180 }, { ...scope, from: 186, to: 210 }];
    expect(orderedHistory(events, gaps).map(e => e.text ?? e.gap)).toEqual(["140", gaps[0], "185", gaps[1], "211"]);
    expect(orderedHistory([...events, msg(4, 210), msg(5, 180)], []).map(e => e.text)).toEqual(["140", "180", "185", "210", "211"]);
  });

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

describe("interrupted public observation", () => {
  const runId = "00000000-0000-4000-8000-000000000001", generation = "00000000-0000-4000-8000-000000000002";
  const call = event(1, "tool_use", { toolName: "Bash", toolUseId: "provider-command", providerGeneration: generation, providerEventId: `${runId}:tool:root:native-command` });
  const failed = event(2, "session_status", { status: "failed", providerObservation: { runId, generation, stopConfirmed: false } });
  const output = event(3, "tool_result", { toolUseId: "provider-command", status: "unknown", output: "Command interrupted", providerGeneration: generation, providerEventId: `${runId}:output:root:native-command:unknown` });
  const command = event(4, "command_result", { toolUseId: "provider-command", status: "unknown", providerGeneration: generation, providerEventId: `${runId}:command:root:native-command:unknown` });

  it("retains exact run/source pairing across observation failure until confirmed cancellation", () => {
    const items = transcriptItems([call, failed, output, command, event(5, "session_status", { status: "cancelled" })], new Set());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "activity", toolResults: { 1: { status: "unknown", output: "Command interrupted" } }, commandResults: { 1: { status: "unknown" } } });
    expect(items[0].kind === "activity" && items[0].commandResults[1]).not.toHaveProperty("exitCode");
  });

  it.each([
    { providerObservation: undefined },
    { providerObservation: { runId, generation, stopConfirmed: true } },
    { providerObservation: { runId: "another", generation, stopConfirmed: false } },
    { providerObservation: { runId, generation: "00000000-0000-4000-8000-000000000003", stopConfirmed: false } },
  ])("keeps legacy, unqualified and foreign failure boundaries strict: %j", marker => {
    const items = transcriptItems([call, { ...failed, ...marker }, output, command], new Set());
    expect(items[0]).toMatchObject({ commandResults: {}, toolResults: {} });
    expect(items.filter(item => item.kind === "event")).toHaveLength(2);
  });

  it.each([
    { providerGeneration: "00000000-0000-4000-8000-000000000003" },
    { providerEventId: `${runId}:output:child:native-command:unknown` },
    { providerEventId: undefined },
    { toolUseId: "different-source-command" },
  ])("never joins an unqualified or foreign output across the marker: %j", change => {
    const items = transcriptItems([call, failed, { ...output, ...change }], new Set());
    expect(items[0]).toMatchObject({ toolResults: {} }); expect(items.at(-1)).toMatchObject({ kind: "event", key: "event-3" });
  });

  it.each([event(3, "user_message"), event(3, "error"), event(3, "session_status", { status: "cancelled" })])("ends even qualified pairing at the next factual boundary: %j", boundary => {
    const items = transcriptItems([call, failed, boundary, { ...output, seq: 4 }, { ...command, seq: 5 }], new Set());
    expect(items[0]).toMatchObject({ commandResults: {}, toolResults: {} });
    expect(items.filter(item => item.kind === "event" && ["tool_result", "command_result"].includes(item.event.type))).toHaveLength(2);
  });
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

describe("decided approvals", () => {
  const call = (seq: number, toolUseId = "call") => event(seq, "tool_use", { toolName: "Bash", toolUseId });
  const request = (seq: number, approvalId = "a", toolUseId: string | null = "call") => event(seq, "approval_request", { approvalId, toolName: "Bash", ...(toolUseId ? { toolUseId } : {}) });
  const decided = new Map([["a", { decision: "deny", message: "Use the safe directory" }]]);
  const approvalFlow = (first: AssistantEvent, second: AssistantEvent) => [event(1, "user_message"), first, second, event(4, "session_status", { status: "awaiting_approval" }),
    event(5, "approval_decision", { approvalId: "a", decision: "deny" }), event(6, "session_status", { status: "running" }), call(7, "next")];

  it.each([["call first (Claude)", call(2), request(3)], ["approval first (Codex)", request(2), call(3)]])("folds into its call and keeps one group: %s", (_, first, second) => {
    const items = transcriptItems(approvalFlow(first, second), new Set(), decided);
    expect(items.map(item => item.key)).toEqual(["event-1", `activity-${first.type === "tool_use" ? 2 : 3}`]);
    const seq = first.type === "tool_use" ? first.seq : second.seq;
    expect(items[1]).toMatchObject({ events: [{ seq }, { seq: 7 }], approvals: { [seq]: { decision: "deny", message: "Use the safe directory" } } });
  });
  it("keeps an open, unidentified, ambiguous or hidden-call approval as its own card", () => {
    const open = transcriptItems(approvalFlow(call(2), request(3)), new Set());
    expect(open.map(item => item.key)).toEqual(["event-1", "activity-2", "event-3", "activity-7"]);
    expect(transcriptItems([call(1), request(2, "a", null)], new Set(), decided).map(item => item.key)).toEqual(["activity-1", "event-2"]);
    expect(transcriptItems([call(1), call(2), request(3)], new Set(), decided).map(item => item.key)).toEqual(["activity-1", "event-3"]);
    expect(transcriptItems([call(1), request(2), request(3)], new Set(), decided).filter(item => item.kind === "event")).toHaveLength(2);
    expect(transcriptItems([event(1, "tool_use", { toolName: "ToolSearch", toolUseId: "call" }), request(2)], new Set(), decided).map(item => item.key)).toEqual(["event-2"]);
  });
  it("never pairs an approval with a call from another recorded turn", () => {
    const items = transcriptItems([call(1), event(2, "result", { status: "success" }), event(3, "user_message"), request(4)], new Set(), decided);
    expect(items.map(item => item.key)).toEqual(["activity-1", "event-3", "event-4"]);
  });
});

it("never shows hidden setup output or assigns a hidden duplicate identity to a visible call", () => {
  const visible = event(1, "tool_use", { toolName: "Read", toolUseId: "same" });
  const hidden = event(2, "tool_use", { toolName: "ToolSearch", toolUseId: "same" });
  const output = event(3, "tool_result", { toolUseId: "same", status: "completed", output: "private" });
  expect(transcriptItems([visible, hidden, output], new Set())[0]).toMatchObject({ toolResults: {} });
  expect(transcriptItems([{ ...hidden, toolName: "mcp__hosty-workspaces__environment_setup" }, output], new Set())).toHaveLength(1);
});
