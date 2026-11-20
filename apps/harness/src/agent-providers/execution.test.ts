import { describe, expect, it, vi } from "vitest";
import type { AgentConfigurationCreate, AgentControlReceipt, AgentPreparedRequest, AgentResponseInput, AgentRunInput, AgentRunSnapshot, AgentSession, AgentWatchItem } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { AgentClient } from "@hosty-sdk/app/agent/client";
import { prepareAgentCancel, prepareAgentControl } from "@hosty-sdk/app/agent/client";
import { ProviderExecution, type ProviderExecutionPersistence, type ProviderExecutionState } from "./execution.js";

const generation = "00000000-0000-4000-8000-000000000001";
const responseId = "00000000-0000-4000-8000-000000000002";
const cancelId = "00000000-0000-4000-8000-000000000003";
const sessionId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const configurationId = "30000000-0000-4000-8000-000000000001";
const provider = { appId: "unrelated.provider", installationId: "installation", key: "coding" };
const input = (): AgentRunInput => ({ expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Original input" } });
const snapshot = (patch: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot => ({
  ref: { provider, id: runId }, sessionId, generation, revision: "3", state: "running", phase: "executing",
  stopConfirmed: false, freshness: "current", observedAt: "2026-11-12T12:00:00Z", configurationRevision: "1",
  lastSequence: "3", cursor: "cursor-3", pending: [], effects: { certainty: "unknown", unresolvedCallIds: [] }, ...patch,
});
const response = (): AgentResponseInput => ({ requestId: responseId, expectedGeneration: generation, expectedRevision: "3",
  decisionId: "approval", decisionRevision: "2", response: { kind: "approval", decision: "allow" } });
const receipt = (requestId: string, state: AgentControlReceipt["state"]): AgentControlReceipt => ({ requestId, state, run: { provider, id: runId }, revision: "4", generation });
const session = (): AgentSession => ({ ref: { provider, id: sessionId }, revision: "5", configurationRevision: "1", configurationDigest: "a".repeat(64),
  nativeState: "available", activeRun: null, resolvedSkills: [], configuration: { connection: { id: "account", revision: "1" } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function fixture(initial: Partial<ProviderExecutionState> = {}) {
  const state: ProviderExecutionState = { version: 1, selection: { provider, connection: { id: "account", revision: "1" } }, sessionId, session: session(), ...initial };
  let durable = structuredClone(state);
  const history: ProviderExecutionState[] = [];
  const persistence = {
    save: vi.fn(async (next: ProviderExecutionState) => { durable = structuredClone(next); history.push(structuredClone(next)); }),
    observe: vi.fn(async (_item: AgentWatchItem, next: ProviderExecutionState) => { durable = structuredClone(next); history.push(structuredClone(next)); }),
  } satisfies ProviderExecutionPersistence;
  const watch: AgentWatchItem[] = [];
  const client = {
    execute: vi.fn(async (_request: AgentPreparedRequest): Promise<unknown> => snapshot()),
    run: vi.fn(async () => snapshot()),
    control: vi.fn(async (_runId: string, requestId: string) => receipt(requestId, "unknown")),
    watchRun: vi.fn(async function* (_runId: string, _options?: { cursor?: string; signal?: AbortSignal }) { yield* watch; }),
  };
  return { state, history, persistence, client, watch, durable: () => durable,
    execution: new ProviderExecution(client as unknown as AgentClient, state, persistence) };
}
const pending = (state: ProviderExecutionState) => Object.values(state.mutations ?? {});

describe("public provider execution durability", () => {
  it.each(["00000000-0000-4000-8000-000000000099", undefined])("does not clear a control from a missing or different execution generation: %s", observedGeneration => {
    const prepared = prepareAgentControl(runId, { requestId: responseId, expectedGeneration: generation, expectedRevision: "3", command: "predictions", enabled: false });
    const f = fixture({ runId, run: snapshot(), mutations: { retained: prepared } });
    f.client.control.mockResolvedValueOnce({ ...receipt(responseId, "applied"), generation: observedGeneration });
    return expect(f.execution.refreshControls()).rejects.toMatchObject({ code: "provider_identity_changed" }).then(() => {
      expect(pending(f.state)).toEqual([prepared]); expect(f.client.execute).not.toHaveBeenCalled();
    });
  });

  it("retries an unknown cancellation with its original bytes after the public revision changes", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(cancelId, "unknown")).mockResolvedValueOnce(receipt(cancelId, "applied"));
    await f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    const original = pending(f.durable())[0]!;
    f.state.run = snapshot({ revision: "90" });
    await f.execution.cancel({ requestId: responseId, expectedGeneration: generation, expectedRevision: "90" });
    expect(f.client.control).toHaveBeenCalledExactlyOnceWith(runId, cancelId);
    expect(f.client.execute.mock.calls.map(([request]) => request)).toEqual([original, original]);
    expect(f.durable().cancellations![runId]).toEqual({ request: original, receipt: receipt(cancelId, "applied") });
    expect(pending(f.durable())).toEqual([]);
    expect(f.state.run.stopConfirmed).toBe(false);
  });

  it("never resends a cancellation after its acknowledged receipt disappears", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(cancelId, "applied"));
    await f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    f.client.control.mockRejectedValueOnce(new AgentApiError("control_not_found", "Receipt unavailable", 404));
    await expect(f.execution.cancel({ requestId: responseId, expectedGeneration: generation, expectedRevision: "90" }))
      .rejects.toMatchObject({ code: "control_unknown" });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(f.durable().cancellations![runId]!.receipt?.state).toBe("applied");
  });

  it("coalesces concurrent Stop bridges and persists their first cancellation before delivery", async () => {
    const f = fixture({ runId, run: snapshot() }), delivered = deferred<unknown>();
    const other = new ProviderExecution(f.client as unknown as AgentClient, f.state, f.persistence);
    f.client.execute.mockImplementation(async request => {
      expect(f.durable().cancellations![runId]!.request).toEqual(request);
      expect(pending(f.durable())).toEqual([request]);
      return delivered.promise;
    });
    const first = f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    const second = other.cancel({ requestId: responseId, expectedGeneration: generation, expectedRevision: "90" });
    await vi.waitFor(() => expect(f.client.execute).toHaveBeenCalledOnce());
    delivered.resolve(receipt(cancelId, "applied"));
    expect(await first).toEqual(await second);
    expect(JSON.parse(f.durable().cancellations![runId]!.request.body).requestId).toBe(cancelId);
    expect(f.client.control).not.toHaveBeenCalled();
  });

  it("does not dispatch cancellation when preserving its identity fails", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.persistence.save.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" })).rejects.toThrow("Disk unavailable");
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.durable().cancellations).toBeUndefined();
    expect(pending(f.durable())).toEqual([]);
  });

  it("rejects a conflicting retained cancellation before dispatch and gives a later run its own identity", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(cancelId, "applied"));
    await f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    const original = f.durable().cancellations![runId]!.request;
    const conflict = prepareAgentCancel(runId, { requestId: cancelId, expectedGeneration: generation, expectedRevision: "90" });
    f.state.mutations = { [`${conflict.method}:${conflict.path}:${conflict.bodyHash}`]: conflict };
    await expect(f.execution.reconcileMutation(conflict)).rejects.toMatchObject({ code: "control_unknown" });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(f.durable().cancellations![runId]!.request).toEqual(original);
    f.state.mutations = {};
    const laterRun = "20000000-0000-4000-8000-000000000002";
    f.state.runId = laterRun; f.state.run = snapshot({ ref: { provider, id: laterRun } });
    f.client.execute.mockResolvedValueOnce({ ...receipt(responseId, "applied"), run: { provider, id: laterRun } });
    await f.execution.cancel({ requestId: responseId, expectedGeneration: generation, expectedRevision: "3" });
    expect(f.durable().cancellations![runId]!.request).toEqual(original);
    expect(JSON.parse(f.durable().cancellations![laterRun]!.request.body).requestId).toBe(responseId);
    expect(f.client.control).not.toHaveBeenCalled();
  });

  it("persists exact immutable command bytes before delivery and before acknowledging admission", async () => {
    const f = fixture(), original = input();
    f.client.execute.mockImplementation(async request => {
      const committed = pending(f.durable());
      expect(committed).toHaveLength(1);
      expect(committed[0]).toEqual(request);
      expect(JSON.parse(request.body).input.text).toBe("Original input");
      expect(request.configurationDigest).toBe(f.state.session!.configurationDigest);
      expect(f.state.run).toBeUndefined();
      return snapshot();
    });
    const admission = f.execution.start(runId, original);
    original.input = { text: "Changed after preparation" };
    await admission;
    expect(f.persistence.observe).not.toHaveBeenCalled();
    expect(f.durable().cursor).toBeUndefined();
    expect(f.durable().run?.ref.id).toBe(runId);
    expect(pending(f.state)).toEqual([]);
    expect(f.client.execute).toHaveBeenCalledOnce();
  });

  it("refuses to bind a new turn to an unconfirmed configuration revision", async () => {
    const f = fixture();
    await expect(f.execution.start(runId, { ...input(), configurationRevision: "2" })).rejects.toMatchObject({ code: "configuration_unknown" });
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(pending(f.durable())).toEqual([]);
  });

  it("retains an unknown start and retries its original ID/body instead of preparing a second run", async () => {
    const f = fixture();
    f.client.execute.mockRejectedValueOnce(new Error("Admission response lost"));
    await expect(f.execution.start(runId, input())).rejects.toThrow("Admission response lost");
    const prepared = pending(f.state)[0]!;
    expect(prepared).toMatchObject({ operation: "runs.start", path: `/sessions/${sessionId}/runs/${runId}` });
    expect(pending(f.durable())).toEqual([prepared]);
    await expect(f.execution.start("different-run", input())).rejects.toThrow("Reconcile");
    expect(f.client.execute).toHaveBeenCalledTimes(1);

    await f.execution.reconcileMutation(prepared);
    expect(f.client.execute.mock.calls[1]![0]).toEqual(f.client.execute.mock.calls[0]![0]);
    expect(f.state.runId).toBe(runId);
    expect(f.state.run?.ref.id).toBe(runId);
    expect(pending(f.durable())).toEqual([]);
  });

  it("never dispatches an in-memory-only command after its first durability write failed", async () => {
    const f = fixture();
    f.persistence.save.mockRejectedValue(new Error("Disk unavailable"));
    await expect(f.execution.start(runId, input())).rejects.toThrow("Disk unavailable");
    expect(f.client.execute).not.toHaveBeenCalled();
    const uncommitted = pending(f.state)[0];
    if (uncommitted) await expect(f.execution.reconcileMutation(uncommitted)).rejects.toThrow("Disk unavailable");
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(pending(f.durable())).toEqual([]);
  });

  it("does not advance a snapshot or replay cursor before its projection commits", async () => {
    const previous = snapshot({ cursor: "old-cursor", lastSequence: "2", revision: "2" });
    const f = fixture({ runId, run: previous, cursor: previous.cursor });
    f.persistence.observe.mockRejectedValueOnce(new Error("Projection write failed"));
    await expect(f.execution.read()).rejects.toThrow("Projection write failed");
    expect(f.state.cursor).toBe("old-cursor");
    expect(f.state.run).toEqual(previous);
    expect(f.durable().cursor).toBe("old-cursor");

    const next = snapshot({ lastSequence: "3", revision: "3", cursor: "next-cursor" });
    f.watch.push({ kind: "event", cursor: next.cursor, event: { schemaVersion: "agent-event.1", runId, generation,
      sequence: "3", revision: "3", type: "run.updated", source: { agentId: "root" }, occurredAt: next.observedAt, data: { snapshot: next } } });
    f.persistence.observe.mockRejectedValueOnce(Object.assign(new Error("Event commit failed"), { code: "session_storage_uncertain" }));
    await expect(f.execution.observe()).rejects.toThrow("Event commit failed");
    expect(f.state.cursor).toBe("old-cursor");
    expect(f.state.run).toEqual(previous);
  });

  it("retains independent concurrent cancel/respond requests and clears only the acknowledged one", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3" });
    const responded = deferred<unknown>(), cancelled = deferred<unknown>();
    f.client.execute.mockImplementation(request => request.operation === "runs.respond" ? responded.promise : cancelled.promise);
    const answering = f.execution.respond(response());
    const cancelling = f.execution.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    await vi.waitFor(() => expect(f.client.execute).toHaveBeenCalledTimes(2));
    expect(pending(f.durable()).map(request => request.operation).sort()).toEqual(["runs.cancel", "runs.respond"]);
    responded.resolve(receipt(responseId, "applied"));
    cancelled.resolve(receipt(cancelId, "unknown"));
    await Promise.all([answering, cancelling]);
    expect(pending(f.state)).toHaveLength(1);
    expect(pending(f.state)[0]!.operation).toBe("runs.cancel");
    expect(pending(f.durable())).toEqual(pending(f.state));
  });

  it("retries an unknown control with exact old expected revisions after a newer snapshot arrives", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(responseId, "unknown")).mockResolvedValueOnce(receipt(responseId, "applied"));
    await f.execution.respond(response());
    const prepared = pending(f.state)[0]!;
    f.client.run.mockResolvedValueOnce(snapshot({ revision: "90", lastSequence: "100", cursor: "newer" }));
    await f.execution.read();
    await f.execution.reconcileMutation(prepared);
    expect(f.client.execute.mock.calls[1]![0]).toEqual(f.client.execute.mock.calls[0]![0]);
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body)).toMatchObject({ expectedRevision: "3", decisionRevision: "2", requestId: responseId });
    expect(pending(f.state)).toEqual([]);
  });

  it("does not forget an acknowledged control until cleanup is durably committed", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(responseId, "applied"));
    const commit = f.persistence.save.getMockImplementation()!;
    f.persistence.save.mockImplementationOnce(commit);
    f.persistence.save.mockRejectedValueOnce(new Error("Cleanup write failed"));
    await expect(f.execution.respond(response())).rejects.toThrow("Cleanup write failed");
    expect(pending(f.state)).toHaveLength(1);
    expect(JSON.parse(pending(f.state)[0]!.body)).toMatchObject({ requestId: responseId, expectedRevision: "3" });
    expect(pending(f.durable())).toEqual(pending(f.state));
    expect(f.client.execute).toHaveBeenCalledOnce();
  });

  it("persists configuration CAS bytes and remembers only the exact acknowledged configuration", async () => {
    const f = fixture({ session: session() });
    const request: AgentConfigurationCreate = { requestId: configurationId, expectedSessionRevision: "5", configuration: {
      connection: { id: "account", revision: "1" }, approvalMode: "autonomous", predictions: { enabled: true },
    } };
    f.client.execute.mockImplementation(async prepared => {
      expect(prepared).toMatchObject({ operation: "sessions.configure", path: `/sessions/${sessionId}/configurations/${configurationId}` });
      expect(pending(f.durable())).toEqual([prepared]);
      return { ...session(), revision: "6", configurationRevision: "2", configurationDigest: "b".repeat(64), configuration: JSON.parse(prepared.body).configuration };
    });
    const changing = f.execution.configure(configurationId, request);
    request.configuration.approvalMode = "normal";
    await changing;
    expect(JSON.parse(f.client.execute.mock.calls[0]![0].body)).toMatchObject({ expectedSessionRevision: "5", configuration: { approvalMode: "autonomous", predictions: { enabled: true } } });
    expect(f.state.appliedConfiguration).toMatchObject({ revision: "2", digest: "b".repeat(64), value: { approvalMode: "autonomous", predictions: { enabled: true } } });
    expect(f.state.session?.revision).toBe("6");
    expect(pending(f.durable())).toEqual([]);
    expect(f.persistence.observe).not.toHaveBeenCalled();
  });

  it("fences an uncertain configuration and reconciles the original optimistic revision", async () => {
    const f = fixture({ session: session() });
    const request: AgentConfigurationCreate = { requestId: configurationId, expectedSessionRevision: "5", configuration: {
      connection: { id: "account", revision: "1" }, approvalMode: "autonomous",
    } };
    f.client.execute.mockRejectedValueOnce(new Error("Configuration response lost"));
    await expect(f.execution.configure(configurationId, request)).rejects.toThrow("Configuration response lost");
    const prepared = pending(f.state)[0]!;
    await expect(f.execution.configure("30000000-0000-4000-8000-000000000002", { ...request, requestId: "30000000-0000-4000-8000-000000000002", expectedSessionRevision: "90" }))
      .rejects.toThrow("Reconcile");
    f.state.session = { ...session(), revision: "90" };
    f.client.execute.mockResolvedValueOnce({ ...session(), revision: "6", configurationRevision: "2", configuration: request.configuration });
    await f.execution.reconcileMutation(prepared);
    expect(f.client.execute.mock.calls[1]![0]).toEqual(f.client.execute.mock.calls[0]![0]);
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body).expectedSessionRevision).toBe("5");
    expect(f.state.appliedConfiguration?.value.approvalMode).toBe("autonomous");
    expect(pending(f.state)).toEqual([]);
  });

  it("validates session ownership even for a stop read that deliberately bypasses projection", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3" });
    f.client.run.mockResolvedValueOnce(snapshot({ sessionId: "another-session", stopConfirmed: true, state: "cancelled" }));
    await expect(f.execution.read(false)).rejects.toThrow("another session or installation");
    expect(f.persistence.observe).not.toHaveBeenCalled();
    expect(f.state.run?.stopConfirmed).toBe(false);
  });

  it("serializes distinct control bridges sharing one state while persistence is delayed", async () => {
    const f = fixture({ runId, run: snapshot() });
    const other = new ProviderExecution(f.client as unknown as AgentClient, f.state, f.persistence);
    const blocked = deferred<void>(), entered = deferred<void>(), originalSave = f.persistence.save.getMockImplementation()!;
    f.persistence.save.mockImplementationOnce(async next => { entered.resolve(); await blocked.promise; await originalSave(next); });
    f.client.execute.mockImplementation(async request => receipt(JSON.parse(request.body).requestId,
      request.operation === "runs.respond" ? "applied" : "unknown"));
    const answering = f.execution.respond(response());
    await entered.promise;
    const cancelling = other.cancel({ requestId: cancelId, expectedGeneration: generation, expectedRevision: "3" });
    await Promise.resolve();
    expect(f.persistence.save).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await Promise.all([answering, cancelling]);
    expect(pending(f.state)).toHaveLength(1);
    expect(pending(f.state)[0]!.operation).toBe("runs.cancel");
    expect(pending(f.durable())).toEqual(pending(f.state));
    expect(f.history.some(committed => pending(committed).length === 2)).toBe(true);
  });

  it("does not overwrite a concurrent outbox when a delayed manager projection completes", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3", mutations: {} });
    const other = new ProviderExecution(f.client as unknown as AgentClient, f.state, f.persistence);
    const blocked = deferred<void>(), entered = deferred<void>(), commit = f.persistence.save.getMockImplementation()!;
    f.persistence.observe.mockImplementationOnce(async (_item, observed) => {
      entered.resolve(); await blocked.promise;
      // The manager/store contract merges only observation fields into the latest durable sidecar.
      await commit({ ...f.durable(), run: observed.run, cursor: observed.cursor });
    });
    const reading = f.execution.read();
    await entered.promise;
    f.client.execute.mockResolvedValueOnce(receipt(responseId, "unknown"));
    await other.respond(response());
    expect(pending(f.state)).toHaveLength(1);
    blocked.resolve();
    await reading;
    expect(pending(f.state)).toHaveLength(1);
    expect(pending(f.durable())).toEqual(pending(f.state));
  });

  it("resets the old cursor only when a new start is durably staged and rejects replacement stop generations", async () => {
    const old = snapshot({ stopConfirmed: true, state: "succeeded" });
    const f = fixture({ runId, run: old, cursor: "old-projection" });
    f.client.run.mockResolvedValueOnce({ ...old, generation: "00000000-0000-4000-8000-000000000099" });
    await expect(f.execution.read(false)).rejects.toThrow("generation changed");
    expect(f.state.cursor).toBe("old-projection");
    const nextId = "20000000-0000-4000-8000-000000000002";
    f.client.execute.mockImplementation(async prepared => {
      expect(f.durable().runId).toBe(nextId);
      expect(f.durable().cursor).toBeUndefined();
      expect(f.durable().run).toBeUndefined();
      return snapshot({ ref: { provider, id: prepared.runId! } });
    });
    await f.execution.start(nextId, input());
    expect(f.state.cursor).toBeUndefined();
    expect(f.state.run?.ref.id).toBe(nextId);
  });

  it("settles only matching start/cancel bytes after durable authoritative stop proof", async () => {
    const f = fixture();
    f.client.execute.mockRejectedValueOnce(new Error("Start response lost"));
    await expect(f.execution.start(runId, input())).rejects.toThrow("Start response lost");
    const start = pending(f.state)[0]!;
    f.client.execute.mockImplementation(async request => receipt(JSON.parse(request.body).requestId, "unknown"));
    await f.execution.cancel({ requestId: cancelId, fenceIfNotAdmitted: { sessionId, startDigest: start.bodyHash } });
    await f.execution.respond(response());
    const cancel = pending(f.state).find(request => request.operation === "runs.cancel")!;
    const proof = snapshot({ stopConfirmed: true, state: "cancelled", phase: "terminal" });
    const commit = f.persistence.save.getMockImplementation()!;
    f.persistence.save.mockRejectedValueOnce(new Error("Stop proof write failed"));
    await expect(f.execution.settleStopped(proof)).rejects.toThrow("Stop proof write failed");
    expect(pending(f.state)).toHaveLength(3);
    f.persistence.save.mockImplementation(commit);
    await f.execution.settleStopped(proof);
    expect(pending(f.state).map(request => request.operation)).toEqual(["runs.respond"]);
    expect(Object.values(f.state.settledMutations ?? {}).map(value => value.request)).toEqual([start, cancel]);
    expect(Object.values(f.durable().settledMutations ?? {})[0]!.proof).toMatchObject({ ref: { provider, id: runId }, generation });
    expect(f.state.cursor).toBeUndefined();
  });

  it("retains original bounded admission context before acknowledging a reserved continuation", async () => {
    const original = { ...input(), limits: { maxDurationMs: 60000 }, resources: [{ kind: "workspace", id: "w", revision: "2" }] };
    const f = fixture();
    await f.execution.start(runId, original);
    const reservedId = "20000000-0000-4000-8000-000000000002";
    f.client.execute.mockResolvedValueOnce({ ...receipt(responseId, "applied"), continuation: { run: { provider, id: reservedId }, state: "awaiting_authorization" } });
    await f.execution.respond(response());
    const retained = Object.values(f.durable().continuations ?? {});
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ sourceRunId: runId, requestId: responseId, run: { provider, id: reservedId }, input: original,
      decisionId: "approval", response: { kind: "approval", decision: "allow" } });
    expect(retained[0]!.deadline).toBe(f.state.lastRunInput!.deadline);
    expect(pending(f.durable())).toEqual([]);
    expect(f.persistence.observe).not.toHaveBeenCalled();
  });

  it("retries a native Node timeout from the same committed run", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3" });
    f.watch.push({ kind: "snapshot", snapshot: snapshot() });
    f.persistence.observe.mockRejectedValueOnce(new DOMException("Deadline reached", "TimeoutError"));
    await f.execution.observe();
    expect(f.client.watchRun).toHaveBeenCalledTimes(2);
    expect(f.client.execute).not.toHaveBeenCalled();
  });
  it("reopens observation from the committed cursor after a temporary projection failure without a new execution", async () => {
    const before = snapshot({ revision: "2", lastSequence: "2", cursor: "committed-2" });
    const f = fixture({ runId, run: before, cursor: before.cursor });
    f.watch.push({ kind: "snapshot", snapshot: snapshot() });
    f.persistence.observe.mockRejectedValueOnce(new Error("Temporary projection unavailable"));
    await f.execution.observe();
    expect(f.client.watchRun).toHaveBeenCalledTimes(2);
    expect(f.client.watchRun.mock.calls.map(call => call[1]?.cursor)).toEqual(["committed-2", "committed-2"]);
    expect(f.state.cursor).toBe("cursor-3");
    expect(f.client.execute).not.toHaveBeenCalled();
  });

  it("surfaces sealed storage and cancels transient recovery backoff immediately on detach", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3" });
    f.watch.push({ kind: "snapshot", snapshot: snapshot() });
    f.persistence.observe.mockRejectedValue(Object.assign(new Error("Sealed source"), { code: "session_storage_corrupt" }));
    await expect(f.execution.observe()).rejects.toThrow("Sealed source");
    expect(f.client.watchRun).toHaveBeenCalledOnce();
    f.client.watchRun.mockClear();
    f.persistence.observe.mockRejectedValue(new Error("Transient failure"));
    const observing = f.execution.observe();
    await vi.waitFor(() => expect(f.client.watchRun).toHaveBeenCalledOnce());
    f.execution.detach();
    await observing;
    expect(f.client.watchRun).toHaveBeenCalledOnce();
    expect(f.client.execute).not.toHaveBeenCalled();
  });

  it("exhausts a bounded projection recovery without changing the committed watermark", async () => {
    const f = fixture({ runId, run: snapshot(), cursor: "cursor-3" });
    f.watch.push({ kind: "snapshot", snapshot: snapshot() });
    f.persistence.observe.mockRejectedValue(new Error("Projection remains unavailable"));
    await expect(f.execution.observe()).rejects.toThrow("Projection remains unavailable");
    expect(f.client.watchRun).toHaveBeenCalledTimes(4);
    expect(f.state.cursor).toBe("cursor-3");
    expect(f.client.execute).not.toHaveBeenCalled();
  });

  it("settles a retained accepted response only after its final matching control event commits", async () => {
    const f = fixture({ runId, run: snapshot() });
    f.client.execute.mockResolvedValueOnce(receipt(responseId, "accepted"));
    await f.execution.respond(response());
    const final = receipt(responseId, "applied");
    f.watch.push({ kind: "event", cursor: "cursor-4", event: { schemaVersion: "agent-event.1", runId, generation,
      sequence: "4", revision: "4", type: "control.updated", source: { agentId: "root" }, occurredAt: snapshot().observedAt,
      data: { requestId: responseId, receipt: final } } });
    const committed = deferred<void>(), released = deferred<void>(), observe = f.persistence.observe.getMockImplementation()!;
    f.persistence.observe.mockImplementationOnce(async (item, next) => { committed.resolve(); await released.promise; await observe(item, next); });
    const observing = f.execution.observe();
    await committed.promise;
    expect(pending(f.state)).toHaveLength(1);
    released.resolve(); await observing;
    expect(pending(f.durable())).toEqual([]);
    expect(f.client.execute).toHaveBeenCalledOnce();
  });
});
