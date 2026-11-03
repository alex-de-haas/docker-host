import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DecisionClient, DecisionError, type DecisionCreate, type DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionsService } from "./service.js";
import { newWait } from "./waits.js";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "decision-coordinator-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const record = { id: "chat", createdBy: "alice", title: "A question", harnessKind: "codex", harnessSessionId: "native", connectionId: "account",
    status: "awaiting_question", workerRun: { id: "original", sequence: 1 } } as SessionRecord;
  let row: DecisionRecord | undefined;
  let outcome = "missing", run = { state: "awaiting_input", revision: 1, exitConfirmed: false, pending: [{ sequence: 1, event: { type: "question_request", questionId: "question" } }] };
  const calls: string[] = [];
  const client = new DecisionClient(async () => { throw new Error("Unexpected transport"); });
  client.create = vi.fn(async (input: DecisionCreate) => {
    calls.push("create");
    return row ??= { id: "d", userId: "alice", revision: 1, sequence: 1, input: input.input, state: "pending", sourceAppId: "app", sourceInstallation: "install",
      sourcePrincipal: "app", correlationHash: "hash", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null, delivery: null, continuation: null };
  });
  client.get = vi.fn(async () => { if (!row) throw new Error("Missing"); return structuredClone(row); });
  client.responses = vi.fn(async () => ({ items: row?.resolution && !row.delivery?.receivedAt ? [structuredClone(row)] : [], pendingCount: 0, cursor: null }));
  client.acknowledge = vi.fn(async () => {
    calls.push("ack");
    expect((await service.waits.read(wait.id))?.inbox).toBeDefined();
    row = { ...row!, delivery: { resolutionRevision: 2, receivedAt: new Date().toISOString() }, continuation: { revision: 1, commandId: null, state: "received", updatedAt: new Date().toISOString() } };
    return structuredClone(row);
  });
  client.continuation = vi.fn(async (_, input) => {
    if (input.expectedRevision !== row!.continuation!.revision) throw new DecisionError("decision_conflict", "Revision moved", 409);
    row = { ...row!, continuation: { ...row!.continuation!, revision: input.expectedRevision + 1, commandId: input.commandId, state: input.state, reason: input.reason ?? null } };
    calls.push(input.state); return structuredClone(row);
  });
  client.withdraw = vi.fn(async (_, input) => {
    if (input.expectedRevision !== row!.revision) throw new DecisionError("decision_conflict", "Revision moved", 409);
    row = { ...row!, state: "withdrawn", revision: row!.revision + 1 }; calls.push("withdraw"); return structuredClone(row);
  });
  client.invalidate = vi.fn(async (id, input) => {
    const closed = await client.withdraw(id, input); row = { ...closed, state: "stale" }; return structuredClone(row);
  });
  const manager = {
    store: { dataDir: root }, getSession: vi.fn(async () => record), checkDecision: vi.fn(async () => {}),
    stopDecisionExecution: vi.fn(async () => {}), recordDecisionAnswer: vi.fn(async () => {}), finishDecision: vi.fn(async () => {}),
    deliverDecision: vi.fn(async () => { outcome = "applied"; run.state = "running"; }),
    parkDecision: vi.fn(async () => { run = { ...run, state: "parked", exitConfirmed: true }; }),
    messageReceipt: vi.fn(async () => { throw new DecisionError("message_request_not_found", "Absent", 404); }),
    resumeDecision: vi.fn(async () => { record.decisionRunIds = { [wait.commandId]: "resumed" }; run.state = "running"; run.exitConfirmed = false; }),
    worker: { request: vi.fn(async (url: string) => url.includes("/controls/") ? { state: outcome } : structuredClone(run)) },
  };
  const service = new DecisionsService(manager as unknown as SessionManager, () => client);
  // Drive reconciliation deterministically; production uses the same tick through its timer.
  vi.spyOn(service, "kick").mockImplementation(() => {});
  cleanup.push(() => service.close()); service.authorize("alice", "current-credential");
  const wait = newWait(record, { type: "question_request", questionId: "question", blocking: true,
    questions: [{ id: "q", question: "Which?", header: "Choice", options: [{ id: "a", label: "A", description: "" }], multiSelect: false }], workerRunId: "original" });
  record.decisionWaitIds = [wait.id]; await service.waits.update(wait.id, () => wait);
  const answer = () => { row = { ...row!, revision: 2, state: "answered", resolution: { revision: 2, userId: "alice", principalId: "alice", answers: { q: { optionIds: ["a"] } }, answeredAt: new Date().toISOString() }, delivery: { resolutionRevision: 2, receivedAt: null }, continuation: { revision: 0, state: "pending", commandId: null, updatedAt: new Date().toISOString() } }; };
  return { service, wait, manager, client, record, calls, answer, row: () => row!, run: (patch: Partial<typeof run>) => { run = { ...run, ...patch }; }, outcome: (value: string) => { outcome = value; } };
}
it("persists inbox before acknowledgement and delivers one native control across repeated outbox reconciliation", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); await f.service.tick(); await f.service.tick();
  expect(f.calls.indexOf("ack")).toBeLessThan(f.calls.indexOf("admitted"));
  expect(f.manager.deliverDecision).toHaveBeenCalledTimes(1);
  expect((await f.service.local("alice", f.wait.id)).state).toBe("running");
  f.run({ state: "completed", exitConfirmed: true }); await f.service.tick();
  expect(f.row().continuation?.state).toBe("completed"); expect(f.manager.finishDecision).toHaveBeenCalledTimes(1);
});
it("retains answer when acknowledgement fails and retries the same acknowledgement identity", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  vi.mocked(f.client.acknowledge).mockRejectedValueOnce(new Error("Lost response"));
  await f.service.tick(); expect((await f.service.local("alice", f.wait.id)).inbox).toBeDefined(); expect(f.manager.deliverDecision).not.toHaveBeenCalled();
  await f.service.tick(); expect(f.manager.deliverDecision).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.client.acknowledge).mock.calls.map(c => c[1].requestId)).toEqual([f.wait.acknowledgementId, f.wait.acknowledgementId]);
});
it("does not repeat a native answer after uncertain acceptance or a dead original callback", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  f.manager.deliverDecision.mockImplementationOnce(async () => { f.outcome("unknown"); throw new Error("Connection lost after send"); });
  await f.service.tick(); f.run({ state: "parked", exitConfirmed: true }); await f.service.tick(); await f.service.tick();
  expect(f.manager.deliverDecision).toHaveBeenCalledTimes(1); expect(f.manager.resumeDecision).not.toHaveBeenCalled();
  expect((await f.service.local("alice", f.wait.id)).reason).toBe("unknown_admission");
});
it("does not confuse a failed receipt read with absence of admission", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  await f.service.waits.update(f.wait.id, w => ({ ...w!, state: "admitted", resumeRequested: true }));
  f.run({ state: "parked", exitConfirmed: true });
  f.manager.messageReceipt.mockRejectedValue(new Error("Disk unavailable"));
  await f.service.tick(); await f.service.tick();
  expect(f.manager.resumeDecision).not.toHaveBeenCalled();
});
it("recovers a parked continuation through the original stable message and observes only its recorded segment", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  await f.service.waits.update(f.wait.id, w => ({ ...w!, state: "admitted", resumeRequested: true }));
  f.run({ state: "parked", exitConfirmed: true }); await f.service.tick(); await f.service.tick();
  expect(f.manager.resumeDecision).toHaveBeenCalledTimes(1);
  expect((await f.service.local("alice", f.wait.id)).resumedRunId).toBe("resumed");
});
it("retains answers after changed input and never admits an unknown exit", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  f.manager.checkDecision.mockRejectedValue(new DecisionError("stale_input", "Provider changed", 409));
  await f.service.tick(); expect((await f.service.local("alice", f.wait.id)).reason).toBe("stale_input");
  expect(f.row().state).toBe("stale"); expect(f.manager.resumeDecision).not.toHaveBeenCalled();
  const g = await fixture(); await g.service.tick(); g.answer(); g.run({ state: "interrupted", exitConfirmed: false }); await g.service.tick();
  expect((await g.service.local("alice", g.wait.id)).reason).toBe("unknown_stop"); expect(g.manager.resumeDecision).not.toHaveBeenCalled();
});
it("reconciles an uncertain registration before cancellation and preserves its source fence", async () => {
  const f = await fixture(); const create = f.client.create;
  vi.spyOn(f.client, "create").mockImplementationOnce(async input => { await create(input); throw new Error("Lost create response"); });
  await f.service.tick(); f.record.decisionGeneration = 1;
  await f.service.tick(); await f.service.tick();
  expect(f.row().state).toBe("withdrawn"); expect((await f.service.local("alice", f.wait.id)).cancellationSettled).toBe(true);
  expect(f.manager.deliverDecision).not.toHaveBeenCalled();
});
it("withdraws at the current revision after cancellation races with an answer", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); f.record.decisionGeneration = 1;
  await f.service.tick(); expect(f.row().state).toBe("withdrawn"); expect(f.manager.resumeDecision).not.toHaveBeenCalled();
});
it("parks only blocking waits and does not treat the resource deadline as an answer", async () => {
  const f = await fixture(); await f.service.tick();
  await f.service.waits.update(f.wait.id, w => ({ ...w!, createdAt: "2000-01-01T00:00:00Z" }));
  await f.service.tick(); expect(f.manager.parkDecision).toHaveBeenCalledTimes(1); expect(f.row().state).toBe("pending");
  const g = await fixture(); await g.service.waits.update(g.wait.id, w => ({ ...w!, event: { ...w!.event, blocking: false }, createdAt: "2000-01-01T00:00:00Z" }));
  await g.service.tick(); expect(g.manager.parkDecision).not.toHaveBeenCalled();
});
it("hides private waits from another administrator", async () => {
  const f = await fixture(); await expect(f.service.local("bob", f.wait.id)).rejects.toMatchObject({ status: 404 });
});

it("does not re-admit running work when Core serializes its absent reason as null", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); await f.service.tick();
  expect(f.row().continuation).toMatchObject({ state: "running", reason: null });
  f.run({ state: "completed", exitConfirmed: true });
  await f.service.tick(); await f.service.tick();
  expect(f.calls.filter(call => call === "running")).toHaveLength(1);
  expect((await f.service.waits.read(f.wait.id))?.state).toBe("completed");
  expect(f.row().continuation?.state).toBe("completed");
});

it("releases its reconciliation lock after a transient wait read failure", async () => {
  const f = await fixture();
  const read = f.service.waits.read.bind(f.service.waits);
  vi.spyOn(f.service.waits, "read").mockImplementationOnce(read).mockRejectedValueOnce(new Error("Temporary read failure"));
  await f.service.retry("alice", f.wait.id).catch(() => {});
  await f.service.tick();
  expect(f.client.create).toHaveBeenCalledTimes(1);
  expect((await f.service.local("alice", f.wait.id)).core?.id).toBe("d");
});
