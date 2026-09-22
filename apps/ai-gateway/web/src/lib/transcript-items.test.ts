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
