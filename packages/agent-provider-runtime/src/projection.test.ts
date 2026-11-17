import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { validateAgentEvent, validateAgentRunSnapshot } from "@hosty-sdk/app/agent/server";
import type { HarnessEvent, HarnessEventSource } from "./internal/harness/adapter.js";
import { nativeEventIdentity } from "./internal/harness/adapter.js";
import type { WorkerReceipt } from "./internal/worker/contracts.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { projectEvent, projectReceipt, projectAppliedDecisionControls, publicSource, publicToolId } from "./projection.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
const provider = { appId: "independent.example.agent", installationId: "installation", key: "default" };
const actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "third.party.consumer", callerInstallation: "consumer-installation", admissionRef: "admission", operation: "runs.start", provider };
const child: HarnessEventSource = { agentId: "native-child:private", parentAgentId: "root", parentToolCallId: "native-parent:private" };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-projection-test-")); paths.push(directory);
  const store = new ProviderStore(directory, provider); await store.initialize();
  const id = randomUUID(), configuration = { connection: { id: "account", revision: "1" } };
  await store.create(id, actor, "{}", { configuration }, { configuration, digest: "a".repeat(64), resolvedSkills: [] });
  const session = await store.load(id), record = store.makeRun(session, randomUUID(), actor, "{}"); session.runs[record.snapshot.ref.id] = record;
  let sequence = 0;
  return { store, session, record, append: (event: HarnessEvent) => projectEvent(store, session, record, { runId: record.snapshot.ref.id, generation: "native-generation", sequence: ++sequence, event }) };
}
describe("bounded public native projection", () => {
  it("retains only root context observations and explicit clears at their original public sequence", async () => {
    const f = await fixture(), usage = { usedTokens: 107, maxTokens: 32768, estimated: false, observedAt: new Date().toISOString() };
    f.append({ type: "context_usage", usage });
    const observation = structuredClone(f.record.snapshot.latestContext!);
    expect(observation).toEqual({ sequence: f.record.events[0]!.sequence, usage });
    f.append({ type: "context_usage", usage: { ...usage, usedTokens: 999 }, source: child });
    f.append({ type: "context_usage", usage: null, source: child });
    expect(f.record.snapshot.latestContext).toEqual(observation);
    expect(f.record.events[1]).toMatchObject({ type: "context.updated", source: publicSource(child), data: { usage: { usedTokens: 999 } } });
    f.append({ type: "context_usage", usage: null });
    expect(f.record.snapshot.latestContext).toEqual({ sequence: f.record.events.at(-1)!.sequence, usage: null });
    const count = f.record.events.length;
    projectEvent(f.store, f.session, f.record, { runId: f.record.snapshot.ref.id, generation: "native-generation", sequence: 1,
      event: { type: "context_usage", usage } });
    expect(f.record.events).toHaveLength(count); expect(f.record.snapshot.latestContext!.usage).toBeNull();
    f.store.lifecycle(f.record); validateAgentRunSnapshot(f.record.snapshot);
    await f.store.save(f.session);
    const restarted = new ProviderStore(f.store.directory, provider); await restarted.initialize();
    expect((await restarted.run(f.record.snapshot.ref.id)).record.snapshot.latestContext).toEqual(f.record.snapshot.latestContext);
  });
  it("keeps the latest context across replay expiry and leaves old records without an observation unchanged", async () => {
    const f = await fixture();
    await f.store.save(f.session);
    const file = path.join(f.store.directory, f.session.id+".json"), before = await readFile(file, "utf8");
    const legacy = new ProviderStore(f.store.directory, provider); await legacy.initialize();
    expect((await legacy.run(f.record.snapshot.ref.id)).record.snapshot).not.toHaveProperty("latestContext");
    expect(await readFile(file, "utf8")).toBe(before);
    f.append({ type: "context_usage", usage: { usedTokens: 109, maxTokens: 32768, estimated: false, observedAt: new Date().toISOString() } });
    const observation = structuredClone(f.record.snapshot.latestContext);
    f.record.snapshot.state = "succeeded"; f.record.snapshot.phase = "terminal"; f.record.snapshot.stopConfirmed = true;
    f.record.completedAt = new Date(0).toISOString(); f.store.lifecycle(f.record); await f.store.save(f.session);
    const expired = new ProviderStore(f.store.directory, provider, 1024 * 1024, 0); await expired.initialize();
    const restored = (await expired.run(f.record.snapshot.ref.id)).record;
    expect(restored.events).toEqual([]); expect(restored.snapshot.latestContext).toEqual(observation);
    validateAgentRunSnapshot(restored.snapshot);
  });
  it("keeps successive complete messages distinct and child output out of the root result", async () => {
    const f = await fixture();
    f.append({ type: "assistant_delta", text: "First" }); f.append({ type: "assistant_text", text: "First" });
    f.append({ type: "assistant_text", text: "Child answer", source: child });
    f.append({ type: "result", status: "success", source: child });
    expect(f.record.snapshot.result).toBeUndefined();
    f.append({ type: "assistant_delta", text: "Second" }); f.append({ type: "assistant_text", text: "Second" }); f.append({ type: "result", status: "success" });
    expect(f.record.snapshot.messages?.map(value => value.text)).toEqual(["First", "Child answer", "Second"]);
    expect(new Set(f.record.snapshot.messages?.map(value => value.id)).size).toBe(3);
    expect(f.record.snapshot.result?.text).toBe("First\n\nSecond");
    expect(f.record.snapshot.agents?.[0]).toMatchObject({ ...publicSource(child), state: "succeeded", stopConfirmed: false });
    for (const event of f.record.events) validateAgentEvent(event);
    expect(JSON.stringify(f.record.snapshot)).not.toContain("native-child:private");
  });
  it("preserves source-qualified command metadata and effect identity through a snapshot", async () => {
    const f = await fixture(), id = "same-native-call";
    f.append({ type: "tool_use", toolUseId: id, toolName: "Bash", input: {}, source: child });
    f.append({ type: "command_result", toolUseId: id, status: "failed", exitCode: 2, durationMs: 50, summary: "Command failed", source: child });
    const receipt: WorkerReceipt = { runId: f.record.snapshot.ref.id, conversationId: f.session.id, generation: "native", state: "running", revision: 2, selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), effects: { [nativeEventIdentity(child, id)]: "unknown" } };
    projectReceipt(f.store, f.session, f.record, receipt);
    expect(f.record.snapshot.tools?.[0]).toMatchObject({ id: publicToolId(id, publicSource(child).agentId), source: publicSource(child), command: { status: "failed", exitCode: 2, durationMs: 50, summary: "Command failed" } });
    expect(f.record.snapshot.effects.unresolvedCallIds).toEqual([f.record.snapshot.tools?.[0]?.id]);
    expect(f.record.snapshot.tools?.[0]?.id).not.toBe(publicToolId(id)); validateAgentRunSnapshot(f.record.snapshot);
  });
  it("warns before pruning bounded messages, keeps UTF-8 valid, and exposes incomplete coverage", async () => {
    const f = await fixture();
    for (let index = 0; index < 34; index++) f.append({ type: "assistant_text", text: "界".repeat(10000) });
    expect(f.record.snapshot.messages!.length).toBeLessThanOrEqual(32);
    expect(f.record.snapshot.messages!.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(128 * 1024);
    expect(f.record.snapshot.messages!.some(item => item.text.includes("\uFFFD"))).toBe(false);
    expect(f.record.snapshot.coverage?.messages).toBe("truncated");
    const warning = f.record.events.findIndex(event => event.type === "warning" && event.data.code === "snapshot_truncated");
    expect(warning).toBeGreaterThanOrEqual(0); expect(f.record.events[warning + 1]?.type).toBe("message.completed");
  });
  it("emits monotonic durable usage without changing the control revision", async () => {
    const f = await fixture(), snapshot = f.record.snapshot;
    const receipt: WorkerReceipt = { runId: snapshot.ref.id, conversationId: f.session.id, generation: "native", state: "accepted", revision: 0, selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), usage: { sequence: 1, activeMs: 123, unknown: false } };
    projectReceipt(f.store, f.session, f.record, receipt); const revision = snapshot.revision;
    projectReceipt(f.store, f.session, f.record, { ...receipt, usage: { sequence: 2, activeMs: 245, unknown: true } });
    projectReceipt(f.store, f.session, f.record, receipt);
    expect(snapshot.executionUsage).toEqual({ sequence: "2", activeMs: 245, unknown: true }); expect(snapshot.revision).toBe(revision);
    expect(f.record.events.filter(event => event.type === "usage.updated")).toHaveLength(2);
  });
  it("retains answered decision cards and reserved continuation discovery across reload", async () => {
    const f = await fixture(), decisionId = randomUUID(), requestId = randomUUID(), nextRunId = randomUUID();
    f.append({ type: "question_request", questionId: decisionId, blocking: true, questions: [{ id: "choice", question: "Continue?", header: "Next", multiSelect: false, options: [{ id: "yes", label: "Yes", description: "Continue" }] }] });
    const decision = f.record.snapshot.pending[0]!;
    f.store.emit(f.record, "decision.resolved", { decisionId, decision, state: "resolved", response: { kind: "question", answers: { choice: ["yes"] } } });
    f.store.emit(f.record, "control.updated", { requestId, receipt: { requestId, run: f.record.snapshot.ref, state: "applied", revision: f.record.snapshot.revision, continuation: { run: { provider, id: nextRunId }, state: "awaiting_authorization" } } });
    await f.store.save(f.session); const loaded = (await f.store.run(f.record.snapshot.ref.id)).record.snapshot;
    expect(loaded.decisions?.[0]).toMatchObject({ decision: JSON.parse(JSON.stringify(decision)), state: "resolved", response: { kind: "question" } });
    expect(loaded.pendingContinuations).toEqual([{ requestId, run: { provider, id: nextRunId }, state: "awaiting_authorization" }]);
    validateAgentRunSnapshot(loaded);
  });
  it("repairs retained applied answers only after owner validation and emits one durable resolution", async () => {
    const f = await fixture(), requestId = randomUUID();
    f.append({ type: "question_request", questionId: "answered-offline", blocking: true, source: child, questions: [{ id: "q", question: "Continue?", header: "Continue", multiSelect: false, options: [{ id: "yes", label: "Yes", description: "Continue execution" }] }] });
    const decision = structuredClone(f.record.snapshot.pending[0]!), response = { kind: "question" as const, answers: { q: "yes" } };
    f.record.snapshot.pending = []; f.record.snapshot.decisions![0]!.state = "unknown";
    f.record.controls[requestId] = { hash: "retained-command", decisionId: decision.id, decision, response, receipt: { requestId, run: f.record.snapshot.ref, revision: "1", state: "applied" } };
    await f.store.save(f.session);
    const controller = new ProviderController(f.store, {} as never, {} as never, fixtureCapabilities); controller.driver = { synchronize: async () => {} } as never;
    const before = f.record.events.length;
    await expect(controller.snapshot(f.record.snapshot.ref.id, { ...actor, callerInstallation: "wrong-installation" })).rejects.toMatchObject({ status: 404 });
    expect((await f.store.run(f.record.snapshot.ref.id)).record.events).toHaveLength(before);
    const recovered = await controller.snapshot(f.record.snapshot.ref.id, actor);
    expect(recovered.decisions).toEqual([{ decision, state: "resolved", response }]);
    const events = (await f.store.run(f.record.snapshot.ref.id)).record.events.filter(event => event.type === "decision.resolved");
    expect(events).toEqual([expect.objectContaining({ source: decision.source, data: { decisionId: decision.id, decision, state: "resolved", response } })]);
    const watermark = recovered.lastSequence;
    expect((await controller.snapshot(f.record.snapshot.ref.id, actor)).lastSequence).toBe(watermark);
    expect((await f.store.run(f.record.snapshot.ref.id)).record.events.filter(event => event.type === "decision.resolved")).toHaveLength(1);
    validateAgentRunSnapshot(recovered); for (const event of events) validateAgentEvent(event);
  });
  it.each(["accepted", "unknown", "rejected", "missing-response"] as const)("does not infer a resolved answer from terminal state or missing pending callback: %s", async state => {
    const f = await fixture(), requestId = randomUUID();
    f.append({ type: "question_request", questionId: "uncertain", blocking: true, questions: [{ id: "q", question: "Continue?", header: "Continue", multiSelect: false, options: [] }] });
    const decision = structuredClone(f.record.snapshot.pending[0]!);
    f.record.snapshot.pending = []; f.record.snapshot.state = "succeeded"; f.record.snapshot.phase = "terminal"; f.record.snapshot.stopConfirmed = true; f.record.snapshot.decisions![0]!.state = "unknown";
    f.record.controls[requestId] = { hash: "command", decisionId: decision.id, decision, ...(state === "missing-response" ? {} : { response: { kind: "question", answers: { q: "yes" } } }), receipt: { requestId, run: f.record.snapshot.ref, revision: "1", state: state === "missing-response" ? "applied" : state } };
    expect(projectAppliedDecisionControls(f.store, f.record)).toBe(false);
    expect(f.record.snapshot.decisions![0]!.state).toBe("unknown"); expect(f.record.events.some(event => event.type === "decision.resolved")).toBe(false);
  });
  it("does not repopulate pruned decision history from old applied controls", async () => {
    const f = await fixture(), requestId = randomUUID();
    f.record.controls[requestId] = { hash: "command", decisionId: "old", decision: { id: "old", revision: "1", kind: "approval", delivery: "continue_run" }, response: { kind: "approval", decision: "allow" }, receipt: { requestId, run: f.record.snapshot.ref, revision: "1", state: "applied" } };
    expect(projectAppliedDecisionControls(f.store, f.record)).toBe(false); expect(f.record.snapshot.decisions).toEqual([]);
  });
  it("supersedes a delayed native decision after cancellation instead of reopening its prompt", async () => {
    const f = await fixture(); f.record.decisionsFenced = true;
    f.append({ type: "approval_request", approvalId: randomUUID(), toolName: "Write", input: {} });
    expect(f.record.snapshot.pending).toEqual([]);
    expect(f.record.snapshot.decisions?.[0]?.state).toBe("superseded");
    expect(f.record.events.at(-1)?.type).toBe("decision.resolved");
  });
  it("bounds retained decision bytes before oversized history blocks lifecycle snapshots", async () => {
    const f = await fixture();
    for (let index = 0; index < 25; index++) {
      const decision = { id: randomUUID(), revision: "1", kind: "approval", delivery: "continue_run", input: { explanation: "x".repeat(8000) } };
      f.store.emit(f.record, "decision.resolved", { decisionId: decision.id, decision, state: "resolved", response: { kind: "approval", decision: "deny" } });
    }
    expect(Buffer.byteLength(JSON.stringify(f.record.snapshot.decisions))).toBeLessThanOrEqual(128 * 1024);
    expect(f.record.snapshot.coverage?.decisions).toBe("truncated"); f.store.lifecycle(f.record); validateAgentRunSnapshot(f.record.snapshot);
  });
});

