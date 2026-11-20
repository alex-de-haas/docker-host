import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentRunControlInput, AgentRunInput } from "@hosty-sdk/app/agent";
import type { HarnessAdapter, HarnessStartOptions } from "./internal/harness/adapter.js";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { bytesHash, ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { AttachmentStore } from "./attachments.js";
import { TrackedNativeProcesses } from "./tracked-process.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(skills = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-driver-review-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home"), skillPath = path.join(directory, "skills"); await mkdir(home); await mkdir(skillPath);
  const provider = { appId: "independent.provider", installationId: "installation", key: "execution" }, actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "original-admission", provider, operation: "runs.start" };
  let pinned = { id: "a".repeat(64), path: skillPath, digest: "b".repeat(64), skills: [{ skillId: "c".repeat(64), digest: "d".repeat(64) }] };
  const authority = { admit: vi.fn(async () => ({})), renew: vi.fn(async () => ({})), workspace: vi.fn(async () => ({ state: "released" })), skills: vi.fn(async () => structuredClone(pinned)) } as unknown as ProviderAuthority;
  const starts = vi.fn(), stop = vi.fn(async () => {});
  const adapter: HarnessAdapter = { name: "isolated-sdk", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true }, probe: async () => ({ available: true }), start: options => {
    starts(options); return { send: () => options.onEvent({ type: "harness_session", harnessSessionId: "native-session" }), stop, stopAndWait: stop, interrupt: async () => {}, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => true };
  } };
  const connections = { binding: async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" }), reserve: async () => () => {}, prepareAdapter: async () => adapter, executionHome: async () => home, shutdown: async () => {} } as unknown as AgentConnections;
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities), driver = new NativeExecution(controller, store, authority, connections, new AttachmentStore(path.join(directory, "assets"), provider), directory, () => "http://127.0.0.1:1");
  controller.driver = driver; await driver.initialize();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await controller.close(); } }; cleanup.push(close);
  const id = randomUUID(), input = { configuration: { connection: { id: "account", revision: "1" }, ...(skills ? { skills: [{ skillId: "c".repeat(64) }] } : {}) } };
  await controller.createSession(id, input, JSON.stringify(input), actor);
  return { directory, store, controller, driver, actor, provider, connections, close, sessionId: id, authority, starts, stop, setPinned: (value: Partial<typeof pinned>) => { pinned = { ...pinned, ...value }; } };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Start" } };
  await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), f.actor); return id;
}
async function retainedNativeRun() {
  const f = await fixture();
  const session = await f.store.load(f.sessionId);
  const id = randomUUID();
  const run = f.store.makeRun(session, id, f.actor, "{}");
  run.snapshot.state = "unknown";
  run.snapshot.phase = "interrupted";
  session.runs[id] = run;
  session.session.activeRun = run.snapshot.ref;
  await f.store.save(session);
  await f.driver.engine.journal.accept(id, {
    conversationId: f.sessionId,
    binding: { connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" },
    selection: { model: null, reasoningEffort: null },
    resource: { kind: "conversation", id: f.sessionId },
    input: "Previously accepted turn", options: {}, autoAllowedPrefixes: [],
  });
  const processes = await TrackedNativeProcesses.create(f.directory, id, run.snapshot.generation);
  return { f, id, processes };
}
async function reconcile(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const snapshot = await f.controller.snapshot(id), command: AgentRunControlInput = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision, command: "reconcile", stopped: true };
  await f.controller.control(id, command, JSON.stringify(command), f.actor);
  await vi.waitFor(async () => expect((await f.store.run(id)).record.controls[command.requestId]?.receipt.state).not.toBe("accepted"));
  return (await f.store.run(id)).record.controls[command.requestId]!.receipt;
}
describe("native authority renewal and stop reconciliation", () => {
  it("does not release a never-admitted cancel fence or replay its delayed identical start", async () => {
    const f = await fixture(), maintain = f.driver.maintain.bind(f.driver); vi.spyOn(f.driver, "maintain").mockResolvedValue();
    const id = randomUUID(), input: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Delayed start" } }, body = JSON.stringify(input);
    const cancel = { requestId: randomUUID(), fenceIfNotAdmitted: { sessionId: f.sessionId, startDigest: bytesHash(body) } }, cancelBody = JSON.stringify(cancel);
    const receipt = await f.controller.cancel(id, cancel, cancelBody, { ...f.actor, operation: "runs.cancel", admissionRef: "cancel-admission-without-session" });
    expect(receipt.state).toBe("applied");
    const fenced = await f.controller.snapshot(id); await maintain();
    const before = (await f.store.run(id)).record;
    expect(before).toMatchObject({ hash: bytesHash(body), cancelFence: true, controls: { [cancel.requestId]: { hash: bytesHash(cancelBody) } } });
    expect(before.input).toBeUndefined(); expect(before.workspaceRelease).toBeUndefined();
    const delayed = await f.controller.startRun(f.sessionId, id, input, body, f.actor); await maintain();
    expect(delayed).toMatchObject({ generation: fenced.generation, state: "cancelled", stopConfirmed: true });
    expect((await f.store.run(id)).record).toEqual(before);
    expect(f.authority.workspace).not.toHaveBeenCalled(); expect(f.authority.admit).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled();
  });
  it("does not release a superseded question reservation under response-only authority", async () => {
    const f = await fixture(), maintain = f.driver.maintain.bind(f.driver); vi.spyOn(f.driver, "maintain").mockResolvedValue();
    const id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    (f.starts.mock.calls[0]![0] as HarnessStartOptions).onEvent({ type: "question_request", questionId: "child-choice", blocking: true,
      questions: [{ id: "choice", header: "Continue", question: "Continue?", multiSelect: false, allowText: false, options: [{ id: "yes", label: "Yes", description: "Continue" }] }] });
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).pending).toHaveLength(1));
    const waiting = await f.controller.snapshot(id), pending = waiting.pending[0]!;
    const park: AgentRunControlInput = { requestId: randomUUID(), expectedGeneration: waiting.generation, expectedRevision: waiting.revision,
      command: "park", decisionId: pending.id, decisionRevision: pending.revision };
    await f.controller.control(id, park, JSON.stringify(park), f.actor);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true)); await f.driver.synchronize(id);
    const parked = await f.controller.snapshot(id), response = { requestId: randomUUID(), expectedGeneration: parked.generation, expectedRevision: parked.revision,
      decisionId: pending.id, decisionRevision: parked.pending[0]!.revision, response: { kind: "question" as const, answers: { choice: "yes" } } };
    const receipt = await f.controller.respond(id, response, JSON.stringify(response), { ...f.actor, operation: "runs.respond", admissionRef: "response-admission-without-session" });
    const reservedId = receipt.continuation!.run.id, reserved = await f.controller.snapshot(reservedId);
    const cancel = { requestId: randomUUID(), expectedGeneration: reserved.generation, expectedRevision: reserved.revision };
    await f.controller.cancel(reservedId, cancel, JSON.stringify(cancel), f.actor);
    await f.controller.snapshot(reservedId); await maintain();
    const superseded = (await f.store.run(reservedId)).record;
    expect(superseded).toMatchObject({ admissionRef: "response-admission-without-session", snapshot: { state: "cancelled", stopConfirmed: true } });
    expect(superseded.input).toBeUndefined(); expect(superseded.reservedFor).toBeUndefined(); expect(superseded.workspaceRelease).toBeUndefined();
    expect(vi.mocked(f.authority.workspace).mock.calls.map(call => call[0])).toEqual(["original-admission"]);
    expect(f.authority.admit).toHaveBeenCalledTimes(1); expect(f.starts).toHaveBeenCalledTimes(1);
  });
  it.each(["succeeded", "cancelled"])("retries %s workspace cleanup without a consumer read or native replay", async outcome => {
    const f = await fixture(), maintain = f.driver.maintain.bind(f.driver);
    // Drive the real maintenance pump explicitly, independently of its wall-clock interval.
    vi.spyOn(f.driver, "maintain").mockResolvedValue();
    let coreAvailable = false;
    vi.mocked(f.authority.workspace).mockImplementation(async (admission, operation, input) => {
      expect(admission).toBe("original-admission"); expect(operation).toBe("release_all");
      const retained = Object.values((await f.store.load(f.sessionId)).runs)[0]!;
      expect(retained.workspaceRelease).toEqual({ requestId: (input as { requestId: string }).requestId, state: "pending" });
      if (!coreAvailable) throw new Error("Core response was lost after releasing its admission-owned leases.");
      return { state: "released" } as never;
    });
    const id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    if (outcome === "succeeded") (f.starts.mock.calls[0]![0] as HarnessStartOptions).onEvent({ type: "result", status: "success" });
    else {
      const snapshot = await f.controller.snapshot(id), cancel = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision };
      await f.controller.cancel(id, cancel, JSON.stringify(cancel), f.actor);
    }
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true));
    await f.driver.synchronize(id);
    const pending = (await f.store.run(id)).record.workspaceRelease;
    expect(pending).toEqual({ requestId: expect.any(String), state: "pending" });
    expect((await f.store.run(id)).record.workspaces).toBeUndefined(); // Core also owns leases created by MCP tools.
    const first = vi.mocked(f.authority.workspace).mock.calls[0]!;
    expect(first).toEqual(["original-admission", "release_all", { requestId: pending!.requestId }]);
    await f.controller.snapshot(id); await f.controller.snapshot(id);
    expect(f.authority.workspace).toHaveBeenCalledTimes(1);
    coreAvailable = true;
    await maintain();
    expect((await f.store.run(id)).record.workspaceRelease).toEqual({ ...pending, state: "released" });
    expect(vi.mocked(f.authority.workspace).mock.calls).toEqual([first, first]);
    await maintain(); await f.controller.snapshot(id);
    expect(f.authority.workspace).toHaveBeenCalledTimes(2);
    expect(f.authority.admit).toHaveBeenCalledTimes(1); expect(f.authority.renew).not.toHaveBeenCalled(); expect(f.starts).toHaveBeenCalledTimes(1);
    expect((await f.store.run(id)).record.snapshot).toMatchObject({ state: outcome, stopConfirmed: true });
  });
  it("restores an unacknowledged workspace release and retries its original authority and UUID after restart", async () => {
    const f = await fixture(); vi.spyOn(f.driver, "maintain").mockResolvedValue();
    vi.mocked(f.authority.workspace).mockResolvedValue({ state: "pending" } as never);
    const id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    (f.starts.mock.calls[0]![0] as HarnessStartOptions).onEvent({ type: "result", status: "success" });
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true)); await f.driver.synchronize(id);
    const pending = (await f.store.run(id)).record.workspaceRelease, first = vi.mocked(f.authority.workspace).mock.calls[0]!;
    expect(pending).toEqual({ requestId: expect.any(String), state: "pending" });
    await f.close();
    const store = new ProviderStore(path.join(f.directory, "sessions"), f.provider); await store.initialize();
    const controller = new ProviderController(store, f.authority, f.connections, fixtureCapabilities);
    const driver = new NativeExecution(controller, store, f.authority, f.connections, new AttachmentStore(path.join(f.directory, "assets"), f.provider), f.directory, () => "http://127.0.0.1:1");
    controller.driver = driver; cleanup.push(() => controller.close()); await driver.initialize();
    expect(f.authority.workspace).toHaveBeenCalledTimes(1);
    expect((await store.run(id)).record.workspaceRelease).toEqual(pending);
    vi.mocked(f.authority.workspace).mockResolvedValue({ state: "released" } as never);
    await driver.maintain();
    expect((await store.run(id)).record.workspaceRelease).toEqual({ ...pending, state: "released" });
    expect(vi.mocked(f.authority.workspace).mock.calls).toEqual([first, first]);
    expect(f.authority.admit).toHaveBeenCalledTimes(1); expect(f.authority.renew).not.toHaveBeenCalled(); expect(f.starts).toHaveBeenCalledTimes(1);
  });
  it("retains workspace ownership when cancellation cannot confirm native exit", async () => {
    const f = await fixture(), maintain = f.driver.maintain.bind(f.driver); vi.spyOn(f.driver, "maintain").mockResolvedValue();
    const id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    f.stop.mockRejectedValue(new Error("Native exit is not confirmed."));
    const snapshot = await f.controller.snapshot(id), cancel = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision };
    await f.controller.cancel(id, cancel, JSON.stringify(cancel), f.actor);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).state).toBe("unknown"));
    await maintain();
    expect((await f.store.run(id)).record.workspaceRelease).toBeUndefined(); expect(f.authority.workspace).not.toHaveBeenCalled();
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false);
  });
  it("coalesces overlapping release attempts and drains their acknowledgement before shutdown", async () => {
    const f = await fixture(), maintain = f.driver.maintain.bind(f.driver); vi.spyOn(f.driver, "maintain").mockResolvedValue();
    vi.mocked(f.authority.workspace).mockRejectedValue(new Error("Core is unavailable."));
    const id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    (f.starts.mock.calls[0]![0] as HarnessStartOptions).onEvent({ type: "result", status: "success" });
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true)); await f.driver.synchronize(id);
    let resolveReply!: (value: { state: string }) => void;
    const reply = new Promise<{ state: string }>(resolve => { resolveReply = resolve; }), tasks: Promise<unknown>[] = [];
    vi.mocked(f.authority.workspace).mockImplementation(async () => await reply as never);
    const shutdown = vi.spyOn(f.connections, "shutdown").mockImplementation(async () => {
      expect((await f.store.run(id)).record.workspaceRelease?.state).toBe("released");
    });
    try {
      tasks.push(maintain()); await vi.waitFor(() => expect(f.authority.workspace).toHaveBeenCalledTimes(2));
      tasks.push(f.driver.synchronize(id), f.close());
      resolveReply({ state: "released" }); await Promise.all(tasks);
      expect(f.authority.workspace).toHaveBeenCalledTimes(2); expect(shutdown).toHaveBeenCalledTimes(1);
    } finally { resolveReply({ state: "released" }); await Promise.allSettled(tasks); }
  });
  it.each([
    { id: "e".repeat(64) }, { path: "/different/immutable/export" }, { digest: "e".repeat(64) },
    { skills: [{ skillId: "e".repeat(64), digest: "d".repeat(64) }] }, { skills: [{ skillId: "c".repeat(64), digest: "e".repeat(64) }] },
  ])("rejects changed pinned skill evidence before native dispatch %#", async changed => {
    const f = await fixture(true); f.setPinned(changed); const id = await start(f);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true));
    expect((await f.controller.snapshot(id)).state).toBe("failed"); expect(f.starts).not.toHaveBeenCalled();
  });
  it("stops an active run when successful Core renewal returns different immutable skill content", async () => {
    const f = await fixture(true), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    f.setPinned({ digest: "e".repeat(64) });
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true), { timeout: 4000, interval: 20 });
    expect((await f.controller.snapshot(id)).state).toBe("cancelled"); expect(f.stop).toHaveBeenCalled();
    expect(f.authority.workspace).toHaveBeenCalledWith("original-admission", "release_all", expect.any(Object));
  });
  it("honors an explicit workspace stop request even when execution authority still renews", async () => {
    const f = await fixture(), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    await f.store.exclusive(async () => {
      const { session, record } = await f.store.run(id);
      record.workspaces = [{ id: "selected-tree", revision: "1", path: f.directory, leaseId: randomUUID() }]; await f.store.save(session);
    });
    vi.mocked(f.authority.workspace).mockImplementation(async (_admission, operation) =>
      (operation === "activity" ? { stopRequested: true } : {}) as never);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true), { timeout: 4000, interval: 20 });
    expect((await f.controller.snapshot(id)).state).toBe("cancelled"); expect(f.stop).toHaveBeenCalled();
    expect(f.authority.renew).toHaveBeenCalled();
    expect(f.authority.workspace).toHaveBeenCalledWith("original-admission", "release_all", expect.any(Object));
  });
  it("rejects missing native admission rather than applying client stop attestation", async () => {
    const f = await fixture(), session = await f.store.load(f.sessionId), run = f.store.makeRun(session, randomUUID(), f.actor, "{}");
    run.snapshot.state = "unknown"; run.snapshot.phase = "interrupted"; session.runs[run.snapshot.ref.id] = run; session.session.activeRun = run.snapshot.ref; await f.store.save(session);
    expect(await reconcile(f, run.snapshot.ref.id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(run.snapshot.ref.id)).stopConfirmed).toBe(false); expect((await f.store.load(f.sessionId)).session.activeRun?.id).toBe(run.snapshot.ref.id);
  });
  it("refuses reconciliation while a native query is still running", async () => {
    const f = await fixture(), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false);
  });
  it("does not turn process exit evidence into settlement of unknown tool effects", async () => {
    const { f, id, processes } = await retainedNativeRun();
    await f.driver.engine.journal.append(id, { type: "native_effect", id: "external-call", state: "unknown" });
    await f.driver.engine.journal.update(id, "interrupted");
    await processes.stop();
    await processes.confirmSdkStop();
    expect(await processes.evidence()).toMatchObject({ stopped: true, allClosed: true });
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "effects_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false); expect((await f.driver.engine.journal.load(id)).receipt.effects).toEqual({ "external-call": "unknown" });
  });
  it("requires durable SDK completion as well as sealed process receipts before reconciliation", async () => {
    const { f, id, processes } = await retainedNativeRun();
    await f.driver.engine.journal.update(id, "interrupted");
    expect(await processes.stop()).toMatchObject({ stopped: false, allClosed: true, sealed: true });
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false);
    // The supported SDK adapter alone writes this marker after its stopAndWait succeeds.
    await processes.confirmSdkStop();
    expect(await reconcile(f, id)).toMatchObject({ state: "applied" });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true); expect((await f.store.load(f.sessionId)).session.activeRun).toBeNull();
  });
});
