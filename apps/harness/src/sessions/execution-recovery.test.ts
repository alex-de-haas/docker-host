import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { AgentClient, prepareAgentControl } from "@hosty-sdk/app/agent/client";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";
import { DevelopmentClient } from "./development.js";
import * as appSession from "../app-session.js";

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
  expect(f.manager.isSourceAdmissionInFlight((await f.manager.getSession(session.id))!)).toBe(true);
  const stopping = f.manager.cancelSession(session.id);
  release(); await posted; await stopping;
  expect(f.manager.isSourceAdmissionInFlight((await f.manager.getSession(session.id))!)).toBe(false);
  expect(f.starts).toHaveLength(1);
  expect(f.controls.filter(control => control.path.endsWith("/stop"))).toHaveLength(1);
});

it("cancels an admitted lost-response start without retransmitting its immutable input", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), requestId = randomUUID();
  f.behavior.loseNextStartResponse = true;
  await expect(f.manager.postMessage(session.id, "May have started exactly once", f.credential, [], { actorUserId: f.owner, clientRequestId: requestId })).rejects.toThrow();
  expect(f.starts).toHaveLength(1);
  expect(await f.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({ state: "unknown" });
  const current = (await f.manager.getSession(session.id))!;
  expect(current.sourceAdmission).toBeDefined();
  expect(f.manager.isSourceAdmissionInFlight(current)).toBe(false);
  await f.manager.cancelSession(session.id);
  expect(f.starts).toHaveLength(1);
  expect(f.controls.filter(control => control.path.endsWith("/stop"))).toHaveLength(1);
  expect((await f.store.readRecord(session.id))?.sourceAdmission).toBeUndefined();
  await expect(f.manager.postMessage(session.id, "May have started exactly once", f.credential, [], { actorUserId: f.owner, clientRequestId: requestId })).resolves.toMatchObject({ state: "accepted" });
  expect(f.starts).toHaveLength(1);
});

it.each([true, false])("recovers exact preauthorized send without a browser, admitted=%s", async admitted => {
  const f = await publicProviderFixture(true); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), requestId = randomUUID();
  if (admitted) f.behavior.loseNextStartResponse = true;
  else f.behavior.refuseNextStart = true;
  await expect(f.manager.postMessage(session.id, "Exact retained input", f.credential, [],
    { actorUserId: f.owner, clientRequestId: requestId })).rejects.toThrow();
  const requests = f.requests.length;
  await f.manager.shutdown();
  const restarted = f.makeManager();
  await restarted.manager.recoverProviderRuns();
  await vi.waitFor(async () => expect(await restarted.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({ state: "accepted" }));
  expect(f.starts).toHaveLength(1);
  expect(f.controls).toEqual([]);
  const recovered = f.requests.slice(requests);
  expect(recovered.some(r => r.path.endsWith("/agent/replay/token"))).toBe(!admitted);
  expect(recovered.every(r => !r.userToken)).toBe(true);
  expect((await restarted.store.readRecord(session.id))?.sourceAdmission).toBeUndefined();
});

it("marks a revoked scope on the retained send without dispatch or a replacement UUID", async () => {
  const f = await publicProviderFixture(true); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), requestId = randomUUID();
  f.behavior.refuseNextStart = true;
  await expect(f.manager.postMessage(session.id, "Private input", f.credential, [], { actorUserId: f.owner, clientRequestId: requestId })).rejects.toThrow();
  await f.manager.shutdown();
  f.behavior.revokeReplay = true;
  const restarted = f.makeManager();
  await restarted.manager.recoverProviderRuns();
  await vi.waitFor(async () => expect((await restarted.store.readRecord(session.id))?.sourceAdmission).toMatchObject({ clientRequestId: requestId, needsAuthority: true }));
  expect(f.starts).toEqual([]);
  expect(f.requests.filter(r => r.path.endsWith("/agent/replay/token")).every(r => !r.body.includes("Private input") && !r.userToken)).toBe(true);
  await expect(restarted.manager.authorizePendingMessage(session.id, f.owner, randomUUID(), f.credential)).rejects.toMatchObject({ code: "message_changed" });
  await restarted.manager.authorizePendingMessage(session.id, f.owner, requestId, f.credential);
  expect(f.starts).toHaveLength(1);
  expect(await restarted.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({ state: "accepted" });
});

