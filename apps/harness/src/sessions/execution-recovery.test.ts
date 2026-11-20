import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";
import { DevelopmentClient } from "./development.js";
import { AgentSessionService } from "../agent-sessions/service.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(development?: DevelopmentClient, installationHistory = false) {
  const fixture = await publicProviderFixture(installationHistory); fixtures.push(fixture);
  const f = development ? { ...fixture, ...fixture.makeManager({ development }) } : fixture;
  const session = await f.manager.createSession({ createdBy: f.owner });
  const original = randomUUID();
  await f.manager.postMessage(session.id, "Original immutable input", f.credential, [], { actorUserId: f.owner, clientRequestId: original });
  const runId = f.starts[0]!.runId;
  return { ...f, session, original, runId, async interrupt() {
    f.update(runId, { state: "unknown", phase: "interrupted", stopConfirmed: false, freshness: "last_known",
      effects: { certainty: "unknown", unresolvedCallIds: ["command"] } });
    await vi.waitFor(async () => expect((await f.store.readProviderExecution(session.id))?.run?.state).toBe("unknown"));
  } };
}
it("waits for public admission without holding the lane needed by Stop", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner });
  let release!: () => void; f.behavior.startGate = new Promise(resolve => { release = resolve; });
  const posted = f.manager.postMessage(session.id, "Admit once", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  await vi.waitFor(() => expect(f.authorizations.some(request => request.operation === "runs.start")).toBe(true));
  const review = f.manager.executionRecovery(session.id, f.owner);
  const stopping = f.manager.cancelSession(session.id);
  release(); await posted; await stopping;
  expect(await review).toMatchObject({ runId: f.starts[0]!.runId, recoverable: false });
  expect(f.starts).toHaveLength(1);
  expect(f.controls.filter(control => control.path.endsWith("/cancel"))).toHaveLength(1);
});

it("does not offer reconcile when the provider has not declared authoritative recovery", async () => {
  const f = await fixture(); await f.interrupt();
  f.capabilities.capabilities = f.capabilities.capabilities.filter(capability => capability !== "runs.reconcile");
  expect(await f.manager.executionRecovery(f.session.id, f.owner)).toMatchObject({ runId: f.runId, recoverable: false });
  expect(f.controls).toEqual([]);
  expect((await f.store.readProviderExecution(f.session.id))?.run?.stopConfirmed).toBe(false);
});

it("binds review and recovery to the exact public run generation and decimal revision", async () => {
  const f = await fixture(); await f.interrupt();
  const review = await f.manager.executionRecovery(f.session.id, f.owner);
  expect(review).toMatchObject({ runId: f.runId, generation: f.snapshot(f.runId).generation, expectedRevision: f.snapshot(f.runId).revision, recoverable: true });
  const input = { ...review!, requestId: randomUUID(), consumerExitConfirmed: true };
  f.update(f.runId, { observedAt: new Date().toISOString() });
  await expect(f.manager.recoverExecution(f.session.id, f.owner, input, f.credential)).rejects.toMatchObject({ code: "recovery_stale" });
  expect(f.controls).toEqual([]);
  expect(f.starts).toHaveLength(1);
});

it("keeps the original execution fenced when client attestation lacks provider-owned exit evidence", async () => {
  const f = await fixture(); await f.interrupt(); f.behavior.reconcile = "unavailable";
  const review = await f.manager.executionRecovery(f.session.id, f.owner);
  const input = { ...review!, requestId: randomUUID(), consumerExitConfirmed: true };
  await expect(f.manager.recoverExecution(f.session.id, f.owner, input, f.credential)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  const record = await f.store.readRecord(f.session.id);
  expect(record?.providerRecovery).toMatchObject({ state: "pending", runId: f.runId, input: { requestId: input.requestId } });
  expect((await f.store.readProviderExecution(f.session.id))?.run?.stopConfirmed).toBe(false);
  await expect(f.manager.postMessage(f.session.id, "Never replace an unknown process", f.credential)).rejects.toThrow();
  expect(f.starts).toHaveLength(1);
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "user_message")).toHaveLength(1);
});

