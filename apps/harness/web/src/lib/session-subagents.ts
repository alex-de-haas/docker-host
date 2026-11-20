import type { SessionSubagent } from "../../../src/subagents/types";
import type { AssistantEvent } from "./assistant-api";
import { mcpIdentity } from "./mcp-activity";

const workflowTools = new Set(["subagent_profiles", "subagent_spawn", "subagent_status", "subagent_wait"]);
const groupBoundaries = new Set(["assistant_text", "user_message", "subagent_assignment", "result", "error", "notice", "question_request", "approval_request", "native_agent_group"]);

function separatesLaunches(event: AssistantEvent): boolean {
  if (event.type !== "tool_use") return groupBoundaries.has(event.type);
  const tool = mcpIdentity(event);
  return tool?.server !== "hosty-workflow" || !workflowTools.has(tool.name);
}

/** Keep each child at its launch position as later status and result events arrive. */
export function sessionSubagentTranscript(events: AssistantEvent[], snapshot: readonly SessionSubagent[] = [], snapshotThrough = 0): AssistantEvent[] {
  const rows: AssistantEvent[] = [];
  const locations = new Map<string, { group: SessionSubagent[]; index: number; seq: number }>();
  let group: SessionSubagent[] | undefined;

  const insert = (child: SessionSubagent, seq: number, ts: string) => {
    if (!group) {
      group = [];
      rows.push({ type: "session_subagent_group", seq, ts, subagents: group });
    }
    locations.set(child.id, { group, index: group.length, seq });
    group.push(child);
  };

  for (const event of events) {
    if (event.type !== "session_subagent") {
      rows.push(event);
      if (separatesLaunches(event)) group = undefined;
      continue;
    }
    const child = event.child;
    if (!child?.id) continue;
    const previous = locations.get(child.id);
    if (!previous) insert(child, event.seq, event.ts);
    else if (event.seq >= previous.seq) {
      previous.group[previous.index] = child;
      previous.seq = event.seq;
    }
  }
  // Keep the launch position from replay and apply a newer checkpoint if a later row is missing.
  group = undefined;
  for (const child of snapshot) {
    const previous = locations.get(child.id);
    if (!previous) insert(child, Number.MIN_SAFE_INTEGER, "");
    else if (previous.seq <= snapshotThrough) previous.group[previous.index] = child;
  }
  return rows;
}
