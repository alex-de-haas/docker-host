import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRunInput } from "@hosty-sdk/app/agent";
import type { HarnessStartOptions, HarnessAdapter } from "./internal/harness/adapter.js";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { AttachmentStore } from "./attachments.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const close of closers.splice(0).reverse()) await close(); } finally { vi.useRealTimers(); } });
const provider = { appId: "standalone.agent", installationId: "provider-instance", key: "default" };
const actor: VerifiedOperation = { userId: "user", principalId: "original", callerAppId: "independent.consumer", callerInstallation: "consumer-instance", admissionRef: "fresh-authority", operation: "runs.start", provider };
async function setup(block = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-native-provider-")); closers.push(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "connection-home"); await mkdir(home);
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const starts: HarnessStartOptions[] = [], sent: string[] = []; let stops = 0, claims = 0;
  const adapter: HarnessAdapter = { name: "fixture", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true }, probe: vi.fn(async () => ({ available: true })), start: options => {
    starts.push(options);
    return { send: text => { sent.push(text); options.onEvent({ type: "harness_session", harnessSessionId: "native-fixture-session" });
      if (block) options.onEvent({ type: "question_request", questionId: "pending-question", blocking: true, questions: [{ id: "choice", question: "Continue?", header: "Continue", multiSelect: false, allowText: false, options: [{ id: "yes", label: "Yes", description: "Continue execution" }] }] });
      else { options.onEvent({ type: "assistant_delta", text: "Answer" }); options.onEvent({ type: "assistant_text", text: "Answer" }); options.onEvent({ type: "result", status: "success" }); }
    }, resolveApproval: () => true, resolveQuestion: vi.fn(() => true), setMcpServers: async () => true, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => { stops++; } };
  } };
  const connections = { binding: vi.fn(async () => ({ connectionId: "connection", connectionRevision: 1, harnessKind: "fixture-engine" })),
    reserve: async () => { claims++; return () => { claims--; }; }, prepareAdapter: async () => adapter, executionHome: async () => home, shutdown: async () => {} } as unknown as AgentConnections;
  const authority = { admit: vi.fn(async () => ({})), renew: vi.fn(async () => ({})), skills: vi.fn(async () => { throw new Error("A plain request must not require skill-library authority."); }), workspace: vi.fn(async () => ({ state: "released" })) } as unknown as ProviderAuthority;
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities);
  const driver = new NativeExecution(controller, store, authority, connections, new AttachmentStore(path.join(directory, "assets"), provider), directory, () => "http://127.0.0.1:1");
  controller.driver = driver; await driver.initialize(); closers.push(() => controller.close());
  const sessionId = randomUUID(), input = { configuration: { connection: { id: "connection", revision: "1" } } };
  await controller.createSession(sessionId, input, JSON.stringify(input), actor);
  return { controller, driver, store, authority, sessionId, starts, sent, adapter, counts: () => ({ stops, claims }) };
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("Provider state did not reach the expected condition.");
}
describe("native execution behind the public lifecycle", () => {
  it("adds only an explicitly admitted workflow server without selecting a Core MCP target", async () => {
    const f = await setup(), id = randomUUID(), workflow = { executor: { appId: actor.callerAppId, installationId: actor.callerInstallation, key: "workflow" }, sessionId: f.sessionId };
    vi.mocked(f.authority.admit).mockResolvedValue({ ceiling: { workflow } });
    const mcpToken = vi.fn(async () => { throw new Error("Workflow must not mint Core MCP authority."); }); f.authority.mcp = mcpToken;
    const command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Business workflow" } };
    await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    // Native exit is durably published before the synchronization tail removes its workflow server.
    await until(async () => ({ snapshot: await f.controller.snapshot(id), workflow: f.driver.mcp.workflow.target(id) }),
      state => state.snapshot.stopConfirmed && state.workflow === undefined);
    expect(Object.keys(f.starts[0]!.mcpServers ?? {})).toEqual(["hosty-workflow"]); expect(mcpToken).not.toHaveBeenCalled();
    expect(f.driver.mcp.workflow.target(id)).toBeUndefined();
  });
  it("retains the answered card when Core resumes a native question without a connected consumer", async () => {
    const f = await setup(true), id = randomUUID(), coreId = randomUUID();
    const command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Ask while the consumer is offline" } };
    await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    const waiting = await until(() => f.controller.snapshot(id), snapshot => snapshot.pending.length === 1 && snapshot.phase === "waiting");
    const pending = structuredClone(waiting.pending[0]!);
    let remote = { id: coreId, revision: 1, state: "pending", continuation: { revision: 1, state: "received", commandId: null as string | null }, resolution: undefined as unknown };
    const core = { create: vi.fn(async () => structuredClone(remote)), get: vi.fn(async () => structuredClone(remote)),
      acknowledge: vi.fn(async () => structuredClone(remote)), continuation: vi.fn(async (_id: string, input: { expectedRevision: number; state: string; commandId: string }) => {
        expect(input.expectedRevision).toBe(remote.continuation.revision);
        remote.continuation = { revision: remote.continuation.revision + 1, state: input.state, commandId: input.commandId };
        return structuredClone(remote);
      }) };
    f.authority.decisions = (() => core) as unknown as ProviderAuthority["decisions"];
    const deliver = vi.spyOn(f.driver.engine, "respond");
    await f.driver.maintain();
    remote = { ...remote, state: "answered", resolution: { revision: 1, answers: { choice: { optionIds: ["yes"] } } } };
    await f.driver.maintain();
    await until(() => f.store.run(id), value => Object.values(value.record.controls).some(control => control.receipt.state === "applied"));
    const native = await f.driver.engine.journal.load(id);
    expect(Object.values(native.controls)).toEqual([expect.objectContaining({ applied: true })]); expect(native.receipt.pending).toEqual([]);
    f.starts[0]!.onEvent({ type: "assistant_text", text: "Continued from the Core answer" });
    f.starts[0]!.onEvent({ type: "result", status: "success" });
    await until(() => f.controller.snapshot(id), snapshot => snapshot.stopConfirmed);
    await f.driver.maintain();
    expect(remote.continuation.state).toBe("completed"); expect(deliver).toHaveBeenCalledTimes(1);
    const persisted = await f.store.run(id), history = persisted.record.snapshot.decisions?.find(entry => entry.decision.id === pending.id);
    expect(history).toEqual({ decision: pending, state: "resolved", response: { kind: "question", answers: { choice: "yes" } } });
    expect(persisted.record.snapshot.pending).toEqual([]);
    expect(persisted.record.events.filter(event => event.type === "decision.resolved" && event.data.decisionId === pending.id)).toEqual([
      expect.objectContaining({ source: pending.source, data: { decisionId: pending.id, decision: pending, state: "resolved", response: history!.response } }),
    ]);
    await f.controller.snapshot(id, actor); await f.driver.maintain();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await f.store.run(id)).record.events.filter(event => event.type === "decision.resolved")).toHaveLength(1);
  });
  it("needs neither a Harness callback nor skill/MCP grants for an ordinary turn and strictly resumes its native session", async () => {
    const f = await setup(); expect(f.starts).toHaveLength(0); expect(f.adapter.probe).not.toHaveBeenCalled();
    const firstId = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "First question" } };
    await f.controller.startRun(f.sessionId, firstId, command, JSON.stringify(command), actor);
    const completed = await until(() => f.controller.snapshot(firstId), snapshot => snapshot.stopConfirmed);
    expect(completed).toMatchObject({ state: "succeeded", result: { text: "Answer" } }); expect(f.counts()).toEqual({ stops: 1, claims: 0 });
    expect(f.authority.skills).not.toHaveBeenCalled(); expect(f.authority.admit).toHaveBeenCalledTimes(1);
    expect(f.starts[0]!.mcpServers).toEqual({});
    const session = await f.store.load(f.sessionId), secondId = randomUUID();
    const next: AgentRunInput = { ...command, expectedSessionRevision: session.session.revision, continuation: "resume", input: { text: "Next question" } };
    await f.controller.startRun(f.sessionId, secondId, next, JSON.stringify(next), actor); await until(() => f.controller.snapshot(secondId), snapshot => snapshot.stopConfirmed);
    expect(f.starts[1]).toMatchObject({ resumeHarnessSessionId: "native-fixture-session", requireNativeResume: true }); expect(f.sent).toEqual(["First question", "Next question"]);
  });
  it.each(["a".repeat(159) + "😀/managed/project/".repeat(20), " \u0001\n\u0085 "])("bounds only the Core question summary and preserves full provider detail", async fullTitle => {
    const f = await setup(true), id = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Ask" } };
    await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    await until(() => f.controller.snapshot(id), snapshot => snapshot.pending.length === 1);
    await f.store.exclusive(async () => { const current = await f.store.run(id); current.record.snapshot.pending[0]!.title = fullTitle; await f.store.save(current.session); });
    const create = vi.fn(async (input: { input: { title: string } }) => {
      const title = input.input.title;
      expect(title.length).toBeLessThanOrEqual(160); expect(title.trim()).not.toBe("");
      expect(/\p{Cc}/u.test(title)).toBe(false); expect(/[\uD800-\uDBFF]$/.test(title)).toBe(false);
      return { id: "core-bounded-question" };
    });
    f.authority.decisions = (() => ({ create, get: async () => ({ state: "pending" }) })) as unknown as ProviderAuthority["decisions"];
    await f.driver.maintain(); expect(create).toHaveBeenCalledTimes(1);
    expect((await f.controller.snapshot(id)).pending[0]!.title).toBe(fullTitle);
    expect(create.mock.calls[0]![0].input.title).toBe(fullTitle.startsWith("a") ? "a".repeat(159) : "Agent needs your answer");
  });
  it("automatically parks after five durable minutes and reserves an explicitly authorized strict-resume turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const f = await setup(true), id = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Ask before acting" } };
    await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    const waiting = await until(() => f.controller.snapshot(id), snapshot => snapshot.pending.length === 1 && snapshot.phase === "waiting");
    const oldDecision = waiting.pending[0]!, saved = await f.store.run(id), since = Date.parse(saved.record.blockingQuestionSince![oldDecision.revision]!);
    await f.store.exclusive(async () => { const current = await f.store.run(id); current.record.decisionLinks = { [oldDecision.id]: "original-core-question" }; await f.store.save(current.session); });
    const park = vi.spyOn(f.driver.engine, "park");
    vi.setSystemTime(since + 5 * 60_000 - 1); await f.driver.maintain();
    expect(park).not.toHaveBeenCalled(); expect(f.counts().stops).toBe(0);
    vi.setSystemTime(since + 5 * 60_000); await f.driver.maintain();
    const parked = await until(() => f.controller.snapshot(id), snapshot => snapshot.phase === "parked" && snapshot.stopConfirmed);
    expect(park).toHaveBeenCalledTimes(1); expect(f.counts()).toEqual({ stops: 1, claims: 0 });
    expect(parked.pending[0]).toMatchObject({ id: oldDecision.id, delivery: "next_turn" });
    expect(parked.pending[0]!.revision).not.toBe(oldDecision.revision);
    expect((await f.store.run(id)).record.decisionLinks).toEqual({ [oldDecision.id]: "original-core-question" });
    await f.driver.maintain(); expect(park).toHaveBeenCalledTimes(1);
    const response = { requestId: randomUUID(), expectedGeneration: parked.generation, expectedRevision: parked.revision,
      decisionId: oldDecision.id, decisionRevision: parked.pending[0]!.revision, response: { kind: "question" as const, answers: { choice: "yes" } } };
    const receipt = await f.controller.respond(id, response, JSON.stringify(response), actor);
    expect(receipt.continuation?.state).toBe("awaiting_authorization"); expect(f.starts).toHaveLength(1);
    const session = await f.store.load(f.sessionId), nextId = receipt.continuation!.run.id;
    const next: AgentRunInput = { expectedSessionRevision: session.session.revision, configurationRevision: session.session.configurationRevision,
      continuation: "resume", input: { decisionResponseRef: { runId: id, requestId: response.requestId } } };
    await f.controller.startRun(f.sessionId, nextId, next, JSON.stringify(next), { ...actor, admissionRef: "new-exact-authorization" });
    await until(() => f.controller.snapshot(nextId), snapshot => snapshot.pending.length === 1);
    expect(f.starts).toHaveLength(2); expect(f.starts[1]).toMatchObject({ resumeHarnessSessionId: "native-fixture-session", requireNativeResume: true });
    expect(f.authority.admit).toHaveBeenCalledWith("new-exact-authorization");
  });
  it("does not release an awaiting native callback until cancellation confirms the known execution stop", async () => {
    const f = await setup(true), id = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Ask before acting" } };
    await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    const waiting = await until(() => f.controller.snapshot(id), snapshot => snapshot.pending.length === 1);
    expect(waiting.stopConfirmed).toBe(false); expect(f.counts().claims).toBe(1);
    const cancel = { requestId: randomUUID(), expectedGeneration: waiting.generation, expectedRevision: waiting.revision };
    await f.controller.cancel(id, cancel, JSON.stringify(cancel), actor);
    expect((await until(() => f.controller.snapshot(id), snapshot => snapshot.stopConfirmed)).state).toBe("cancelled"); expect(f.counts()).toEqual({ stops: 1, claims: 0 });
  });
});