it("settles a lost decision response from the original receipt after a consumer restart", async () => {
  const f = await fixture(undefined, true), decision = { id: "permission", revision: "1", kind: "approval" as const, delivery: "continue_run" as const,
    toolName: "Bash", toolCallId: "cmd", source: { agentId: "root" } };
  f.runs.get(f.runId)!.pending = [decision];
  f.emit(f.runId, "decision.requested", { decisionId: decision.id, decision });
  const card = await vi.waitFor(async () => {
    const row = (await f.store.readEvents(f.session.id)).find(item => item.type === "approval_request");
    expect(row).toBeDefined(); return String(row!.approvalId);
  });
  f.behavior.loseNextResponse = true;
  await expect(f.manager.resolveApproval(f.session.id, card, "allow", undefined, f.owner)).rejects.toThrow();
  const sent = f.controls.filter(c => c.path.endsWith("/responses"));
  expect(sent).toHaveLength(1);
  await f.manager.shutdown();
  const restarted = f.makeManager(), requests = f.requests.length;
  await restarted.manager.recoverProviderRuns();
  await vi.waitFor(async () => expect((await restarted.store.readEvents(f.session.id)).filter(row => row.type === "approval_decision"))
    .toMatchObject([{ approvalId: card, decision: "allow" }]));
  expect(f.controls.filter(c => c.path.endsWith("/responses"))).toHaveLength(1);
  expect(f.requests.slice(requests).every(r => !r.userToken)).toBe(true);
});

it("keeps an unadmitted send uncertain until the same Stop request durably fences it", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), requestId = randomUUID();
  f.behavior.refuseNextStart = true;
  await expect(f.manager.postMessage(session.id, "Never admitted", f.credential, [],
    { actorUserId: f.owner, clientRequestId: requestId })).rejects.toThrow();
  expect(f.controls).toEqual([]);
  f.behavior.cancel = "unavailable";
  await expect(f.manager.cancelSession(session.id, f.credential)).resolves.toBe(false);
  expect(await f.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({ state: "unknown" });
  f.behavior.cancel = "confirmed";
  await expect(f.manager.cancelSession(session.id, f.credential)).resolves.toBe(true);
  expect(f.controls).toHaveLength(2);
  expect(f.controls[1]).toEqual(f.controls[0]);
  expect(await f.manager.messageReceipt(session.id, requestId, f.owner)).toMatchObject({
    state: "rejected", error: { code: "run_not_admitted" },
  });
  expect((await f.store.readRecord(session.id))?.sourceAdmission).toBeUndefined();
  expect(f.requests.filter(request => /\/sessions\/[^/]+\/runs\/[^/]+$/.test(request.path))).toHaveLength(1);
  expect(f.starts).toEqual([]);
});

it("shows an unconfirmed Stop in a paused queue and enables retry after admission is fenced", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const session = await f.manager.createSession({ createdBy: f.owner }), entryId = randomUUID();
  vi.spyOn(appSession, "resolveAppSession").mockResolvedValue({ status: "active",
    identity: { userId: f.owner, hostRole: "host.admin" } });
  f.behavior.refuseNextStart = true;
  await f.manager.messageQueueCommand(session.id, f.owner, {
    requestId: randomUUID(), expectedRevision: (await f.manager.messageQueue(session.id, f.owner)).revision,
    command: { type: "enqueue", entryId, text: "Keep the original queue message", attachments: [] },
  }, f.credential);
  await vi.waitFor(async () => expect((await f.manager.messageQueue(session.id, f.owner)).entries[0]?.state).toBe("unknown"));
  f.behavior.cancel = "unavailable";
  await expect(f.manager.cancelSession(session.id, f.credential)).resolves.toBe(false);
  expect(await f.manager.messageQueue(session.id, f.owner)).toMatchObject({
    paused: true, reason: "Waiting for the provider to confirm Stop.",
    entries: [{ id: entryId, state: "unknown" }],
  });
  await expect(f.manager.messageQueueCommand(session.id, f.owner, {
    requestId: randomUUID(), expectedRevision: (await f.manager.messageQueue(session.id, f.owner)).revision,
    command: { type: "resume" },
  }, f.credential)).rejects.toMatchObject({ code: "stop_unconfirmed" });
  f.behavior.cancel = "confirmed";
  await f.manager.cancelSession(session.id, f.credential);
  expect(await f.manager.messageQueue(session.id, f.owner)).toMatchObject({
    paused: true, entries: [{ id: entryId, state: "failed", error: { code: "run_not_admitted" } }],
  });
});

