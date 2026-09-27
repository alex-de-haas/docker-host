import type { AssistantEvent } from "./assistant-api";
import { isListedToolUse } from "./tool-display";

export type TranscriptItem =
  | { kind: "event"; key: string; event: AssistantEvent }
  | { kind: "activity"; key: string; events: AssistantEvent[] };

/** Group only adjacent calls; an approval/question or turn boundary always ends a group. */
export function transcriptItems(events: AssistantEvent[], claimed: ReadonlySet<string>): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let activity: Extract<TranscriptItem, { kind: "activity" }> | undefined;
  for (const event of events) {
    if (event.type === "tool_use") {
      if (!isListedToolUse(String(event.toolName ?? "tool"))) continue;
      if (!activity) {
        activity = { kind: "activity", key: `activity-${event.seq}`, events: [] };
        items.push(activity);
      }
      activity.events.push(event);
      continue;
    }
    // Bookkeeping records have no surface, but must not join calls across different turns.
    activity = undefined;
    const visible = event.type === "attachment_added"
      ? !claimed.has(String(event.name ?? ""))
      : ["user_message", "assistant_text", "app_context_changed", "approval_request", "question_request", "notice", "error"].includes(event.type);
    if (visible) items.push({ kind: "event", key: `event-${event.seq}`, event });
  }
  return items;
}
