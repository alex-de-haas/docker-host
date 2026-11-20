import { expect, it } from "vitest";
import type { SessionSubagent } from "../../../src/subagents/types";
import type { AssistantEvent } from "./assistant-api";
import { sessionSubagentTranscript } from "./session-subagents";

it("keeps later launches after the parent's intervening message and folds replay updates into their original rows", () => {
  const first: SessionSubagent = { id: "a", profileId: "dev", profileName: "Developer", prompt: "Implement", status: "running" };
  const second: SessionSubagent = { ...first, id: "b", profileId: "qa", profileName: "QA", prompt: "Verify" };
  const finished: SessionSubagent = { ...first, status: "completed", result: "Implemented." };
  const deleted: SessionSubagent = { ...second, status: "failed", chatAvailable: false };
  const event = (seq: number, child: SessionSubagent): AssistantEvent => ({ type: "session_subagent", seq, ts: "", child });
  const prose = { type: "assistant_text", seq: 2, ts: "", text: "Testing next." };
  const rows = sessionSubagentTranscript([event(1, first), prose, event(3, second), event(4, finished), event(1, first), event(5, deleted)], [finished, second]);
  expect(rows.map(row => row.type)).toEqual(["session_subagent_group", "assistant_text", "session_subagent_group"]);
  expect(rows[0]?.subagents).toEqual([finished]);
  expect(rows[2]?.subagents).toEqual([deleted]);
  expect(sessionSubagentTranscript([], [finished])[0]?.subagents).toEqual([finished]);
  expect(sessionSubagentTranscript([event(1, first), prose], [finished], 4)[0]?.subagents).toEqual([finished]);
  expect(sessionSubagentTranscript([event(5, finished)], [first], 4)[0]?.subagents).toEqual([finished]);
});

it("keeps parallel launches together across their qualified MCP calls, preserving errors and unrelated tools", () => {
  const child = (seq: number, id: string): AssistantEvent => ({ seq, ts: "", type: "session_subagent",
    child: { id, profileId: "dev", profileName: "Developer", status: "running", prompt: id } });
  const call = (seq: number, tool: string, server = "hosty-workflow"): AssistantEvent => ({ seq, ts: "", type: "tool_use",
    toolUseId: String(seq), toolName: `mcp__${server}__${tool}` });
  const first = call(1, "subagent_spawn"), wait = call(3, "subagent_wait"), failed = { seq: 4, ts: "", type: "tool_result", toolUseId: "3", status: "failed" },
    second = call(5, "subagent_spawn"), other = { ...call(7, "subagent_spawn"), mcp: { server: "another-server", tool: "subagent_spawn" } };
  const rows = sessionSubagentTranscript([first, child(2, "first"), wait, failed, second, child(6, "second"), other, child(8, "third")]);
  expect(rows.filter(row => row.type === "session_subagent_group").map(row => row.subagents?.map(agent => agent.id))).toEqual([["first", "second"], ["third"]]);
  expect(rows.filter(row => row.type !== "session_subagent_group")).toEqual([first, wait, failed, second, other]);
});