it("marks explicitly incomplete native child tool coverage without changing stop evidence", async () => {
  const f = await fixture();
  f.append({ type: "notice", message: "Verified child metadata is unavailable.", incomplete: ["tools"] });
  expect(f.record.snapshot.coverage?.tools).toBe("truncated");
  expect(f.record.snapshot.stopConfirmed).toBe(false);
  expect(f.record.snapshot.result).toBeUndefined();
});


it("distinguishes confirmed process exit from unresolved outcomes without releasing the execution fence", async () => {
  const f = await fixture();
  f.session.session.activeRun = f.record.snapshot.ref;
  const receipt: WorkerReceipt = { runId: f.record.snapshot.ref.id, conversationId: f.session.id, generation: "native", state: "completed", revision: 2,
    selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    exitConfirmed: true, effects: { [nativeEventIdentity(child, "last-call")]: "started" } };
  projectReceipt(f.store, f.session, f.record, receipt);
  expect(f.record.snapshot).toMatchObject({ state: "unknown", phase: "interrupted", stopConfirmed: false, freshness: "last_known" });
  expect(f.session.session.activeRun).toEqual(f.record.snapshot.ref);
  const warnings = () => f.record.events.filter(event => event.type === "warning" && event.data.code === "native_effect_outcomes_unresolved");
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]!.data.message).toContain("native process has stopped");
  projectReceipt(f.store, f.session, f.record, receipt);
  expect(warnings()).toHaveLength(1);
  projectReceipt(f.store, f.session, f.record, { ...receipt, revision: 3, effects: {} });
  expect(f.record.snapshot).toMatchObject({ state: "succeeded", stopConfirmed: true });
  expect(f.session.session.activeRun).toBeNull();
  for (const event of f.record.events) validateAgentEvent(event);
});


