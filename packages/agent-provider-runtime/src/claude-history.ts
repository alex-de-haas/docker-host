import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AgentProcessTransport } from "./internal/runtime/transport.js";

export type ClaudeChildHistoryRequest = {
  version: 1; nativeHome: string; executionHome: string; cwd: string; nativeSessionId: string;
  children: Array<{ agentId: string; transcriptPath: string; parentToolUseId: string;
    calls: Array<{ assistantUuid: string; assistantMessageId: string; toolUseId: string; input: Record<string, unknown> }> }>;
};
export type ClaudeChildHistoryMatch = {
  agentId: string; parentToolUseId: string; assistantUuid: string; assistantMessageId: string; historyAssistantUuid: string; toolUseId: string; resultUuid: string;
  result: { type: "tool_result"; tool_use_id: string; content: string; is_error: true };
};
const MAX_BYTES = 128 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const HISTORY_REASONS = new Set(["invalid_request", "environment_mismatch", "cwd_mismatch", "unsupported_layout", "captured_path_mismatch",
  "file_guard_failed", "read_set_changed", "sdk_unavailable", "sdk_read_failed", "unsupported_history", "history_lineage_mismatch",
  "tool_pair_ambiguous", "assistant_message_mismatch", "tool_input_mismatch", "terminal_unavailable", "incomplete_history", "output_limit"]);
export type ClaudeHistoryDiagnostic = { outcome: string; stdoutBytes: number; stderrBytes: number; firstOutputMs?: number; closedMs?: number; reasons?: string[] };

/** No credentials are needed to read this execution's already-owned local SDK transcript. */
export function claudeHistoryEnvironment(nativeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: nativeHome, CLAUDE_CONFIG_DIR: nativeHome };
  // Windows Node and the owned runner need their normal OS paths, never provider/Core secrets.
  if (process.platform === "win32") for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** One tracked helper and one shared deadline, including import, SDK reads and observed close. */
export async function readClaudeChildHistory(request: ClaudeChildHistoryRequest, transport?: AgentProcessTransport,
  onDiagnostic?: (value: ClaudeHistoryDiagnostic) => void): Promise<ClaudeChildHistoryMatch[]> {
  const started = performance.now();
  let outputBytes = 0, stderrBytes = 0, firstOutputMs: number | undefined, closedMs: number | undefined;
  const report = (outcome: string, reasons?: string[]) => {
    try { onDiagnostic?.({ outcome, stdoutBytes: outputBytes, stderrBytes, ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
      ...(closedMs === undefined ? {} : { closedMs }), ...(reasons?.length ? { reasons } : {}) }); } catch { /* Diagnostics confer no execution authority. */ }
  };
  if (!transport?.spawnTool || !path.isAbsolute(request.nativeHome) || !path.isAbsolute(request.executionHome) || !path.isAbsolute(request.cwd)
    || request.children.length < 1 || request.children.length > 8 || request.children.reduce((n, child) => n + child.calls.length, 0) > 16) { report("unsupported_request"); return []; }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 256 * 1024) { report("request_limit"); return []; }
  const abort = new AbortController();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = transport.spawnTool(["--max-old-space-size=96", "--max-semi-space-size=4",
      fileURLToPath(new URL("./claude-child-history.mjs", import.meta.url))], {
      command: process.execPath, cwd: request.cwd, env: claudeHistoryEnvironment(request.nativeHome), signal: abort.signal,
    });
  } catch { report("spawn_failed"); return []; }
  const chunks: Buffer[] = [];
  let failed = false, closed = false, failure = "helper_exit_failed";
  const stop = (reason: string) => { if (!failed) failure = reason; failed = true; abort.abort(); };
  const result = await new Promise<string>((resolve, reject) => {
    const work = setTimeout(() => stop("work_timeout"), 1200);
    const deadline = setTimeout(() => {
      stop("close_timeout");
      if (!closed) { report("exit_unconfirmed"); reject(new Error("The owned Claude history helper has not confirmed exit.")); }
    }, 2000);
    const clear = () => { clearTimeout(work); clearTimeout(deadline); };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      firstOutputMs ??= Math.round(performance.now() - started);
      if (outputBytes > MAX_BYTES) stop("output_limit"); else chunks.push(chunk);
    });
    // Drain without retaining error text, which can contain private native paths.
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) stop("stderr_limit"); });
    child.once("error", () => stop("process_error")); child.stdin.on("error", () => stop("pipe_error"));
    child.stdout.on("error", () => stop("pipe_error")); child.stderr.on("error", () => stop("pipe_error"));
    child.once("close", (code, signal) => {
      closed = true; closedMs = Math.round(performance.now() - started); clear();
      resolve(!failed && code === 0 && signal === null ? Buffer.concat(chunks).toString("utf8") : "");
    });
    child.stdin.end(input);
  });
  if (!result) { report(failure); return []; }
  try {
    const value: unknown = JSON.parse(result);
    if (!object(value) || value.version !== 1 || value.nativeSessionId !== request.nativeSessionId
      || !Array.isArray(value.matches) || value.matches.length > 16) { report("invalid_protocol"); return []; }
    const seen = new Set<string>();
    for (const match of value.matches) {
      if (!object(match) || typeof match.resultUuid !== "string" || !match.resultUuid || !object(match.result)
        || typeof match.historyAssistantUuid !== "string" || !match.historyAssistantUuid || match.historyAssistantUuid.length > 512
        || match.result.type !== "tool_result" || match.result.is_error !== true || match.result.tool_use_id !== match.toolUseId
        || typeof match.result.content !== "string" || Buffer.byteLength(match.result.content) > 32768) { report("invalid_protocol"); return []; }
      const owner = request.children.find(child => child.agentId === match.agentId && child.parentToolUseId === match.parentToolUseId);
      if (!owner?.calls.some(call => call.assistantUuid === match.assistantUuid && call.assistantMessageId === match.assistantMessageId && call.toolUseId === match.toolUseId)) { report("response_binding_mismatch"); return []; }
      const key = JSON.stringify([match.agentId, match.parentToolUseId, match.assistantUuid, match.toolUseId]);
      if (seen.has(key)) { report("duplicate_response"); return []; } seen.add(key);
    }
    const reasons = Array.isArray(value.unavailable) ? value.unavailable.slice(0, 16).flatMap(item => object(item) && typeof item.reason === "string" && HISTORY_REASONS.has(item.reason) ? [item.reason] : []) : [];
    report(value.matches.length ? "matched" : "unavailable", [...new Set(reasons)]);
    return value.matches as ClaudeChildHistoryMatch[];
  } catch { report("invalid_protocol"); return []; }
}
