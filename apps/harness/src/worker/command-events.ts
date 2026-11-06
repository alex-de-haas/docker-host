import { suggestionText } from "../harness/prompt-suggestion.js";
import { sanitizeToolResult } from "../harness/tool-result.js";
import { sanitizeCommandResult } from "../harness/command-result.js";
import { safeIdentity, type WorkerEvent, type WorkerReceipt } from "./contracts.js";

export function validWorkerCommandEnvelope(frame: WorkerEvent): boolean {
  return safeIdentity(frame.runId) && safeIdentity(frame.generation)
    && Number.isSafeInteger(frame.sequence) && frame.sequence > 0;
}

/** Preserve durable sequence identity while rebuilding only the bounded command metadata or tool content payload. */
export function sanitizeWorkerCommandFrame(frame: WorkerEvent): WorkerEvent | null {
  if (frame.event?.type === "prompt_suggestion" || frame.event?.type === "answer_complete") {
    if (!validWorkerCommandEnvelope(frame)) return null;
    const event = frame.event.type === "answer_complete" ? { type: "answer_complete" as const } : {
      type: "prompt_suggestion" as const, text: suggestionText(frame.event.text),
      ...(["unsupported", "unavailable", "timeout"].includes(frame.event.reason ?? "") ? { reason: frame.event.reason } : {}),
    };
    return { runId: frame.runId, generation: frame.generation, sequence: frame.sequence, event };
  }
  if (frame.event?.type !== "command_result" && frame.event?.type !== "tool_result") return frame;
  if (!validWorkerCommandEnvelope(frame)) return null;
  const event = frame.event.type === "tool_result" ? sanitizeToolResult(frame.event) : sanitizeCommandResult(frame.event);
  return event ? { runId: frame.runId, generation: frame.generation, sequence: frame.sequence, event } : null;
}

/** Command metadata and tool output are neither a pending decision nor a final turn result. */
export function sanitizeWorkerCommandReceipt(receipt: WorkerReceipt): WorkerReceipt {
  const pending = receipt.pending?.filter(frame => frame.event?.type !== "command_result" && frame.event?.type !== "tool_result");
  let snapshot = receipt.snapshot;
  if (snapshot?.result?.type === "command_result" || snapshot?.result?.type === "tool_result") {
    const { result: _command, ...retained } = snapshot;
    snapshot = retained;
  }
  if (snapshot?.contextUsage?.event?.type === "command_result" || snapshot?.contextUsage?.event?.type === "tool_result") {
    const { contextUsage: _context, ...retained } = snapshot;
    snapshot = retained;
  }
  return { ...receipt, ...(pending === undefined ? {} : { pending }), ...(snapshot === undefined ? {} : { snapshot }) };
}
