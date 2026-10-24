import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CodexHarnessAdapter } from "./harness/codex.js";
import type { HarnessEvent } from "./harness/adapter.js";
const fake = fileURLToPath(new URL("../test/fake-tool-result-server.mjs", import.meta.url));
it("records scoped MCP errors and dynamic output once, omits envelopes and binary payloads, and isolates later turns", async () => {
  const events: HarnessEvent[] = [];
  const run = new CodexHarnessAdapter({ dataDir: path.dirname(fake) }).start({ sessionId: "fixture", cwd: path.dirname(fake), onEvent: event => events.push(event),
    processTransport: { spawn: (_provider, _args, options) => spawn(process.execPath, [fake], { ...options, stdio: ["pipe", "pipe", "pipe"] }) } });
  try {
    run.send("outputs"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1));
    const results = events.filter(event => event.type === "tool_result");
    expect(results).toHaveLength(6);
    expect(results.map(event => event.status)).toEqual(["completed", "failed", "failed", "unknown", "completed", "unknown"]);
    expect(results[0]!.output).toContain("app output"); expect(results[0]!.output).toContain("demo");
    expect(results[1]!.output).toBe("app unavailable");
    expect(results[2]!.output).toBe("MCP error despite completed status"); expect(results[3]!.output).toBe("");
    expect(results[4]!.output).toContain("dynamic output"); expect(results[4]!.output).toContain("[Image content omitted]");
    expect(JSON.stringify(results)).not.toMatch(/private-envelope-token|private-error-token|private setup output|private-binary/);
    for (const result of results) expect(events.filter(event => event.type === "tool_use" && event.toolUseId === result.toolUseId)).toHaveLength(1);
    const ids = results.map(event => event.toolUseId);
    run.send("outputs"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(2));
    const next = events.filter(event => event.type === "tool_result").slice(6);
    expect(next).toHaveLength(6); expect(next.every(event => !ids.includes(event.toolUseId))).toBe(true);
  } finally { await run.stop(); }
});

it("retains command output under the existing command ID without adding output to command_result", async () => {
  const script = fileURLToPath(new URL("../test/fake-command-result-server.mjs", import.meta.url));
  const events: HarnessEvent[] = [];
  const run = new CodexHarnessAdapter({ dataDir: path.dirname(script) }).start({ sessionId: "fixture", cwd: path.dirname(script), onEvent: event => events.push(event),
    processTransport: { spawn: (_provider, _args, options) => spawn(process.execPath, [script], { ...options, stdio: ["pipe", "pipe", "pipe"] }) } });
  try {
    run.send("results"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1));
    const results = events.filter(event => event.type === "tool_result"), commands = events.filter(event => event.type === "command_result");
    expect(results).toHaveLength(3); expect(results.map(event => event.toolUseId)).toEqual(commands.map(event => event.toolUseId));
    expect(results.map(event => event.status)).toEqual(["completed", "failed", "unknown"]);
    expect(results[0]!.output).toContain("Tests 14 passed (14)"); expect(results[1]!.output).toBe("token=secret");
    expect(JSON.stringify(commands)).not.toMatch(/secret|aggregatedOutput|stdout/);
    run.send("denied"); await vi.waitFor(() => expect(events.some(event => event.type === "approval_request")).toBe(true));
    const approval = events.find(event => event.type === "approval_request")!;
    expect(approval.type === "approval_request" && run.resolveApproval(approval.approvalId, "deny")).toBe(true);
    await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(2));
    expect(events.filter(event => event.type === "tool_result")).toHaveLength(3);
  } finally { await run.stop(); }
});