it("retries the exact retained recovery after a lost completion write without another execution", async () => {
  const f = await fixture(); await f.interrupt();
  const review = await f.manager.executionRecovery(f.session.id, f.owner), input = { ...review!, requestId: randomUUID(), consumerExitConfirmed: true };
  const save = f.store.saveRecord.bind(f.store); let lost = false;
  vi.spyOn(f.store, "saveRecord").mockImplementation(async record => {
    if (!lost && record.providerRecovery?.state === "completed") { lost = true; throw new Error("Lost completion checkpoint"); }
    return save(record);
  });
  await expect(f.manager.recoverExecution(f.session.id, f.owner, input, f.credential)).rejects.toThrow("Lost completion checkpoint");
  await f.manager.recoverExecution(f.session.id, f.owner, input, f.credential);
  expect((await f.store.readRecord(f.session.id))?.providerRecovery).toMatchObject({ state: "completed", input: { requestId: input.requestId } });
  expect(f.controls.filter(control => control.input.command === "reconcile")).toHaveLength(1);
  expect(f.starts).toHaveLength(1);
  expect((await f.store.readEvents(f.session.id)).some(event => event.text === "Original immutable input")).toBe(true);
});

it("cancels an admitted lost-response start without retransmitting its immutable input", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), requestId = randomUUID();
  f.behavior.loseNextStartResponse = true;
  await expect(f.manager.postMessage(session.id, "May have started exactly once", f.credential, [], { actorUserId: f.owner, clientRequestId: requestId })).rejects.toThrow();
  expect(f.starts).toHaveLength(1);
  expect(await f.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({ state: "unknown" });
  await f.manager.cancelSession(session.id);
  expect(f.starts).toHaveLength(1);
  expect(f.controls.filter(control => control.path.endsWith("/cancel"))).toHaveLength(1);
  expect((await f.store.readRecord(session.id))?.sourceAdmission).toBeUndefined();
  await expect(f.manager.postMessage(session.id, "May have started exactly once", f.credential, [], { actorUserId: f.owner, clientRequestId: requestId })).rejects.toMatchObject({ code: "message_outcome_unknown" });
});

it("rejects another actor before reading or controlling the provider execution", async () => {
  const f = await fixture(); await f.interrupt(); const reads = f.requests.length;
  await expect(f.manager.executionRecovery(f.session.id, "another-user")).rejects.toMatchObject({ code: "session_not_found" });
  await expect(f.manager.recoverExecution(f.session.id, "another-user", { requestId: randomUUID(), consumerExitConfirmed: true })).rejects.toMatchObject({ code: "session_not_found" });
  expect(f.requests).toHaveLength(reads);
  expect(f.controls).toEqual([]);
});

it("retires a retained stopped run only on explicit owner Delete and detaches without deleting the workspace", async () => {
  const core = new DevelopmentClient("http://core.invalid", "unrelated.consumer", "fixture-service");
  const call = vi.spyOn(core, "call").mockResolvedValue({});
  const f = await fixture(core); await f.interrupt(); f.behavior.retire = "confirmed";
  call.mockClear();
  const other = await f.manager.createSession({ createdBy: f.owner });
  const existing = (await f.manager.getSession(f.session.id))!;
  existing.workspaceAssociation = { id: "shared-source", revision: 2 };
  existing.developmentLease = randomUUID();
  existing.developmentLeaseState = "stopped";
  existing.workspaceActivitySequence = 7;
  await f.store.saveRecord(existing);
  await f.manager.shutdown();
  const { manager } = f.makeManager({ development: core });
  const retention = vi.spyOn(core, "retention")
    .mockResolvedValueOnce({ kind: "workspace", workflow: { state: "in-progress", revision: 4 }, resourcesFinished: true })
    .mockResolvedValueOnce({ kind: "chat", workflow: null, resourcesFinished: true, sessionDetached: true });
  const activity = vi.spyOn(core, "activity").mockResolvedValue({ workspaceId: "shared-source", revision: 2, state: "active", stopRequested: false });
  call.mockResolvedValue({ workspace: { id: "shared-source", revision: 3 } });

  expect(await manager.sweepRetention(new Date("2100-01-01T00:00:00Z"), f.session.id)).toEqual([]);
  expect(f.controls).toEqual([]);
  await expect(manager.deleteSession(f.session.id, "another-user", f.credential, true)).rejects.toMatchObject({ code: "session_not_found" });
  expect(f.controls).toEqual([]);

  const actor = { userId: f.owner, principalId: "owner", hostRole: "host.admin" as const };
  const observer = new AgentSessionService(manager, f.provider);
  const visible = await observer.list(actor, { provider: f.provider, conversation: { provider: f.provider, id: f.session.id } });
  const attached = visible.sessions.find(session => session.activeRuns.some(run => run.id === existing.agentRunId))!;
  expect(attached).toBeDefined();
  const observation = attached.activeRuns.find(run => run.id === existing.agentRunId)!;

  const before = f.snapshot(f.runId);
  expect(await manager.deleteSession(f.session.id, f.owner, f.credential, true)).toBe(true);
  expect(f.controls).toEqual([{ runId: f.runId, path: `/runs/${f.runId}/controls`,
    input: { command: "retire", requestId: expect.any(String), expectedGeneration: before.generation, expectedRevision: before.revision } }]);
  expect(activity).toHaveBeenCalledWith(f.session.id, f.credential,
    { status: "idle", stopped: true, leaseId: existing.developmentLease, sequence: 8 });
  expect(call).toHaveBeenCalledExactlyOnceWith(f.session.id, f.credential, "detach",
    expect.objectContaining({ workspaceId: "shared-source", expectedRevision: 2 }));
  expect(retention.mock.calls.every(([, , cleanup]) => !cleanup)).toBe(true);
  expect(await f.store.readRecord(f.session.id)).toBeNull();
  expect(await f.store.readRecord(other.id)).not.toBeNull();
  expect(await observer.getSession(actor, attached.ref)).toMatchObject({ activeRuns: [], conversation: null });
  const retired = await observer.getRun(actor, observation);
  expect(retired).toMatchObject({ state: "unknown", stopConfirmed: false, conversation: null });
  await expect(observer.cancel(actor, { run: observation, expectedRevision: retired.revision, requestId: randomUUID() }, async () => {}))
    .rejects.toMatchObject({ code: "run_retired" });
  expect(f.controls).toHaveLength(1);
  expect(f.snapshot(f.runId)).toMatchObject({ stopConfirmed: false, effects: { certainty: "unknown", unresolvedCallIds: ["command"] } });
  expect(f.starts).toHaveLength(1);
});

