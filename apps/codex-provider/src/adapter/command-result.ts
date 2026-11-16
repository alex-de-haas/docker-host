import { sanitizeCommandResult, commandTestSummary, type CommandResult } from "@hosty/agent-provider-runtime/harness/command-result";
export { commandToolUseId, CommandCallHistory } from "@hosty/agent-provider-runtime/harness/command-result";

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const code = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647;
const duration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 604_800_000;

/** Verified from the pinned app-server v2 CommandExecution fields. */
export function codexCommandResult(toolUseId: string, value: unknown): CommandResult | null {
  const item = fields(value);
  if (item.status === "declined") return null;
  const exitCode = code(item.exitCode) ? item.exitCode : undefined;
  const status = item.status === "completed" ? exitCode === undefined ? "unknown" : exitCode === 0 ? "completed" : "failed"
    : item.status === "failed" ? "failed" : "unknown";
  return sanitizeCommandResult({ type: "command_result", toolUseId, status,
    ...(exitCode !== undefined ? { exitCode } : {}), ...(duration(item.durationMs) ? { durationMs: item.durationMs } : {}),
    ...(status !== "unknown" ? { summary: commandTestSummary(item.aggregatedOutput) } : {}) });
}