it("restarts an outstanding Stop without a user credential or another browser request", async () => {
  const f = await fixture();
  f.behavior.cancel = "unavailable";
  await expect(f.manager.cancelSession(f.session.id, f.credential)).resolves.toBe(false);
  expect((await f.store.readRecord(f.session.id))?.providerStopRequestedRunId).toBe(f.runId);
  await f.manager.shutdown();
  f.behavior.cancel = "confirmed";
  const restarted = f.makeManager();
  const requests = f.requests.length;
  await restarted.manager.recoverProviderRuns();
  await vi.waitFor(async () => expect((await restarted.store.readRecord(f.session.id))?.providerStopProof?.runId).toBe(f.runId));
  expect(f.requests.slice(requests).every(r => !r.userToken)).toBe(true);
  expect(new Set(f.controls.filter(c => c.path.endsWith("/stop")).map(c => c.path + JSON.stringify(c.input))).size).toBe(1);
  expect(f.starts).toHaveLength(1);
});

it("clears the Stop request when the provider already confirmed exit at a parked checkpoint", async () => {
  const f = await fixture();
  f.update(f.runId, { state: "waiting_for_input", phase: "parked", stopConfirmed: true });
  await expect(f.manager.cancelSession(f.session.id, f.credential)).resolves.toBe(true);
  const stopped = (await f.manager.getSession(f.session.id))!;
  expect(stopped.providerStopRequestedRunId).toBeUndefined();
  expect(f.manager.isProviderStopUnconfirmed(stopped)).toBe(false);
  await expect(f.manager.postMessage(f.session.id, "Continue after confirmed Stop", f.credential, [],
    { actorUserId: f.owner, clientRequestId: randomUUID() })).resolves.toMatchObject({ state: "accepted" });
});

it.each(["succeeded", "failed", "cancelled"] as const)("deletes a %s conversation after provider reinstall without contacting its replacement", async outcome => {
  const f = await fixture();
  if (outcome === "succeeded") f.complete(f.runId);
  else if (outcome === "failed") f.update(f.runId, { state: "failed", phase: "terminal", stopConfirmed: true, result: { status: "failed" } });
  else await f.manager.cancelSession(f.session.id);
  await vi.waitFor(async () => expect(await f.store.readRecord(f.session.id)).toMatchObject({
    status: outcome === "succeeded" ? "idle" : outcome, providerStopProof: { runId: f.runId },
  }));
  await f.manager.shutdown();
  f.provider.installationId = "replacement-installation";
  const { manager, store } = f.makeManager();
  const authorizations = f.authorizations.length, controls = f.controls.length;
  await expect(manager.deleteSession(f.session.id, "another-owner", f.credential)).rejects.toMatchObject({ code: "session_not_found" });
  await expect(manager.deleteSession(f.session.id, f.owner, f.credential)).resolves.toBe(true);
  expect(await store.readRecord(f.session.id)).toBeNull();
  expect(f.authorizations).toHaveLength(authorizations);
  expect(f.controls).toHaveLength(controls);
});

it("uses retained physical closure for Stop and Delete when the original provider is unavailable", async () => {
  const f = await fixture();
  f.complete(f.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(f.session.id))?.providerStopProof?.runId).toBe(f.runId));
  await f.manager.shutdown();
  const { manager, store } = f.makeManager();
  await manager.refreshSessionCredentials(f.session.id, f.owner, f.credential);
  const before = await store.readProviderExecution(f.session.id);
  const reads = vi.spyOn(AgentClient.prototype, "run").mockRejectedValue(
    new AgentApiError("provider_unavailable", "The provider installation changed.", 503));
  await expect(manager.cancelSession(f.session.id)).resolves.toBe(false);
  expect(await store.readProviderExecution(f.session.id)).toEqual(before);
  const calls = reads.mock.calls.length;
  await expect(manager.deleteSession(f.session.id, f.owner, f.credential)).resolves.toBe(true);
  expect(reads).toHaveBeenCalledTimes(calls);
  expect(f.controls).toEqual([]);
  expect(await store.readRecord(f.session.id)).toBeNull();
});

