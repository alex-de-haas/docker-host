import { createHash } from "node:crypto";
import type { HarnessEvent } from "./adapter.js";

export type CommandResult = Extract<HarnessEvent, { type: "command_result" }>;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const count = "[0-9]{1,7}";
const summaryPattern = new RegExp(`^(?:${count} passed|${count} failed|${count} passed · ${count} failed)$`);
const code = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647;
const duration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 604_800_000;

/** A durable display projection, including at untrusted worker/replay boundaries. Never copy output. */
export function sanitizeCommandResult(value: unknown): CommandResult | null {
  const source = fields(value);
  if (source.type !== "command_result" || !safeId(source.toolUseId) || typeof source.status !== "string" || !["completed", "failed", "cancelled", "unknown"].includes(source.status)) return null;
  if (source.exitCode !== undefined && !code(source.exitCode) || source.durationMs !== undefined && !duration(source.durationMs)) return null;
  if (source.status === "completed" && source.exitCode !== undefined && source.exitCode !== 0) return null;
  return { type: "command_result", toolUseId: source.toolUseId, status: source.status as CommandResult["status"],
    ...(source.exitCode !== undefined ? { exitCode: Number(source.exitCode) } : {}),
    ...(source.durationMs !== undefined ? { durationMs: Number(source.durationMs) } : {}),
    ...((source.status === "completed" || source.status === "failed") && typeof source.summary === "string" && source.summary.length <= 64 && summaryPattern.test(source.summary) ? { summary: source.summary } : {}) };
}

/** One mapping for a provider ID, scoped to a live adapter run, turn and parent tool. */
export function commandToolUseId(run: string, turn: number, rawId: unknown, parent = "main"): string | undefined {
  if (!safeId(rawId) || !safeId(run) || !Number.isSafeInteger(turn) || turn < 1 || !safeId(parent)) return;
  const id = `command:${run}:${turn}:${createHash("sha256").update(JSON.stringify([rawId, parent])).digest("hex")}`;
  return safeId(id) ? id : undefined;
}

/** Bounded replay tombstones: collisions can omit a display result, never bind it to another call. */
export class CommandCallHistory {
  private readonly bits = new Uint8Array(65_536);
  seenOrRecord(key: string): boolean {
    if (key.length > 1024) return true;
    const digest = createHash("sha256").update(key).digest();
    const positions = Array.from({ length: 7 }, (_, index) => digest.readUInt32LE(index * 4) % (this.bits.length * 8));
    const seen = positions.every(position => (this.bits[position >>> 3]! & (1 << (position & 7))) !== 0);
    for (const position of positions) this.bits[position >>> 3]! |= 1 << (position & 7);
    return seen;
  }
}

/** Recognize numeric test totals only; no substring of arbitrary output is returned. */
export function commandTestSummary(output: unknown): string | undefined {
  if (typeof output !== "string" || output.length > 131_072) return;
  for (const original of output.split(/\r?\n/).slice(-100).reverse()) {
    const line = original.replace(/\u001b\[[0-9;]*m/g, "").trim();
    const vitest = /^Tests\s+([0-9]{1,7} (?:passed|failed|skipped|todo)(?:\s*\|\s*[0-9]{1,7} (?:passed|failed|skipped|todo))*)\s+\(([0-9]{1,7})\)$/.exec(line);
    if (vitest) {
      const entries = [...vitest[1]!.matchAll(/([0-9]{1,7}) (passed|failed|skipped|todo)/g)];
      if (entries.reduce((sum, entry) => sum + Number(entry[1]), 0) !== Number(vitest[2]) || new Set(entries.map(entry => entry[2])).size !== entries.length) continue;
      const passed = Number(entries.find(entry => entry[2] === "passed")?.[1] ?? 0);
      const failed = Number(entries.find(entry => entry[2] === "failed")?.[1] ?? 0);
      return totals(passed, failed);
    }
    const dotnet = /^(?:Passed!|Failed!)\s+-\s+Failed:\s+([0-9]{1,7}),\s+Passed:\s+([0-9]{1,7}),\s+Skipped:\s+([0-9]{1,7}),\s+Total:\s+([0-9]{1,7}),\s+Duration:\s+[0-9. ms]+ - [A-Za-z0-9_.-]+ \(net[0-9.]+\)$/.exec(line);
    if (dotnet && Number(dotnet[1]) + Number(dotnet[2]) + Number(dotnet[3]) === Number(dotnet[4])) return totals(Number(dotnet[2]), Number(dotnet[1]));
  }
}
function totals(passed: number, failed: number): string | undefined {
  return failed ? passed ? `${passed} passed · ${failed} failed` : `${failed} failed` : passed ? `${passed} passed` : undefined;
}

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
