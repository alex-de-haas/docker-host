import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPendingDecision, AgentSource } from "@hosty-sdk/app/agent";
import type { StoredEvent } from "../sessions/store.js";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";
import { providerTranscriptSource, transcriptToolId } from "./transcript-source.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); });
async function start() {
  const f = await publicProviderFixture(); fixtures.push(f);
  const record = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(record.id, "Research", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
  const runId = f.starts[0]!.runId;
  await vi.waitFor(() => expect(f.requests.some(request => request.path.includes(`/runs/${runId}/events`))).toBe(true));
  return { f, record, runId };
}
const root: AgentSource = { agentId: "root" };
const child: AgentSource = { agentId: "child", parentAgentId: "root", parentToolCallId: "delegate" };
const statuses = (events: StoredEvent[]) => events.filter(event => event.type === "native_agent_status");

describe("native provider children in the Harness transcript", () => {
  it("preserves run-qualified child attribution on live deltas, messages, tools, commands and decision resolution", async () => {
    const { f, record, runId } = await start();
    const live: StoredEvent[] = [], subscription = await f.manager.subscribe(record.id, 0, event => live.push(event));
    const source = providerTranscriptSource(f.snapshot(runId), child);
    const decision: AgentPendingDecision = { id: "permission", revision: "1", kind: "approval", delivery: "continue_run",
      source: child, toolCallId: "command", toolName: "Bash", input: { command: "pwd" } };
    f.emit(runId, "agent.updated", { agent: { ...child, state: "running" } }, child);
    f.emit(runId, "extension", { namespace: "hosty.agent.answer", name: "answer.complete" }, child);
    f.emit(runId, "tool.started", { toolCallId: "delegate", name: "Agent", input: { description: "Research one topic" } }, root);
    f.emit(runId, "message.delta", { messageId: "text", text: "Child text" }, child);
    f.emit(runId, "message.delta", { messageId: "root-text", text: "Root text" }, root);
    f.emit(runId, "message.completed", { messageId: "text", text: "Child text" }, child);
    f.emit(runId, "tool.started", { toolCallId: "command", name: "Bash", input: { command: "pwd" } }, child);
    f.emit(runId, "tool.completed", { toolCallId: "command", state: "completed", output: "workspace", command: { status: "completed", exitCode: 0 } }, child);
    f.runs.get(runId)!.pending = [decision];
    f.emit(runId, "decision.requested", { decisionId: decision.id, decision }, child);
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).some(event => event.type === "approval_request")).toBe(true));
    const card = (await f.store.readEvents(record.id)).find(event => event.type === "approval_request")!;
    expect(await f.manager.resolveApproval(record.id, String(card.approvalId), "allow", undefined, f.owner)).toBe(true);
    const events = await f.store.readEvents(record.id);
    for (const type of ["native_agent_status", "assistant_text", "tool_use", "tool_result", "command_result", "approval_request", "approval_decision"]) {
      const event = events.find(event => event.type === type && (event.providerSource as typeof source | undefined)?.agentId === child.agentId);
      expect(event, type).toMatchObject({ providerSource: source });
    }
    expect(f.controls).not.toContainEqual(expect.objectContaining({ input: expect.objectContaining({ command: "predictions" }) }));
    expect(events.some(event => event.type === "session_status" && event.status === "suggesting")).toBe(false);
    expect(live.filter(event => event.type === "assistant_delta")).toMatchObject([
      { text: "Child text", providerSource: source },
      { text: "Root text", providerSource: providerTranscriptSource(f.snapshot(runId), root) },
    ]);
    expect(events.some(event => event.type === "assistant_delta")).toBe(false);
    expect(source.parentTranscriptToolUseId).toBe(events.find(event => event.type === "tool_use" && event.toolName === "Agent")!.toolUseId);
    expect(events.find(event => event.type === "tool_result")!.toolUseId).toBe(transcriptToolId(runId, child, "command"));
    subscription.unsubscribe();
  });

  it.each(["root", "primary"])("joins source-less retained root tools without rewriting their stored IDs (root: %s)", async rootId => {
    const { f, record, runId } = await start();
    const source = { ...child, parentAgentId: rootId };
    const legacyId = transcriptToolId(runId, undefined, "delegate");
    f.update(runId, { agents: [{ agentId: rootId, state: "running" }, { ...source, state: "running" }],
      tools: [{ id: "delegate", name: "Agent", input: { description: "Retained research task" }, state: "running" }] });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).some(event => event.type === "tool_use")).toBe(true));
    const events = await f.store.readEvents(record.id);
    expect(events.find(event => event.type === "tool_use")?.toolUseId).toBe(legacyId);
    expect(statuses(events)[0]?.providerSource).toMatchObject({ parentTranscriptToolUseId: legacyId });
    const snapshot = f.snapshot(runId);
    snapshot.tools!.push({ id: "delegate", name: "Agent", state: "running", source: { agentId: "nested-parent", parentAgentId: rootId } });
    const nested = { agentId: "nested-child", parentAgentId: "nested-parent", parentToolCallId: "delegate" };
    expect(providerTranscriptSource(snapshot, nested).parentTranscriptToolUseId).toBe(transcriptToolId(runId, { agentId: "nested-parent" }, "delegate"));
  });

  it("projects same-process reconnect freshness changes at an unchanged native watermark", async () => {
    const { f, record, runId } = await start();
    f.update(runId, { agents: [{ ...child, state: "running", stopConfirmed: false }] });
    await vi.waitFor(async () => expect(statuses(await f.store.readEvents(record.id))).toHaveLength(1));
    const initial = f.snapshot(runId);
    Object.assign(f.runs.get(runId)!, { state: "unknown", phase: "interrupted", freshness: "last_known" });
    f.reconnect(runId);
    await vi.waitFor(async () => expect(statuses(await f.store.readEvents(record.id))).toHaveLength(2));
    await vi.waitFor(() => expect(f.requests.filter(request => request.path.includes(`/runs/${runId}/events`))).toHaveLength(2));
    Object.assign(f.runs.get(runId)!, { state: "running", phase: "executing", freshness: "current" });
    f.reconnect(runId);
    await vi.waitFor(async () => expect(statuses(await f.store.readEvents(record.id))).toHaveLength(3));
    expect(statuses(await f.store.readEvents(record.id)).map(event => event.state)).toEqual(["running", "unknown", "running"]);
    expect(f.snapshot(runId)).toMatchObject({ cursor: initial.cursor, lastSequence: initial.lastSequence, revision: initial.revision });
    expect((await f.store.readRecord(record.id))?.status).toBe("running");
    expect(f.starts).toHaveLength(1); expect(f.controls).toEqual([]);
    await vi.waitFor(() => expect(f.requests.filter(request => request.path.includes(`/runs/${runId}/events`))).toHaveLength(3));
    f.reconnect(runId);
    await vi.waitFor(() => expect(f.requests.filter(request => request.path.includes(`/runs/${runId}/events`))).toHaveLength(4));
    expect(statuses(await f.store.readEvents(record.id))).toHaveLength(3);
  });

  it("reconciles status and attributed child output after restart without duplicate cards or input replay", async () => {
    const { f, record, runId } = await start();
    const agents = [{ ...child, state: "running" as const, stopConfirmed: false }];
    f.update(runId, { agents });
    await vi.waitFor(async () => expect(statuses(await f.store.readEvents(record.id))).toHaveLength(1));
    await f.manager.shutdown();
    f.update(runId, { agents: [{ ...child, state: "succeeded", stopConfirmed: true }], messages: [
      { id: "child-answer", role: "assistant", state: "complete", source: child, text: "Recovered child answer" },
      { id: "root-answer", role: "assistant", state: "complete", source: root, text: "Parent final answer" }],
      state: "succeeded", phase: "terminal", stopConfirmed: true, result: { status: "succeeded", text: "Parent final answer" } });
    const restored = f.makeManager();
    await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await vi.waitFor(async () => expect((await restored.store.readRecord(record.id))!.status).toBe("idle"));
    const events = await restored.store.readEvents(record.id), source = providerTranscriptSource(f.snapshot(runId), child);
    expect(statuses(events)).toMatchObject([{ state: "running", providerSource: source }, { state: "succeeded", stopConfirmed: true, providerSource: source }]);
    expect(events.filter(event => event.type === "assistant_text")).toMatchObject([
      { text: "Recovered child answer", providerSource: source }, { text: "Parent final answer", providerSource: { agentId: "root", runId } }]);
    await restored.manager.shutdown();
    const again = f.makeManager(); await again.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    expect(statuses(await again.store.readEvents(record.id))).toHaveLength(2);
    expect(f.starts).toHaveLength(1); expect(f.controls).toEqual([]);
  });

  it.each([true, false])("marks interrupted child observations unknown while preserving confirmed outcomes (inventory retained: %s)", async retainInventory => {
    const { f, record, runId } = await start();
    const completed = { ...child, agentId: "completed", parentToolCallId: "delegate-two", state: "succeeded" as const, stopConfirmed: true };
    const agents = [{ ...child, state: "running" as const, stopConfirmed: false }, completed];
    f.update(runId, { agents });
    await vi.waitFor(async () => expect(statuses(await f.store.readEvents(record.id))).toHaveLength(2));
    f.update(runId, { agents: retainInventory ? agents : [], state: "unknown", phase: "interrupted", freshness: "last_known",
      messages: [{ id: "partial", source: child, role: "assistant", state: "interrupted", text: "Partial research" }], effects: { certainty: "unknown", unresolvedCallIds: ["unfinished-tool"] } });
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("failed"));
    const events = await f.store.readEvents(record.id), states = statuses(events);
    expect(states.filter(event => (event.providerSource as AgentSource).agentId === "child")).toMatchObject([
      { state: "running" }, { state: "unknown", lastKnownState: "running", freshness: "last_known", stopConfirmed: false }]);
    expect(states.filter(event => (event.providerSource as AgentSource).agentId === "completed").every(event => event.state === "succeeded")).toBe(true);
    const notice = events.find(event => event.type === "notice" && String(event.message).includes("cannot be reconciled"));
    expect(notice?.message).toContain("1 native tool outcome is unresolved");
    expect(notice?.message).not.toContain("Native exit is unconfirmed");
    expect(events.find(event => event.type === "assistant_text")).toMatchObject({ text: "Partial research", incomplete: true, providerSource: { agentId: "child", runId } });
    // Reconnect can restore the same native cursor; this is a new observation, not new work.
    await f.manager.shutdown();
    Object.assign(f.runs.get(runId)!, { agents, state: "running", phase: "executing", freshness: "current" });
    const restored = f.makeManager(); await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await vi.waitFor(async () => expect(statuses(await restored.store.readEvents(record.id)).filter(event => (event.providerSource as AgentSource).agentId === "child")).toHaveLength(3));
    expect(statuses(await restored.store.readEvents(record.id)).filter(event => (event.providerSource as AgentSource).agentId === "child").map(event => event.state)).toEqual(["running", "unknown", "running"]);
    expect(f.starts).toHaveLength(1);
  });
});