it("retains the original terminal proof across restart and applies retention without owner sign-in", async () => {
  const f = await fixture();
  f.complete(f.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(f.session.id))?.providerStopProof?.runId).toBe(f.runId));
  await f.manager.shutdown();
  f.provider.installationId = "replacement-installation";
  const { manager, store } = f.makeManager();
  const authorizations = f.authorizations.length;
  expect(await manager.sweepRetention(new Date("2100-01-01T00:00:00Z"), f.session.id)).toEqual([f.session.id]);
  expect(f.authorizations).toHaveLength(authorizations);
  expect(f.controls).toEqual([]);
  expect(await store.readRecord(f.session.id)).toBeNull();
});

it.each(["control", "continuation", "snapshot reservation", "admission"] as const)("retains a completed conversation with a pending %s after provider reinstall", async pending => {
  const f = await fixture();
  f.complete(f.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(f.session.id))?.providerStopProof?.runId).toBe(f.runId));
  await f.manager.shutdown();
  const state = (await f.store.readProviderExecution(f.session.id))!;
  const snapshot = state.run!, requestId = randomUUID();
  if (pending === "control") {
    const request = prepareAgentControl(f.runId, { command: "predictions", enabled: false, requestId,
      expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision });
    state.mutations = { [request.bodyHash]: request };
  } else if (pending === "continuation") {
    state.continuations = { [requestId]: { requestId, sourceRunId: f.runId, state: "awaiting_authorization",
      run: { provider: snapshot.ref.provider, id: randomUUID() }, input: state.lastRunInput!.input } };
  } else if (pending === "snapshot reservation") {
    snapshot.pendingContinuations = [{ requestId, state: "pending", run: { provider: snapshot.ref.provider, id: randomUUID() } }];
  } else {
    const record = (await f.store.readRecord(f.session.id))!;
    record.sourceAdmission = { clientRequestId: requestId, previousProviderRunId: f.runId, runId: randomUUID(), state: "dispatching" };
    await f.store.saveRecord(record);
  }
  await f.store.saveProviderExecution(f.session.id, state);
  f.provider.installationId = "replacement-installation";
  const { manager, store } = f.makeManager();
  await expect(manager.deleteSession(f.session.id, f.owner, f.credential)).rejects.toMatchObject({ code: "provider_changed" });
  expect(await store.readRecord(f.session.id)).toBeTruthy();
  expect(await store.readProviderExecution(f.session.id)).toMatchObject(state);
  expect(f.controls).toEqual([]);
});

it("keeps a confirmed chat hidden across provider loss and Harness restart, then finishes without the browser", async () => {
  const f = await fixture();
  const sibling = await f.manager.createSession({ createdBy: f.owner });
  await f.interrupt();
  f.behavior.cancel = "unavailable";
  const requestId = randomUUID();
  expect(await f.manager.confirmSessionRemoval(f.session.id, "another-owner", requestId)).toBe(false);
  expect(await f.manager.confirmSessionRemoval(f.session.id, f.owner, requestId, f.credential)).toBe(true);
  expect(await f.manager.getSession(f.session.id)).toBeNull();
  expect(await f.manager.listSessions()).toEqual([expect.objectContaining({ id: sibling.id })]);
  expect(f.manager.removalStatus(f.session.id, "another-owner")).toBeUndefined();
  await vi.waitFor(() => expect(f.manager.removalStatus(f.session.id, f.owner)).toMatchObject({ state: "pending", reason: "exit_unconfirmed", requestId }));
  await f.manager.shutdown();
  const next = f.makeManager();
  expect(await next.manager.confirmSessionRemoval(f.session.id, f.owner, randomUUID())).toBe(true);
  f.emit(f.runId, "message.completed", { messageId: "late", text: "Late provider delivery" });
  expect(await next.store.readEvents(f.session.id)).toEqual([]);
  f.behavior.cancel = "confirmed";
  f.behavior.snapshotIssue = "denied";
  await vi.waitFor(() => {
    next.manager.wakeRemovalCleanup();
    expect(next.manager.removalStatus(f.session.id, f.owner)).toMatchObject({ state: "removed", requestId });
  }, { timeout: 5000, interval: 50 });
  expect(f.requests.some(request => request.path.endsWith(`/runs/${f.runId}/closure`))).toBe(true);
  expect(f.requests.filter(request => request.path.endsWith("/agent/cleanup/token")).every(request => request.userToken === null)).toBe(true);
  expect(await next.store.readRecord(sibling.id)).not.toBeNull();
  expect(f.starts).toHaveLength(1);
});

