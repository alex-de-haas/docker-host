import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
  const f = await publicProviderFixture(); fixtures.push(f);
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