it("replays the exact owner retirement after a lost response and restart without sending again", async () => {
  const f = await fixture(); await f.interrupt();
  f.behavior.retire = "confirmed"; f.behavior.loseNextRetireResponse = true;
  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).rejects.toThrow("lost the retirement response");
  const retirement = (await f.store.readRecord(f.session.id))?.providerRetirement;
  expect(retirement).toMatchObject({ runId: f.runId, state: "pending" });
  await f.manager.shutdown();
  const next = f.makeManager();
  await expect(next.manager.postMessage(f.session.id, "Late input", f.credential)).rejects.toMatchObject({ code: "session_deletion_pending" });
  await expect(next.manager.deleteSession(f.session.id, f.owner, f.credential)).rejects.toMatchObject({ code: "session_deletion_pending" });
  expect(await next.manager.deleteSession(f.session.id, f.owner, f.credential, true)).toBe(true);
  const attempts = f.requests.filter(request => request.method === "POST" && request.path.endsWith(`/runs/${f.runId}/controls`));
  expect(attempts.map(request => request.body)).toEqual([retirement?.request.body, retirement?.request.body]);
  expect(f.controls.filter(control => control.input.command === "retire")).toHaveLength(1);
  expect(f.starts).toHaveLength(1);
  expect(await next.store.readRecord(f.session.id)).toBeNull();
});