it.each(["completed", "cancelled"] as const)("shares confirmed whole-tree stop with observed children without inventing success: %s", async state => {
  const f = await fixture();
  f.append({ type: "agent_status", ...child, state: "running", stopConfirmed: false, source: child });
  f.append({ type: "agent_status", agentId: "finished", parentAgentId: "root", state: "succeeded", stopConfirmed: false,
    source: { agentId: "finished", parentAgentId: "root" } });
  const receipt: WorkerReceipt = { runId: f.record.snapshot.ref.id, conversationId: f.session.id, generation: "native", state, revision: 2,
    selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exitConfirmed: true, effects: {} };
  projectReceipt(f.store, f.session, f.record, { ...receipt, effects: { outstanding: "started" } });
  expect(f.record.snapshot.agents!.every(agent => agent.stopConfirmed === false)).toBe(true);
  projectReceipt(f.store, f.session, f.record, receipt);
  expect(f.record.snapshot.agents).toMatchObject([{ state: "unknown", stopConfirmed: true }, { state: "succeeded", stopConfirmed: true }]);
  const count = f.record.events.length;
  projectReceipt(f.store, f.session, f.record, receipt);
  expect(f.record.events).toHaveLength(count);
  for (const event of f.record.events) validateAgentEvent(event);
});
