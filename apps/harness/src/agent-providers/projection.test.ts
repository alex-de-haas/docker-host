import { describe, expect, it } from "vitest";
import { AGENT_EVENT_VERSION, type AgentEvent, type AgentPendingDecision, type AgentRunSnapshot, type AgentSource } from "@hosty-sdk/app/agent";
import { AgentProjectionResyncError, createAgentRunProjection, reduceAgentRunProjection, type AgentRunProjection } from "./projection.js";

const generation = "00000000-0000-4000-8000-000000000001";
const root: AgentSource = { agentId: "primary" };
const child: AgentSource = { agentId: "child", parentAgentId: root.agentId, parentToolCallId: "delegate" };
const snapshot = (patch: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot => ({
  ref: { provider: { appId: "unrelated.provider", installationId: "installation", key: "agent" }, id: "run" },
  sessionId: "session", generation, revision: "0", state: "running", phase: "executing", stopConfirmed: false,
  freshness: "current", observedAt: "2026-11-12T12:00:00Z", configurationRevision: "1", lastSequence: "0", cursor: "cursor-0",
  pending: [], effects: { certainty: "unknown", unresolvedCallIds: [] }, ...patch,
});
const decision = (source = root, revision = "1"): AgentPendingDecision => ({
  id: "same", revision, kind: "approval", delivery: "continue_run", source, toolCallId: "same", toolName: "Edit",
});
function event(sequence: string, type: AgentEvent["type"], data: AgentEvent["data"], source = root, patch: Partial<AgentEvent> = {}): AgentEvent {
  return { schemaVersion: AGENT_EVENT_VERSION, runId: "run", generation, sequence, revision: sequence,
    occurredAt: "2026-11-12T12:00:00Z", type, source, data, ...patch };
}
function apply(current: AgentRunProjection, type: AgentEvent["type"], data: AgentEvent["data"], source = root): AgentRunProjection {
  const sequence = String(BigInt(current.snapshot.lastSequence) + 1n);
  return reduceAgentRunProjection(current, { kind: "event", event: event(sequence, type, data, source), cursor: `cursor-${sequence}` });
}
function expectResync(action: () => unknown, reason?: string) {
  expect(action).toThrow(AgentProjectionResyncError);
  try { action(); } catch (error) { expect(error).toMatchObject({ code: "resync_required", ...(reason ? { reason } : {}) }); }
}

describe("public provider run projection", () => {
  it("retains parallel child status transitions and rejects changed ancestry or invalid state", () => {
    let current = createAgentRunProjection(snapshot());
    const sibling = { ...child, agentId: "sibling", parentToolCallId: "delegate-two" };
    current = apply(current, "agent.updated", { agent: { ...child, state: "running", stopConfirmed: false } }, child);
    current = apply(current, "agent.updated", { agent: { ...sibling, state: "waiting_for_input" } }, sibling);
    current = apply(current, "agent.updated", { agent: { ...child, state: "succeeded", stopConfirmed: true } }, child);
    expect(current.snapshot.agents).toEqual([{ ...child, state: "succeeded", stopConfirmed: true }, { ...sibling, state: "waiting_for_input" }]);
    expect(current.snapshot.state).toBe("running");
    expect(current.snapshot.stopConfirmed).toBe(false);
    const duplicate = event("3", "agent.updated", { agent: { ...child, state: "succeeded", stopConfirmed: true } }, child);
    expect(reduceAgentRunProjection(current, { kind: "event", event: duplicate, cursor: "cursor-3" })).toBe(current);
    expectResync(() => apply(current, "agent.updated", { agent: { ...child, state: "invalid" } }, child), "invalid agent status");
    expectResync(() => apply(current, "agent.updated", { agent: { ...child, state: "running", parentAgentId: "other" } }, child), "agent status source changed");
    const moved = { ...child, parentToolCallId: "different" };
    expectResync(() => apply(current, "agent.updated", { agent: { ...moved, state: "running" } }, moved), "agent parent changed");
    const replacement = snapshot({ lastSequence: "4", revision: "4", agents: [{ ...child, state: "unknown" }] });
    current = reduceAgentRunProjection(current, { kind: "snapshot", snapshot: replacement });
    replacement.agents![0]!.state = "running";
    expect(current.snapshot.agents).toEqual([{ ...child, state: "unknown" }]);
    expectResync(() => createAgentRunProjection(snapshot({ agents: [{ ...child, state: "running" }, { ...child, state: "succeeded" }] })), "duplicate snapshot agent identity");
  });

  it("keeps the lifecycle snapshot replayable when the child journal exceeds its byte allowance", () => {
    let projection = createAgentRunProjection(snapshot());
    const response = "x".repeat(65536);
    for (let index = 0; index < 17; index++) {
      const source = { ...child, agentId: `child-${index}` };
      projection = apply(projection, "agent.updated", { agent: { ...source, state: "succeeded", response } }, source);
    }
    expect(createAgentRunProjection(projection.snapshot).snapshot.agents).toHaveLength(17);
  });

  it("retains the latest root context with its original event identity across replacement and explicit clearing", () => {
    const usage = { usedTokens: 42, maxTokens: 1000, estimated: false };
    const initial = snapshot({ revision: "1", lastSequence: "1", latestContext: { sequence: "1", usage } });
    let current = createAgentRunProjection(initial);
    usage.usedTokens = 999;
    expect(current.snapshot.latestContext).toEqual({ sequence: "1", usage: { usedTokens: 42, maxTokens: 1000, estimated: false } });
    current = apply(current, "context.updated", { usage: { usedTokens: 500 } }, child);
    expect(current.snapshot.latestContext?.sequence).toBe("1");
    current = apply(current, "context.updated", { usage: null });
    expect(current.snapshot.latestContext).toEqual({ sequence: "3", usage: null });
    const cleared = current;
    expect(reduceAgentRunProjection(current, { kind: "event", event: event("3", "context.updated", { usage: null }), cursor: "duplicate" })).toBe(cleared);
    const replacement = snapshot({ revision: "4", lastSequence: "4", latestContext: { sequence: "3", usage: null } });
    current = reduceAgentRunProjection(current, { kind: "snapshot", snapshot: replacement });
    expect(current.snapshot.latestContext).toEqual({ sequence: "3", usage: null });
    expectResync(() => reduceAgentRunProjection(current, { kind: "snapshot", snapshot: { ...replacement,
      revision: "5", lastSequence: "5", latestContext: { sequence: "1", usage: { usedTokens: 42 } } } }), "latest context regressed");
  });

  it("replaces all projected contents with one authoritative snapshot and cursor", () => {
    const initial = snapshot({ messages: [{ id: "old", source: root, role: "assistant", text: "Old answer", state: "complete" }],
      pending: [decision()], result: { status: "succeeded", text: "Old answer" } });
    const current = createAgentRunProjection(initial);
    initial.messages![0]!.text = "Mutated source";
    expect(current.messages[0]!.text).toBe("Old answer");
    const replacement = snapshot({ revision: "12", lastSequence: "20", cursor: "new-watermark", messages: [
      { id: "replacement", source: root, role: "assistant", text: "Recovered partial", state: "interrupted" },
    ] });

    const next = reduceAgentRunProjection(current, { kind: "snapshot", snapshot: replacement });
    expect(next).toMatchObject({ cursor: "new-watermark", pending: [], tools: [], childResults: [] });
    expect(next.messages.map(message => message.id)).toEqual(["replacement"]);
    expect(next.result).toBeUndefined();
    expect(next.snapshot.result).toBeUndefined();
    expect(next.snapshot.lastSequence).toBe("20");
    expect(current.pending).toHaveLength(1);
    replacement.messages![0]!.text = "Mutated replacement";
    expect(next.messages[0]!.text).toBe("Recovered partial");
  });

  it("keeps parallel child identities separate and replaces completed text/output without duplication", () => {
    let current = createAgentRunProjection(snapshot());
    current = apply(current, "message.delta", { messageId: "same", text: "Root " });
    current = apply(current, "message.delta", { messageId: "same", text: "Child " }, child);
    current = apply(current, "message.delta", { messageId: "same", text: "answer" });
    current = apply(current, "message.completed", { messageId: "same", text: "Root answer" });
    current = apply(current, "tool.started", { toolCallId: "same", name: "Root tool", input: { file: "root" } });
    current = apply(current, "tool.started", { toolCallId: "same", name: "Child tool", input: { file: "child" } }, child);
    current = apply(current, "tool.output", { toolCallId: "same", output: "partial " }, child);
    current = apply(current, "tool.output", { toolCallId: "same", output: "output" }, child);
    current = apply(current, "tool.completed", { toolCallId: "same", output: "complete output", state: "failed", truncated: true }, child);
    current = apply(current, "decision.requested", { decisionId: "same", decision: decision() });
    current = apply(current, "decision.requested", { decisionId: "same", decision: decision(child) }, child);
    current = apply(current, "decision.resolved", { decisionId: "same" }, child);

    expect(current.messages).toMatchObject([{ text: "Root answer", state: "complete", source: root }, { text: "Child ", source: child }]);
    expect(current.tools).toMatchObject([{ name: "Root tool", state: "running" }, { name: "Child tool", output: "complete output", state: "failed", truncated: true }]);
    expect(current.pending).toEqual([decision()]);
    expect(current.snapshot.messages).toBe(current.messages);
    expect(current.snapshot.pending).toBe(current.pending);
  });

  it("applies live status-only Bash completion to the observed child command", () => {
    let current = createAgentRunProjection(snapshot());
    current = apply(current, "tool.started", { toolCallId: "same", name: "Bash", input: { command: "pwd" } });
    current = apply(current, "tool.started", { toolCallId: "same", name: "Bash", input: { command: "pwd" } }, child);
    current = apply(current, "tool.completed", { toolCallId: "same", name: "Bash", state: "completed", command: { status: "completed" } }, child);

    expect(current.tools).toMatchObject([{ state: "running", source: root },
      { state: "completed", source: child, command: { status: "completed" } }]);
    expect(current.tools[1]).not.toHaveProperty("output");
  });

  it("deduplicates at-least-once delivery without advancing its saved cursor backwards", () => {
    const initial = createAgentRunProjection(snapshot());
    const item = { kind: "event" as const, event: event("1", "message.delta", { messageId: "answer", text: "Once" }), cursor: "cursor-1" };
    const current = reduceAgentRunProjection(initial, item);
    const before = structuredClone(current);
    expect(reduceAgentRunProjection(current, item)).toBe(current);
    expect(reduceAgentRunProjection(current, { ...item, cursor: "replayed-cursor" })).toBe(current);
    expect(current).toEqual(before);
    expect(initial.messages).toEqual([]);
  });

  it("orders arbitrary decimal counters exactly and requires resync for gaps, stale generations and invalid decimals", () => {
    const sequence = "9007199254740993";
    const current = createAgentRunProjection(snapshot({ lastSequence: sequence, revision: sequence }));
    const next = reduceAgentRunProjection(current, { kind: "event", event: event("9007199254740994", "warning", { message: "Still running" }), cursor: "next" });
    expect(next.snapshot.lastSequence).toBe("9007199254740994");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: event("9007199254740995", "warning", {}), cursor: "gap" }), "event sequence gap");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: event("1", "warning", {}, root, { generation: "00000000-0000-4000-8000-000000000002" }), cursor: "old" }), "execution generation changed");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: event("01", "warning", {}), cursor: "invalid" }), "invalid event");
    expectResync(() => createAgentRunProjection(snapshot({ lastSequence: "1e3" })), "invalid snapshot");
  });

  it("rejects another installation/session and regressed revisions without altering the last projection", () => {
    const current = createAgentRunProjection(snapshot({ revision: "5" }));
    const before = structuredClone(current);
    expectResync(() => reduceAgentRunProjection(current, { kind: "snapshot", snapshot: snapshot({ ref: {
      ...current.snapshot.ref, provider: { ...current.snapshot.ref.provider, installationId: "replacement" },
    } }) }), "run or installation identity changed");
    expectResync(() => reduceAgentRunProjection(current, { kind: "snapshot", snapshot: snapshot({ sessionId: "different" }) }), "run or installation identity changed");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: event("1", "warning", {}, root, { revision: "4" }), cursor: "next" }), "event revision regressed");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: event("1", "warning", {}, root, { runId: "other" }), cursor: "next" }), "event belongs to another run");
    expect(current).toEqual(before);
  });

  it("requires run.updated to carry the exact event watermark and replaces pending/native-stop facts atomically", () => {
    const current = createAgentRunProjection(snapshot({ pending: [decision()] }));
    const replacement = snapshot({ revision: "1", lastSequence: "1", cursor: "cursor-1", state: "unknown", phase: "interrupted",
      stopConfirmed: false, pending: [], effects: { certainty: "unknown", unresolvedCallIds: ["unsettled"] } });
    const update = event("1", "run.updated", { snapshot: replacement });
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: update, cursor: "different-watermark" }), "snapshot cursor differs from event watermark");
    expectResync(() => reduceAgentRunProjection(current, { kind: "event", event: { ...update, revision: "2" }, cursor: "cursor-1" }), "invalid event");
    const next = reduceAgentRunProjection(current, { kind: "event", event: update, cursor: "cursor-1" });
    expect(next.pending).toEqual([]);
    expect(next.snapshot).toMatchObject({ state: "unknown", stopConfirmed: false, effects: { unresolvedCallIds: ["unsettled"] } });
    expect(next.cursor).toBe(next.snapshot.cursor);
  });

  it("does not confuse a result or child completion with confirmed root execution stop", () => {
    let current = createAgentRunProjection(snapshot());
    current = apply(current, "result.available", { result: { status: "succeeded", text: "Root answer" } });
    current = apply(current, "result.available", { result: { status: "failed", text: "Child failure" } }, child);
    current = apply(current, "selection.updated", { requested: { model: "requested", reasoningEffort: null }, effective: { model: "effective", reasoningEffort: "low" } });
    current = apply(current, "usage.updated", { tokens: 3 });
    expect(current.result).toEqual({ status: "succeeded", text: "Root answer" });
    expect(current.childResults).toEqual([{ source: child, result: { status: "failed", text: "Child failure" } }]);
    expect(current.snapshot).toMatchObject({ state: "running", stopConfirmed: false, lastSequence: "4", selection: {
      requested: { model: "requested", reasoningEffort: null }, effective: { model: "effective", reasoningEffort: "low" },
    } });
  });

  it("preserves a root's source-less snapshot items when a child reuses their local IDs", () => {
    let current = createAgentRunProjection(snapshot({ messages: [{ id: "same", role: "assistant", text: "Root", state: "streaming" }], pending: [{ ...decision(), source: undefined }] }));
    current = apply(current, "message.completed", { messageId: "same", text: "Child" }, child);
    current = apply(current, "decision.resolved", { decisionId: "same" }, child);
    expect(current.messages.map(message => message.text)).toEqual(["Root", "Child"]);
    expect(current.pending).toHaveLength(1);
    current = apply(current, "message.completed", { messageId: "same", text: "Root complete" });
    expect(current.messages.map(message => message.text)).toEqual(["Root complete", "Child"]);
    expectResync(() => apply(current, "decision.updated", { decisionId: "same", decision: decision(child) }), "decision source changed");
  });
});