it("preserves delayed history while Delete awaits retry or sandbox cleanup without reopening execution", async () => {
  const core = new DevelopmentClient("http://core.invalid", "unrelated.consumer", "fixture-service");
  vi.spyOn(core, "call").mockResolvedValue({});
  const retention = vi.spyOn(core, "retention").mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: false });
  const f = await fixture(core, true);
  const other = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(other.id, "Second conversation", f.credential);
  await f.interrupt();
  f.behavior.retire = "confirmed";
  f.behavior.loseNextRetireResponse = true;
  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).rejects.toThrow("lost the retirement response");
  await f.manager.refreshSessionCredentials(f.session.id, f.owner, f.credential);
  await f.manager.refreshProviderHistory(f.session.id, f.owner, f.credential);
  f.emit(f.runId, "message.completed", { messageId: "delayed", text: "Delayed historical detail" });
  await vi.waitFor(async () => expect(await f.store.readEvents(f.session.id)).toContainEqual(expect.objectContaining({
    text: "Delayed historical detail", providerHistoryEarlier: true,
  })));

  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).rejects.toMatchObject({ code: "resource_retained" });
  const decision = { id: "late-approval", kind: "approval" as const, revision: "1", delivery: "continue_run" as const, toolName: "Bash" };
  f.update(f.runId, { pending: [decision] });
  f.complete(f.runId, "Late observer output");
  f.complete(f.starts[1]!.runId, "Retained conversation output");
  await vi.waitFor(async () => {
    expect(await f.store.readEvents(other.id)).toContainEqual(expect.objectContaining({ text: "Retained conversation output" }));
    const history = await f.store.readEvents(f.session.id);
    expect(history).toContainEqual(expect.objectContaining({ text: "Late observer output", providerHistoryEarlier: true }));
    const card = history.find(e => e.type === "approval_request" && e.providerHistoryEarlier === true);
    expect(card).toBeDefined();
    await expect(f.manager.resolveApproval(f.session.id, String(card!.approvalId), "allow")).rejects.toMatchObject({ code: "session_deletion_pending" });
  });
  expect((await f.store.readProviderExecution(f.session.id))?.run).toMatchObject({ state: "unknown", stopConfirmed: false, pending: [] });
  expect(f.starts).toHaveLength(2);
  expect(f.controls.map(c => c.input.command)).toEqual(["retire"]);
  retention.mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
  expect(await f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).toBe(true);
  f.emit(f.runId, "message.completed", { messageId: "deleted", text: "After deletion" });
  f.emit(f.starts[1]!.runId, "message.completed", { messageId: "other", text: "Bound chat still receives history" });
  await vi.waitFor(async () => expect(await f.store.readEvents(other.id)).toContainEqual(expect.objectContaining({ text: "Bound chat still receives history" })));
  expect(await f.store.readRecord(f.session.id)).toBeNull();
  expect(f.activeHistoryStreams()).toBe(1);
});

it("reads retained snapshots without attaching a legacy run observer during retirement", async () => {
  const f = await fixture(); await f.interrupt();
  f.behavior.retire = "confirmed"; f.behavior.loseNextRetireResponse = true;
  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).rejects.toThrow("lost the retirement response");
  await f.manager.shutdown();
  const { manager, store } = f.makeManager();
  f.complete(f.runId, "Retained snapshot detail");
  const previous = f.requests.length;
  await manager.refreshProviderHistory(f.session.id, f.owner, f.credential);
  expect(await store.readEvents(f.session.id)).toContainEqual(expect.objectContaining({ text: "Retained snapshot detail", providerHistoryEarlier: true }));
  expect((await store.readProviderExecution(f.session.id))?.run).toMatchObject({ state: "unknown", stopConfirmed: false });
  expect(f.requests.slice(previous).some(request => request.path.includes("/runs/") && request.path.includes("/events"))).toBe(false);
  expect(f.starts).toHaveLength(1);
  expect(f.controls.map(c => c.input.command)).toEqual(["retire"]);
});

it("uses the same Delete confirmation when Stop leaves unresolved effects", async () => {
  const f = await fixture();
  f.behavior.cancel = "unresolved"; f.behavior.retire = "confirmed";
  expect(await f.manager.deleteSession(f.session.id, f.owner, f.credential, true)).toBe(true);
  expect(f.controls.map(control => control.input.command ?? "cancel")).toEqual(["cancel", "retire"]);
  expect(await f.store.readRecord(f.session.id)).toBeNull();
  expect(f.starts).toHaveLength(1);
});

it.each([true, false])("keeps a run with unverified exit when Stop fails (interactive owner %s)", async interactive => {
  const f = await fixture(); await f.interrupt(); f.behavior.cancel = "unavailable";
  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential, interactive)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.controls.filter(control => control.input.command === "retire")).toHaveLength(interactive ? 1 : 0);
  expect(f.controls.filter(control => control.path.endsWith("/cancel"))).toHaveLength(1);
  expect((await f.store.readRecord(f.session.id))?.providerRetirement).toBeUndefined();
  expect((await f.store.readEvents(f.session.id)).some(event => event.text === "Original immutable input")).toBe(true);
});

it.each(["admitting", undefined] as const)("retains a separate Harness lease with %s stop evidence", async state => {
  const f = await fixture(); await f.interrupt();
  f.behavior.retire = "confirmed"; f.behavior.cancel = "unavailable";
  const existing = (await f.manager.getSession(f.session.id))!;
  existing.developmentLease = randomUUID();
  existing.developmentLeaseState = state;
  await f.store.saveRecord(existing);
  await f.manager.shutdown();
  const { manager } = f.makeManager();
  await expect(manager.deleteSession(f.session.id, f.owner, f.credential, true)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.controls.map(control => control.input.command ?? "cancel")).toEqual(["cancel"]);
  expect((await f.store.readRecord(f.session.id))?.developmentLease).toBe(existing.developmentLease);
});
