import type { AssistantEvent } from "./assistant-api";

export type ToolOutput = { status: "completed" | "failed" | "cancelled" | "unknown"; output: string; truncated?: true; conflict?: true; durationMs?: number };
const MAX_TOOL_OUTPUT_CHARS = 32_768;
export const canShowToolOutput = (toolName: string) => !["ToolSearch", "AskUserQuestion", "hosty:development: environment_setup", "mcp__hosty-workspaces__environment_setup"].includes(toolName);

/** Revalidate recorded output too; transport envelopes are never presentation fields. */
export function recordedToolOutput(event: AssistantEvent): ToolOutput | null {
  if (event.type !== "tool_result" || typeof event.toolUseId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event.toolUseId)
    || typeof event.status !== "string" || !["completed", "failed", "cancelled", "unknown"].includes(event.status)
    || typeof event.output !== "string" || event.truncated !== undefined && event.truncated !== true) return null;
  let output = event.output.slice(0, MAX_TOOL_OUTPUT_CHARS);
  if (output.length < event.output.length && /[\uD800-\uDBFF]$/.test(output)) output = output.slice(0, -1);
  return { status: event.status as ToolOutput["status"], output,
    ...(typeof event.durationMs === "number" && Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 604_800_000 ? { durationMs: event.durationMs } : {}),
    ...(event.truncated === true || output.length < event.output.length ? { truncated: true } : {}) };
}