it("removes a confirmed chat after physical Stop with unresolved tool effects and no retirement control", async () => {
  const f = await fixture();
  f.capabilities.capabilities = f.capabilities.capabilities.filter(value => value !== "runs.retire");
  f.behavior.cancel = "unresolved";
  expect(await f.manager.confirmSessionRemoval(f.session.id, f.owner, randomUUID(), f.credential)).toBe(true);
  expect(await f.manager.getSession(f.session.id)).toBeNull();
  await vi.waitFor(() => expect(f.manager.removalStatus(f.session.id, f.owner)?.state).toBe("removed"));
  expect(f.controls.map(control => control.path)).toEqual([`/runs/${f.runId}/stop`]);
  expect(await f.store.readRecord(f.session.id)).toBeNull();
  expect(f.starts).toHaveLength(1);
});

it("deletes through confirmed Stop when the original provider lacks retirement support", async () => {
  const f = await fixture(); await f.interrupt();
  f.capabilities.capabilities = f.capabilities.capabilities.filter(value => value !== "runs.retire");
  expect(await f.manager.deleteSession(f.session.id, f.owner, f.credential)).toBe(true);
  expect(f.controls.map(control => control.input.command ?? "cancel")).toEqual(["cancel"]);
});

it("removes a session when provider reads fail after its Stop was confirmed", async () => {
  const core = new DevelopmentClient("http://core.invalid", "unrelated.consumer", "fixture-service");
  vi.spyOn(core, "call").mockResolvedValue({});
  const f = await fixture(core);
  const retention = vi.spyOn(core, "retention").mockImplementation(async () => {
    expect(f.snapshot(f.runId)).toMatchObject({ state: "cancelled", stopConfirmed: true });
    f.behavior.snapshotIssue = "timeout";
    return { kind: "chat", workflow: null, resourcesFinished: true };
  });

  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential)).resolves.toBe(true);
  expect(retention).toHaveBeenCalledOnce();
  expect(f.controls.filter(control => control.path.endsWith("/stop"))).toHaveLength(1);
  expect(await f.store.readRecord(f.session.id)).toBeNull();
});

it("keeps the physical payload while a run has unverified exit", async () => {
  const f = await fixture(); await f.interrupt(); f.behavior.cancel = "unavailable";
  await expect(f.manager.deleteSession(f.session.id, f.owner, f.credential)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.controls.filter(control => control.input.command === "retire")).toHaveLength(0);
  expect(f.controls.filter(control => control.path.endsWith("/stop"))).toHaveLength(1);
  expect((await f.store.readRecord(f.session.id))?.providerRetirement).toBeUndefined();
  expect((await f.store.readEvents(f.session.id)).some(event => event.text === "Original immutable input")).toBe(true);
});

it.each(["admitting", undefined] as const)("retains a separate Harness lease with %s stop evidence", async state => {
  const f = await fixture(); await f.interrupt();
  f.behavior.cancel = "unavailable";
  const existing = (await f.manager.getSession(f.session.id))!;
  existing.developmentLease = randomUUID();
  existing.developmentLeaseState = state;
  await f.store.saveRecord(existing);
  await f.manager.shutdown();
  const { manager } = f.makeManager();
  await expect(manager.deleteSession(f.session.id, f.owner, f.credential)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.controls.map(control => control.input.command ?? "cancel")).toEqual(["cancel"]);
  expect((await f.store.readRecord(f.session.id))?.developmentLease).toBe(existing.developmentLease);
});
