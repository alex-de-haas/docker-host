import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { WorkerEngine } from "@hosty/agent-provider-runtime/worker/engine";
import { WorkerJournal } from "@hosty/agent-provider-runtime/worker/journal";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CodexHarnessAdapter } from "./codex.js";
import type { HarnessEvent } from "@hosty/agent-provider-runtime/harness/adapter";
const fake = fileURLToPath(new URL("../../test/fake-command-result-server.mjs", import.meta.url));
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


it("drains authoritative interrupted command completion before owned stop after a polite ACK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-codex-cancel-drain-")), journal = new WorkerJournal(path.join(root, "journal")); await journal.initialize();
  const native = new CodexHarnessAdapter({ dataDir: root });
  const engine = new WorkerEngine(journal, { reserve: async () => () => {}, validateSelection: async () => {}, cwd: async () => root,
    adapter: async () => ({ name: native.name, capabilities: native.capabilities, probe: async () => ({ available: true }),
      start: options => native.start({ ...options, processTransport: { spawn: (_provider, _args, input) => spawn(process.execPath, [fake], { ...input, stdio: ["pipe", "pipe", "pipe"] }) } }) }) }, 1);
  try {
    await engine.submit("cancel-drain", { conversationId: "chat", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "codex" },
      selection: { model: "fixture-model", reasoningEffort: "medium" }, resource: { kind: "conversation", id: "chat" }, input: "interrupt-drain", options: {}, autoAllowedPrefixes: [] });
    await vi.waitFor(async () => expect(Object.values((await journal.load("cancel-drain")).receipt.effects ?? {})).toEqual(["started"]));
    const stopped = await engine.cancel("cancel-drain", "cancel-once");
    expect(stopped).toMatchObject({ state: "cancelled", exitConfirmed: true });
    expect(stopped.effects).toEqual({});
    const events = (await journal.load("cancel-drain")).events.map(frame => frame.event);
    expect(events.filter(event => event.type === "command_result")).toEqual([expect.objectContaining({ status: "failed", exitCode: 130 })]);
    expect(events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started", "settled"]);
    expect(engine.occupied).toBe(0);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

it("cleans a yielded command after turn completion and emits only its exact typed terminal before result", async () => {
  const events: HarnessEvent[] = []; const run = start(events);
  try {
    run.send("background-with-remote");
    await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1));
    const command = events.filter(event => event.type === "command_result");
    expect(command).toEqual([expect.objectContaining({ status: "failed", exitCode: 130 })]);
    expect(events.findIndex(event => event.type === "command_result")).toBeLessThan(events.findIndex(event => event.type === "result"));
    const effects = events.filter(event => event.type === "native_effect");
    expect(effects.filter(event => event.id === command[0]!.toolUseId).map(event => event.state)).toEqual(["started", "settled"]);
    const remote = effects.find(event => event.id !== command[0]!.toolUseId)!;
    expect(effects.filter(event => event.id === remote.id).map(event => event.state)).toEqual(["started"]);
    expect(events.filter(event => event.type === "tool_use")).toHaveLength(1);
  } finally { await run.stopAndWait?.(); }
});

it.each(["cleanup-ack-only", "cleanup-fail"])("keeps an unresolved command effect when %s supplies no typed completion", async prompt => {
  const events: HarnessEvent[] = []; const run = start(events);
  try {
    run.send(prompt);
    await vi.waitFor(() => expect(events.filter(event => event.type === "result")).toHaveLength(1), { timeout: 4_000 });
    expect(events.filter(event => event.type === "native_effect").map(event => event.state)).toEqual(["started"]);
    expect(events.filter(event => event.type === "command_result")).toEqual([]);
    await run.stopAndWait?.();
  } finally { await run.stop(); }
});
