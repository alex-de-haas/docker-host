import { sanitizeCommandResult, commandTestSummary, type CommandResult } from "@hosty/agent-provider-runtime/harness/command-result";
export { commandToolUseId, CommandCallHistory } from "@hosty/agent-provider-runtime/harness/command-result";

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** BashOutput has interrupted/stdout/stderr, but no final exit code or duration in the shipped SDK. */
export function claudeCommandResult(toolUseId: string, block: unknown, structured: unknown): CommandResult | null {
  const result = fields(block), output = fields(structured);
  const known = typeof output.stdout === "string" && typeof output.stderr === "string" && typeof output.interrupted === "boolean";
  const background = typeof output.backgroundTaskId === "string" || output.backgroundedByUser === true || output.detachedToolCall === true;
  const status = !known || background ? "unknown" : output.interrupted === true ? "cancelled"
    : result.is_error === true ? "failed" : result.is_error === undefined || result.is_error === false ? "completed" : "unknown";
  return sanitizeCommandResult({ type: "command_result", toolUseId, status,
    ...(known && !background && status !== "unknown" ? { summary: commandTestSummary(output.stdout) } : {}) });
}
