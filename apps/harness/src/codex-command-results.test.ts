import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CodexHarnessAdapter } from "./harness/codex.js";
import type { HarnessEvent } from "./harness/adapter.js";
const fake = fileURLToPath(new URL("../test/fake-command-result-server.mjs", import.meta.url));
function start(events: HarnessEvent[]) {
  return new CodexHarnessAdapter({ dataDir: path.dirname(fake) }).start({ sessionId: "fixture", cwd: path.dirname(fake),
    onEvent: event => events.push(event), processTransport: { spawn: (_provider, _args, options) => spawn(process.execPath, [fake], { ...options, stdio: ["pipe", "pipe", "pipe"] }) } });
}
it("records factual Codex code/duration and count summaries once, isolated by native turn and adapter run", async () => {
  const events: HarnessEvent[] = []; const run = start(events);
  try {
    run.send("results"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1));
    const results = events.filter(event => event.type === "command_result"); expect(results).toHaveLength(3);
    expect(results.map(event => [event.status, event.exitCode, event.durationMs, event.summary])).toEqual([
      ["completed", 0, 4200, "14 passed"], ["failed", 2, 12, undefined], ["unknown", undefined, 4200, undefined],
    ]);
    expect(JSON.stringify(results)).not.toMatch(/secret|stdout|stderr|aggregatedOutput/);
    for (const result of results) expect(events.filter(event => event.type === "tool_use" && event.toolUseId === result.toolUseId)).toHaveLength(1);
    const firstIds = results.map(event => event.toolUseId);
    run.send("results"); await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(2));
    const all = events.filter(event => event.type === "command_result"); expect(all).toHaveLength(6);
    expect(all.slice(3).every(event => !firstIds.includes(event.toolUseId))).toBe(true);
  } finally { await run.stop(); }
});
it("never claims a locally denied command executed, including duplicated completed notifications", async () => {
  const events: HarnessEvent[] = []; const run = start(events);
  try {
    run.send("denied"); await vi.waitFor(() => expect(events.find(event => event.type === "approval_request")).toBeDefined());
    const approval = events.find(event => event.type === "approval_request")!;
    expect(approval.type === "approval_request" && run.resolveApproval(approval.approvalId, "deny")).toBe(true);
    await vi.waitFor(() => expect(events.find(event => event.type === "result")).toBeDefined());
    expect(events.filter(event => event.type === "command_result" || event.type === "tool_use")).toEqual([]);
  } finally { await run.stop(); }
});
it("names the started command on its approval, so the later recorded call carries the decision", async () => {
  const events: HarnessEvent[] = []; const run = start(events);
  try {
    run.send("allowed"); await vi.waitFor(() => expect(events.find(event => event.type === "approval_request")).toBeDefined());
    const approval = events.find(event => event.type === "approval_request")!;
    expect(approval.type === "approval_request" && approval.toolUseId).toMatch(/^command:/);
    expect(approval.type === "approval_request" && run.resolveApproval(approval.approvalId, "allow")).toBe(true);
    await vi.waitFor(() => expect(events.find(event => event.type === "result")).toBeDefined());
    const calls = events.filter(event => event.type === "tool_use");
    expect(calls).toHaveLength(1); expect(calls[0]!.type === "tool_use" && calls[0]!.toolUseId).toBe(approval.type === "approval_request" && approval.toolUseId);
  } finally { await run.stop(); }
});
