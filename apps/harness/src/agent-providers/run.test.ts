import { describe, expect, it, vi } from "vitest";
import type { AgentControlReceipt, AgentPreparedRequest, AgentRunInput, AgentRunSnapshot, AgentSession, AgentWatchItem } from "@hosty-sdk/app/agent";
import type { AgentClient } from "@hosty-sdk/app/agent/client";
import { prepareAgentCancel, prepareAgentRun } from "@hosty-sdk/app/agent/client";
import type { ProviderExecutionState } from "./execution.js";
import { ProviderHarnessRun, type ProviderRunContext } from "./run.js";

const provider = { appId: "third.party.provider", installationId: "installation", key: "agent" };
const generation = "00000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000001";
const session: AgentSession = { ref: { provider, id: sessionId }, revision: "5", configurationRevision: "2", configurationDigest: "a".repeat(64),
  nativeState: "available", activeRun: null, resolvedSkills: [], configuration: { connection: { id: "account", revision: "1" } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture() {
  const state: ProviderExecutionState = { version: 1, selection: { provider, connection: { id: "account", revision: "1" } }, sessionId, session };
  let currentRevision = "7", decisionRevision = "2";
  const snapshot = (runId = state.runId!): AgentRunSnapshot => ({ ref: { provider, id: runId }, sessionId, generation,
    revision: currentRevision, state: "waiting_for_input", phase: "waiting", stopConfirmed: false, freshness: "current", observedAt: "2026-11-12T12:00:00Z",
    configurationRevision: "2", lastSequence: currentRevision, cursor: `cursor-${currentRevision}`, pending: [
      { id: "approval", revision: decisionRevision, kind: "approval", delivery: "continue_run", source: { agentId: "root" }, toolName: "Edit" },
    ], effects: { certainty: "known", unresolvedCallIds: [] } });
  const client = {
    capabilities: vi.fn(async () => ({ version: 2 as const, eventVersions: ["agent-event.1"], capabilities: ["runs.live-configure"],
      limits: { maxCommandBytes: 1048576, maxEventBytes: 1048576, maxSnapshotBytes: 1048576, maxReplayBytes: 1048576,
        replayRetentionMs: 1000, maxControls: 10, maxPageSize: 10 }, configuration: { resumeCompatible: [] } })),
    session: vi.fn(async () => session),
    execute: vi.fn(async (request: AgentPreparedRequest): Promise<unknown> => {
      if (request.operation === "runs.start") return snapshot(request.runId);
      return { requestId: JSON.parse(request.body).requestId, state: "applied", run: { provider, id: state.runId! }, revision: "8", generation } satisfies AgentControlReceipt;
    }),
    run: vi.fn(async (runId?: string) => snapshot(runId)),
    control: vi.fn(async (_runId: string, requestId: string): Promise<AgentControlReceipt> => ({ requestId, state: "applied",
      run: { provider, id: state.runId! }, revision: "8", generation })),
    watchRun: vi.fn(async function* (): AsyncGenerator<AgentWatchItem> { /* No native/provider side effects in a consumer fixture. */ }),
  };
  const saved: ProviderExecutionState[] = [];
  const context: ProviderRunContext = {
    client: client as unknown as AgentClient, state,
    configuration: { connection: { id: "account", revision: "1" } },
    persistence: { save: async next => { saved.push(structuredClone(next)); }, observe: async (_item, next) => { saved.push(structuredClone(next)); } },
    input: async text => ({ input: { text } }), unavailable: vi.fn(async () => {}),
  };
  return { context, state, client, saved, snapshot, advance: () => { currentRevision = "80"; decisionRevision = "3"; } };
}
const options = () => ({ sessionId: "harness-conversation", cwd: "/unused-consumer-path", onEvent: vi.fn() });

describe("consumer provider run handle", () => {
  it("does not prepare a prediction control for an already stopped execution", async () => {
    const f = fixture(), runId = "20000000-0000-4000-8000-000000000001";
    f.state.runId = runId; f.state.run = { ...f.snapshot(runId), state: "succeeded", phase: "terminal", stopConfirmed: true, pending: [] };
    f.client.run.mockResolvedValue(f.state.run);
    const run = new ProviderHarnessRun(async () => f.context, options()); await run.attach();
    await run.disableSuggestions(); await run.finishSuggestions();
    expect(f.client.execute).not.toHaveBeenCalled(); expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    await run.detach();
  });

  it("coalesces prediction disable and reads its retained exact control after the revision advances", async () => {
    const f = fixture(), run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Work"); await run.waitForAdmission(); f.client.execute.mockClear();
    f.client.execute.mockImplementationOnce(async request => ({ requestId: JSON.parse(request.body).requestId, state: "accepted",
      run: { provider, id: f.state.runId! }, revision: "8", generation } satisfies AgentControlReceipt));
    await Promise.all([run.disableSuggestions(), run.finishSuggestions()]);
    expect(f.client.execute).toHaveBeenCalledOnce();
    const original = f.client.execute.mock.calls[0]![0];
    expect(JSON.parse(original.body)).toMatchObject({ command: "predictions", enabled: false, expectedRevision: "7" });
    f.advance(); await run.disableSuggestions();
    expect(f.client.control).toHaveBeenCalledExactlyOnceWith(f.state.runId, JSON.parse(original.body).requestId);
    expect(f.client.execute).toHaveBeenCalledOnce(); expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    expect(f.saved.some(saved => Object.values(saved.mutations ?? {}).some(request => request.bodyHash === original.bodyHash && request.body === original.body))).toBe(true);
    await run.detach();
  });

  it("does not replay a restored start while a retained cancellation remains unknown", async () => {
    const f = fixture(), runId = "20000000-0000-4000-8000-000000000001", requestId = "30000000-0000-4000-8000-000000000001";
    const start = prepareAgentRun(sessionId, runId, { expectedSessionRevision: session.revision, configurationRevision: session.configurationRevision, continuation: "resume", input: { text: "Original input" } });
    const cancel = prepareAgentCancel(runId, { requestId, fenceIfNotAdmitted: { sessionId, startDigest: start.bodyHash } });
    f.state.runId = runId;
    f.state.mutations = Object.fromEntries([start, cancel].map(request => [`${request.method}:${request.path}:${request.bodyHash}`, request]));
    f.client.control.mockResolvedValue({ requestId, state: "unknown", run: { provider, id: runId }, revision: "8", generation });
    const restored = new ProviderHarnessRun(async () => f.context, options());
    await expect(restored.attach()).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.client.watchRun).not.toHaveBeenCalled();
    expect(Object.values(f.state.mutations)).toEqual([start, cancel]);
    await restored.detach();
  });

  it("detaches immediately while admission is pending without cancelling it or opening observation later", async () => {
    const f = fixture(), loading = deferred<ProviderRunContext>();
    const load = vi.fn(() => loading.promise), run = new ProviderHarnessRun(load, options());
    run.send("Keep executing independently");
    await run.detach();
    expect(f.client.execute).not.toHaveBeenCalled();
    loading.resolve(f.context);
    await run.waitForAdmission();
    await Promise.resolve();

    expect(f.client.execute).toHaveBeenCalledOnce();
    const prepared = f.client.execute.mock.calls[0]![0];
    expect(prepared.operation).toBe("runs.start");
    expect(JSON.parse(prepared.body)).toMatchObject({ expectedSessionRevision: "5", configurationRevision: "2", continuation: "resume" });
    expect(f.client.watchRun).not.toHaveBeenCalled();
    expect(f.context.unavailable).not.toHaveBeenCalled();
    expect(() => run.send("Do not create another execution")).toThrow();
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps an unknown admission fenced instead of assigning a new run ID on another send", async () => {
    const f = fixture(), run = new ProviderHarnessRun(async () => f.context, options());
    f.client.execute.mockRejectedValueOnce(new Error("Start response lost"));
    run.send("One mutation only");
    await expect(run.waitForAdmission()).rejects.toThrow("Start response lost");
    await vi.waitFor(() => expect(f.context.unavailable).toHaveBeenCalledOnce());
    const retained = Object.values(f.state.mutations ?? {});
    expect(retained).toHaveLength(1);
    expect(retained[0]!.runId).toBe(f.state.runId);
    expect(() => run.send("Accidental duplicate")).toThrow();
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(f.client.watchRun).not.toHaveBeenCalled();
    await run.detach();
  });

  it("retries an unknown approval exactly and rejects changing its decision while delivery is unresolved", async () => {
    const f = fixture(), run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Work");
    await run.waitForAdmission();
    await vi.waitFor(() => expect(f.client.watchRun).toHaveBeenCalledOnce());
    f.client.execute.mockClear();
    f.client.execute.mockImplementationOnce(async request => ({ requestId: JSON.parse(request.body).requestId, state: "unknown",
      run: { provider, id: f.state.runId! }, revision: "8", generation } satisfies AgentControlReceipt));
    await expect(run.resolveApproval("approval", "allow")).rejects.toMatchObject({ code: "control_unknown" });
    const prepared = f.client.execute.mock.calls[0]![0];
    expect(JSON.parse(prepared.body)).toMatchObject({ expectedRevision: "7", decisionRevision: "2", response: { decision: "allow" } });
    const reads = f.client.run.mock.calls.length;
    f.advance();

    await expect(run.resolveApproval("approval", "deny")).rejects.toMatchObject({ code: "control_unknown" });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(await run.resolveApproval("approval", "allow")).toBe(true);
    expect(f.client.execute.mock.calls[1]![0]).toEqual(prepared);
    expect(f.client.run).toHaveBeenCalledTimes(reads);
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    await run.detach();
  });

  it("configures changed approval/prediction policy before preparing the next pinned turn", async () => {
    const f = fixture(), run = new ProviderHarnessRun(async () => f.context, { ...options(), autonomy: "autonomous", promptSuggestions: true });
    f.client.execute.mockImplementation(async request => {
      if (request.operation === "sessions.configure") return { ...session, revision: "6", configurationRevision: "3", configurationDigest: "b".repeat(64), configuration: JSON.parse(request.body).configuration };
      return f.snapshot(request.runId);
    });
    run.send("Use the requested policy");
    await run.waitForAdmission();
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["sessions.configure", "runs.start"]);
    const configuration = JSON.parse(f.client.execute.mock.calls[0]![0].body);
    expect(configuration).toMatchObject({ expectedSessionRevision: "5", configuration: { connection: { id: "account", revision: "1" }, approvalMode: "autonomous", predictions: { enabled: true } } });
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body)).toMatchObject({ expectedSessionRevision: "6", configurationRevision: "3" });
    await run.detach();
  });

  it("does not mutate an unchanged configuration because object keys moved or the provider omitted its echoed value", async () => {
    const f = fixture();
    f.client.session.mockResolvedValueOnce({ ...session, configuration: { connection: { revision: "1", id: "account" } } });
    let run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Unchanged configuration");
    await run.waitForAdmission();
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start"]);
    await run.detach();

    const cached = fixture();
    cached.state.appliedConfiguration = { revision: session.configurationRevision, digest: session.configurationDigest, value: cached.context.configuration };
    cached.client.session.mockResolvedValueOnce({ ...session, configuration: undefined });
    run = new ProviderHarnessRun(async () => cached.context, options());
    run.send("Use the acknowledged revision");
    await run.waitForAdmission();
    expect(cached.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start"]);
    await run.detach();
  });

  it("reconciles an uncertain configuration without rebasing its UUID or CAS before another run", async () => {
    const f = fixture();
    f.context.configuration = { ...f.context.configuration, approvalMode: "autonomous" };
    f.client.execute.mockRejectedValueOnce(new Error("Configuration response lost"));
    const first = new ProviderHarnessRun(async () => f.context, options());
    first.send("Original turn");
    await expect(first.waitForAdmission()).rejects.toThrow("Configuration response lost");
    await first.detach();
    const original = f.client.execute.mock.calls[0]![0];
    f.client.session.mockResolvedValueOnce({ ...session, revision: "90" });
    f.client.execute.mockImplementation(async request => request.operation === "sessions.configure"
      ? { ...session, revision: "6", configurationRevision: "3", configuration: JSON.parse(request.body).configuration }
      : f.snapshot(request.runId));
    const recovered = new ProviderHarnessRun(async () => f.context, options());
    recovered.send("Explicit continuation");
    await recovered.waitForAdmission();
    expect(f.client.execute.mock.calls[1]![0]).toEqual(original);
    expect(JSON.parse(original.body).expectedSessionRevision).toBe("5");
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["sessions.configure", "sessions.configure", "runs.start"]);
    await recovered.detach();
  });

  it("can cancel after admission while the manager projection callback is blocked", async () => {
    const f = fixture(), blocked = deferred<void>(), entered = deferred<void>();
    let projectionFinished = false;
    f.context.persistence.observe = vi.fn(async () => { entered.resolve(); await blocked.promise; projectionFinished = true; });
    f.client.watchRun.mockImplementation(async function* () { yield { kind: "snapshot", snapshot: f.snapshot() }; });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Independent admission");
    await run.waitForAdmission();
    await entered.promise;
    f.client.run.mockResolvedValueOnce(f.snapshot()).mockResolvedValueOnce({ ...f.snapshot(), state: "cancelled", phase: "terminal", stopConfirmed: true, pending: [] });
    await run.stopAndWait();
    expect(projectionFinished).toBe(false);
    expect(run.stopProof).toMatchObject({ stopConfirmed: true, state: "cancelled" });
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.cancel"]);
    await run.detach();
    blocked.resolve();
    await Promise.resolve();
  });

  it("does not project inside MCP, prediction or approval control reads", async () => {
    const f = fixture(), observe = vi.fn(async () => {});
    f.context.persistence.observe = observe;
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Controls use current public metadata");
    await run.waitForAdmission();
    await run.configureMcp({ targets: [] });
    await run.disableSuggestions();
    await run.resolveApproval("approval", "allow");
    expect(observe).not.toHaveBeenCalled();
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.control", "runs.control", "runs.respond"]);
    await run.detach();
  });

  it("does not open a restored run observer if detach wins while its context loads", async () => {
    const f = fixture(), loading = deferred<ProviderRunContext>();
    f.state.runId = "20000000-0000-4000-8000-000000000001";
    const run = new ProviderHarnessRun(() => loading.promise, options());
    const attaching = run.attach();
    await run.detach();
    loading.resolve(f.context);
    await attaching;
    expect(f.client.watchRun).not.toHaveBeenCalled();
    expect(f.client.execute).not.toHaveBeenCalled();
  });

  it("does not replace a retained unknown configuration with a newly requested policy", async () => {
    const f = fixture();
    f.context.configuration = { ...f.context.configuration, approvalMode: "autonomous" };
    f.client.execute.mockRejectedValueOnce(new Error("Configuration response lost"));
    const first = new ProviderHarnessRun(async () => f.context, options());
    first.send("Original policy");
    await expect(first.waitForAdmission()).rejects.toThrow("Configuration response lost");
    await first.detach();
    const original = Object.values(f.state.mutations ?? {})[0];
    f.context.configuration = { ...f.context.configuration, approvalMode: "normal" };
    const changed = new ProviderHarnessRun(async () => f.context, options());
    changed.send("Changed policy");
    await expect(changed.waitForAdmission()).rejects.toMatchObject({ code: "configuration_unknown" });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(Object.values(f.state.mutations ?? {})).toEqual([original]);
    await changed.detach();
  });

  it("admits a next-turn answer under its reserved UUID and original bounded context without rebuilding user input", async () => {
    const f = continuationFixture(), run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question");
    await run.waitForAdmission();
    const original = JSON.parse(f.client.execute.mock.calls[0]![0].body);
    await expect(run.resolveQuestion("question", { answer: "Yes" })).resolves.toBe(true);
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.respond", "runs.start"]);
    const resumed = f.client.execute.mock.calls[2]![0], input = JSON.parse(resumed.body);
    expect(resumed.runId).toBe(f.reservedId);
    expect(input).toMatchObject({ expectedSessionRevision: "5", configurationRevision: "2", continuation: "resume",
      input: { decisionResponseRef: { runId: f.sourceId(), requestId: f.response()!.requestId } }, resources: original.resources,
      mcp: original.mcp, selection: original.selection, context: original.context, limits: { maxToolCalls: 4, maxOutputTokens: 200 } });
    expect(input.input).not.toHaveProperty("text");
    expect(input.limits.maxDurationMs).toBeLessThanOrEqual(original.limits.maxDurationMs);
    expect(resumed.ceiling?.deadline).toBe(f.saved.find(state => state.lastRunInput?.runId === f.sourceId())!.lastRunInput!.deadline);
    expect(f.context.input).toHaveBeenCalledOnce();
    expect(Object.values(f.state.continuations ?? {})[0]!.state).toBe("admitted");
    await run.detach();
  });

  it("retries an uncertain reserved start with its exact identity, old CAS and remaining budget", async () => {
    const f = continuationFixture(), execute = f.client.execute.getMockImplementation()!;
    f.context.refreshResources = vi.fn(async (resources: AgentRunInput["resources"]) => resources!.map(value => ({ ...value, revision: "9" })));
    let lost = true;
    f.client.execute.mockImplementation(async request => {
      if (request.operation === "runs.start" && request.runId === f.reservedId && lost) { lost = false; throw new Error("Reserved admission response lost"); }
      return execute(request);
    });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    await expect(run.resolveQuestion("question", { answer: "Yes" })).rejects.toThrow("Reserved admission response lost");
    const original = f.client.execute.mock.calls[2]![0];
    f.client.session.mockResolvedValueOnce({ ...session, revision: "90" });
    await expect(run.resolveQuestion("question", { answer: "Different" })).rejects.toMatchObject({ code: "control_unknown" });
    await expect(run.resolveQuestion("question", { answer: "Yes" })).resolves.toBe(true);
    expect(f.client.execute.mock.calls[3]![0]).toEqual(original);
    expect(JSON.parse(original.body).resources).toEqual([{ kind: "workspace", id: "original", revision: "9" }]);
    expect(f.context.refreshResources).toHaveBeenCalledOnce();
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    expect(f.state.runId).toBe(f.reservedId);
    expect(f.context.input).toHaveBeenCalledOnce();
    await run.detach();
  });

  it("refreshes only source revisions before an unprepared reserved continuation without rebuilding its input", async () => {
    const f = continuationFixture();
    f.context.refreshResources = vi.fn(async (resources: AgentRunInput["resources"]) => {
      expect(resources).toEqual([{ kind: "workspace", id: "original", revision: "1" }]);
      return resources!.map(value => ({ ...value, revision: "9" }));
    });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    const original = f.client.execute.mock.calls[0]![0];
    await expect(run.resolveQuestion("question", { answer: "Yes" })).resolves.toBe(true);
    expect(JSON.parse(f.client.execute.mock.calls[2]![0].body).resources).toEqual([{ kind: "workspace", id: "original", revision: "9" }]);
    expect(JSON.parse(original.body).resources).toEqual([{ kind: "workspace", id: "original", revision: "1" }]);
    expect(f.context.input).toHaveBeenCalledOnce(); expect(f.context.refreshResources).toHaveBeenCalledOnce();
    await run.detach();
  });

  it("retains the original continuation CWD order when fresh workspace metadata arrives in reverse order", async () => {
    const f = continuationFixture(), input = f.context.input;
    f.context.input = vi.fn(async text => ({ ...await input(text), resources: [
      { kind: "worktree", id: "first", revision: "1" }, { kind: "worktree", id: "second", revision: "2" },
    ] }));
    f.context.refreshResources = vi.fn(async (resources: AgentRunInput["resources"]) => resources!.map(value => ({ ...value, revision: "9" })).reverse());
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    await run.resolveQuestion("question", { answer: "Yes" });
    expect(JSON.parse(f.client.execute.mock.calls[2]![0].body).resources).toEqual([
      { kind: "worktree", id: "first", revision: "9" }, { kind: "worktree", id: "second", revision: "9" },
    ]);
    await run.detach();
  });

  it("rejects a refreshed continuation that adds or substitutes a different worktree", async () => {
    const f = continuationFixture();
    f.context.refreshResources = vi.fn(async () => [{ kind: "workspace", id: "foreign", revision: "9" }]);
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    await expect(run.resolveQuestion("question", { answer: "Yes" })).rejects.toMatchObject({ code: "continuation_resources_changed" });
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.respond"]);
    expect(f.state.runId).toBe(f.sourceId());
    await run.detach();
  });

  it("discovers an offline next-turn answer from an authoritative snapshot after consumer restart", async () => {
    const f = continuationFixture(), initial = new ProviderHarnessRun(async () => f.context, options());
    initial.send("Original question"); await initial.waitForAdmission(); await initial.detach();
    const response = { requestId: "40000000-0000-4000-8000-000000000001", state: "applied", run: { provider, id: f.sourceId() }, revision: "8", generation,
      continuation: { run: { provider, id: f.reservedId }, state: "awaiting_authorization" } } satisfies AgentControlReceipt;
    f.client.control.mockResolvedValue(response);
    f.client.watchRun.mockImplementation(async function* (runId?: string) {
      if (runId === f.reservedId) return;
      yield { kind: "snapshot", snapshot: { ...f.original(), pendingContinuations: [{ requestId: response.requestId, ...response.continuation! }] } };
    });
    const restored = new ProviderHarnessRun(async () => f.context, options());
    await restored.attach();
    await vi.waitFor(() => expect(f.state.runId).toBe(f.reservedId));
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.start"]);
    const input = JSON.parse(f.client.execute.mock.calls[1]![0].body);
    expect(input.input).toEqual({ decisionResponseRef: { runId: f.sourceId(), requestId: response.requestId } });
    expect(f.client.control).toHaveBeenCalledWith(f.sourceId(), response.requestId);
    expect(f.context.input).toHaveBeenCalledOnce();
    await restored.detach();
  });

  it("rejects a reserved continuation when the original provider configuration changed", async () => {
    const f = continuationFixture(), run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    f.client.session.mockResolvedValueOnce({ ...session, configurationRevision: "3" });
    await expect(run.resolveQuestion("question", { answer: "Yes" })).rejects.toMatchObject({ code: "continuation_configuration_changed" });
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.respond"]);
    expect(Object.values(f.state.continuations ?? {})[0]!.state).toBe("awaiting_authorization");
    await run.detach();
  });

  it("requires proof that a reserved continuation was superseded even when its source already stopped", async () => {
    const f = continuationFixture(), run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    // Deny new execution admission while retaining its provider-owned reservation.
    f.client.session.mockResolvedValueOnce({ ...session, configurationRevision: "3" });
    await expect(run.resolveQuestion("question", { answer: "Yes" })).rejects.toMatchObject({ code: "continuation_configuration_changed" });
    await expect(run.stopAndWait()).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(run.stopProof).toBeNull();
    expect(Object.values(f.state.continuations ?? {})[0]!.state).toBe("awaiting_authorization");
    const receipt = { ...f.response()!, continuation: { run: { provider, id: f.reservedId }, state: "superseded" as const } };
    f.client.control.mockImplementation(async (_runId, requestId) => requestId === receipt.requestId ? receipt
      : { requestId, state: "applied", run: { provider, id: f.sourceId() }, revision: "9", generation });
    await run.stopAndWait();
    expect(run.stopProof?.ref.id).toBe(f.sourceId());
    expect(Object.values(f.state.continuations ?? {})[0]!.state).toBe("superseded");
    expect(f.client.execute.mock.calls.filter(([request]) => request.operation === "runs.start")).toHaveLength(1);
    await run.detach();
  });

  it("prevents a pending continuation authorization from starting after Stop was requested", async () => {
    const f = continuationFixture(), control = deferred<AgentControlReceipt>(), entered = deferred<void>();
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original question"); await run.waitForAdmission();
    f.client.control.mockImplementationOnce(async () => { entered.resolve(); return control.promise; });
    const answering = run.resolveQuestion("question", { answer: "Yes" });
    await entered.promise;
    const stopping = run.stopAndWait();
    const response = f.response()!;
    f.client.control.mockResolvedValue({ ...response, continuation: { run: { provider, id: f.reservedId }, state: "superseded" } });
    control.resolve(response);
    await answering; await stopping;
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.respond", "runs.cancel"]);
    expect(run.stopProof).toMatchObject({ ref: { id: f.sourceId() }, stopConfirmed: true });
    expect(Object.values(f.state.continuations ?? {})[0]!.state).toBe("superseded");
    await run.detach();
  });

  it("settles a lost start by its exact cancellation fence before allowing another ordinary turn", async () => {
    const f = fixture(), run = new ProviderHarnessRun(async () => f.context, options());
    f.client.execute.mockRejectedValueOnce(new Error("Start response lost"));
    run.send("One uncertain admission");
    await expect(run.waitForAdmission()).rejects.toThrow("Start response lost");
    const original = f.client.execute.mock.calls[0]![0];
    const proof = { ...f.snapshot(), state: "cancelled" as const, phase: "terminal" as const, stopConfirmed: true, pending: [] };
    f.client.run.mockRejectedValueOnce(new Error("Run has not been admitted")).mockResolvedValue(proof);
    await run.stopAndWait();
    const cancelled = f.client.execute.mock.calls[1]![0];
    expect(JSON.parse(cancelled.body)).toMatchObject({ fenceIfNotAdmitted: { sessionId, startDigest: original.bodyHash } });
    expect(run.stopProof).toMatchObject({ ref: { id: original.runId }, stopConfirmed: true });
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    expect(Object.values(f.state.settledMutations ?? {}).map(value => value.request)).toEqual([original]);
    run.send("New explicit ordinary turn"); await run.waitForAdmission();
    expect(f.client.execute.mock.calls[2]![0].runId).not.toBe(original.runId);
    await run.detach();
  });

  it("looks up an accepted response receipt before a new turn instead of redispatching its decision", async () => {
    const f = fixture(), first = new ProviderHarnessRun(async () => f.context, options());
    first.send("Original approval"); await first.waitForAdmission();
    f.client.execute.mockImplementationOnce(async request => ({ requestId: JSON.parse(request.body).requestId, state: "accepted",
      run: { provider, id: f.state.runId! }, revision: "8", generation }));
    await expect(first.resolveApproval("approval", "allow")).resolves.toBe(true);
    const prepared = Object.values(f.state.mutations ?? {})[0]!;
    await first.detach();
    const oldId = f.state.runId!;
    f.client.run.mockResolvedValue({ ...f.snapshot(oldId), state: "succeeded", phase: "terminal", stopConfirmed: true, pending: [] });
    const restored = new ProviderHarnessRun(async () => f.context, options());
    restored.send("New explicit input"); await restored.waitForAdmission();
    expect(f.client.control).toHaveBeenCalledWith(oldId, JSON.parse(prepared.body).requestId);
    expect(f.client.execute.mock.calls.map(([request]) => request.operation)).toEqual(["runs.start", "runs.respond", "runs.start"]);
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    await restored.detach();
  });

  it("applies same/subset interface policy changes with the declared proxy policy control", async () => {
    const f = fixture(), observe = vi.fn(async () => {});
    f.context.persistence.observe = observe;
    f.client.capabilities.mockResolvedValue({ ...await f.client.capabilities(), capabilities: ["mcp.policy-update"] });
    const app = { kind: "app" as const, appId: "arbitrary.app", installationId: "installation", key: "tools" };
    f.context.input = async text => ({ input: { text }, mcp: { targets: [{ target: { kind: "core" } }, { target: app }] } });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Admitted interfaces"); await run.waitForAdmission();
    await run.configureMcp({ targets: [{ target: app, tools: ["read"], policy: { default: "ask", tools: { write: { mode: "disabled" } } } }] });
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body)).toMatchObject({ command: "mcpPolicy", expectedRevision: "7",
      mcp: { targets: [{ target: app, tools: ["read"], policy: { default: "ask" } }] } });
    expect(observe).not.toHaveBeenCalled();
    await run.detach();
  });

  it("requires full live configuration for added or changed interface identities", async () => {
    const f = fixture(), declared = await f.client.capabilities();
    f.client.capabilities.mockResolvedValue({ ...declared, capabilities: ["mcp.policy-update"] });
    f.context.input = async text => ({ input: { text }, mcp: { targets: [{ target: { kind: "core" } }] } });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original selection"); await run.waitForAdmission();
    const mcp = { targets: [{ target: { kind: "app" as const, appId: "another.app", installationId: "new-installation", key: "unrelated" } }] };
    await expect(run.configureMcp(mcp)).rejects.toMatchObject({ code: "unsupported_control" });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    f.client.capabilities.mockResolvedValue({ ...declared, capabilities: ["mcp.policy-update", "runs.live-configure"] });
    await run.configureMcp(mcp);
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body)).toMatchObject({ command: "liveConfigure", mcp });
    await run.detach();
  });

  it("compares external connection revisions exactly before selecting an in-place policy control", async () => {
    const f = fixture();
    f.client.capabilities.mockResolvedValue({ ...await f.client.capabilities(), capabilities: ["mcp.policy-update"] });
    f.context.input = async text => ({ input: { text }, mcp: { connections: [{ id: "opaque-handle", revision: "9007199254740994" }] } });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Pinned external handle"); await run.waitForAdmission();
    await run.configureMcp({ connections: [{ id: "opaque-handle", revision: "9007199254740994" }] });
    expect(JSON.parse(f.client.execute.mock.calls[1]![0].body).command).toBe("mcpPolicy");
    await expect(run.configureMcp({ connections: [{ id: "opaque-handle", revision: "9007199254740995" }] })).rejects.toMatchObject({ code: "unsupported_control" });
    expect(f.client.execute).toHaveBeenCalledTimes(2);
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    await run.detach();
  });

  it("retries an unknown MCP policy command with the same UUID/body/CAS while rejecting a changed policy", async () => {
    const f = fixture();
    f.client.capabilities.mockResolvedValue({ ...await f.client.capabilities(), capabilities: ["mcp.policy-update"] });
    f.context.input = async text => ({ input: { text }, mcp: { targets: [{ target: { kind: "core" } }] } });
    const run = new ProviderHarnessRun(async () => f.context, options());
    run.send("Original admitted targets"); await run.waitForAdmission();
    f.client.execute.mockImplementationOnce(async request => ({ requestId: JSON.parse(request.body).requestId, state: "unknown",
      run: { provider, id: f.state.runId! }, revision: "8", generation } satisfies AgentControlReceipt));
    const mcp = { targets: [{ target: { kind: "core" as const }, policy: { default: "ask" as const } }] };
    await expect(run.configureMcp(mcp)).rejects.toMatchObject({ code: "control_unknown" });
    const original = f.client.execute.mock.calls[1]![0], reads = f.client.run.mock.calls.length;
    f.advance();
    await expect(run.configureMcp({ targets: [{ target: { kind: "core" }, policy: { default: "run" } }] })).rejects.toMatchObject({ code: "control_unknown" });
    await run.configureMcp(mcp);
    expect(f.client.execute.mock.calls[2]![0]).toEqual(original);
    expect(JSON.parse(original.body)).toMatchObject({ expectedRevision: "7", command: "mcpPolicy" });
    expect(f.client.run).toHaveBeenCalledTimes(reads);
    expect(Object.values(f.state.mutations ?? {})).toEqual([]);
    await run.detach();
  });
});

function continuationFixture() {
  const f = fixture(), reservedId = "20000000-0000-4000-8000-000000000099";
  let sourceId = "", response: AgentControlReceipt | undefined;
  const original = (): AgentRunSnapshot => ({ ...f.snapshot(sourceId), stopConfirmed: true, phase: "terminal",
    pending: [{ id: "question", revision: "2", kind: "question", delivery: "next_turn", questions: [{ id: "answer", text: "Continue?", allowText: true }] }] });
  f.context.input = vi.fn(async (text: string) => ({ input: { text }, resources: [{ kind: "workspace", id: "original", revision: "1" }],
    mcp: { targets: [{ target: { kind: "core" as const } }] }, selection: { model: "original-model", reasoningEffort: null },
    context: [{ id: "fixed", text: "Original context" }], limits: { maxDurationMs: 600000, maxOutputTokens: 200, maxToolCalls: 4 } }));
  f.client.execute.mockImplementation(async request => {
    if (request.operation === "runs.respond") {
      response = { requestId: JSON.parse(request.body).requestId, state: "applied", run: { provider, id: sourceId }, revision: "8", generation,
        continuation: { run: { provider, id: reservedId }, state: "awaiting_authorization" } };
      return response;
    }
    if (request.operation === "runs.start") {
      if (request.runId !== reservedId) { sourceId = request.runId!; return original(); }
      expect(Object.values(f.saved.at(-1)!.continuations ?? {})[0]).toMatchObject({ run: { provider, id: reservedId }, state: "awaiting_authorization" });
      return { ...f.snapshot(reservedId), pending: [], state: "running", phase: "executing", stopConfirmed: false };
    }
    return { requestId: JSON.parse(request.body).requestId, state: "applied", run: { provider, id: sourceId }, revision: "9", generation };
  });
  f.client.run.mockImplementation(async runId => runId === reservedId
    ? { ...f.snapshot(reservedId), pending: [], state: "running", phase: "executing", stopConfirmed: false } : original());
  f.client.control.mockImplementation(async () => response!);
  return { ...f, reservedId, original, sourceId: () => sourceId, response: () => response };
}
