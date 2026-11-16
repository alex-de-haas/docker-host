import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DecisionClient, DecisionError, type DecisionCreate, type DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionsService } from "./service.js";
import { DecisionWaitStore, newWait } from "./waits.js";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import type { AgentRunSnapshot } from "@hosty-sdk/app/agent";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-decision-coordinator-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const record = { id: "chat", createdBy: "alice", title: "Required task input", harnessKind: "agent",
    harnessSessionId: "public-session", taskExecutionId: randomUUID(), status: "awaiting_question",
    workerRun: { id: "original", sequence: 1 } } as SessionRecord;
  const questionId = randomUUID();
  const wait = newWait(record, { type: "question_request", questionId, blocking: true,
    questions: [{ id: "setup", header: "Setup", question: "Is setup ready?", options: [], allowText: true, multiSelect: false }] });
  wait.taskInput = { requestHash: "same-input", barrierId: questionId, reason: "Setup required" };
  record.decisionWaitIds = [wait.id];
  record.taskBarrier = { id: questionId, kind: "human_input", state: "parked", commandId: wait.commandId } as SessionRecord["taskBarrier"];
  let row: DecisionRecord | undefined;
  let run = { ref: { id: "resumed", provider: { appId: "other.agent", installationId: "opaque", key: "default" } },
    state: "running", phase: "executing", freshness: "current", stopConfirmed: false, pending: [] } as unknown as AgentRunSnapshot;
  const calls: string[] = [];
  const client = new DecisionClient(async () => { throw new Error("Unexpected transport"); });
  client.create = vi.fn(async (input: DecisionCreate) => row ??= { id: "d", userId: "alice", revision: 1, sequence: 1,
    input: input.input, state: "pending", sourceAppId: "app", sourceInstallation: "install", sourcePrincipal: "app", correlationHash: "hash",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null, delivery: null, continuation: null });
  client.get = vi.fn(async () => structuredClone(row!));
  client.responses = vi.fn(async () => ({ items: row?.resolution && !row.delivery?.receivedAt ? [structuredClone(row)] : [], pendingCount: 0, cursor: null }));
  client.acknowledge = vi.fn(async () => {
    expect((await service.waits.read(wait.id))?.inbox).toBeDefined(); calls.push("ack");
    row = { ...row!, delivery: { resolutionRevision: 2, receivedAt: new Date().toISOString() },
      continuation: { revision: 1, commandId: null, state: "received", updatedAt: new Date().toISOString() } };
    return structuredClone(row);
  });
  client.continuation = vi.fn(async (_, input) => {
    if (input.expectedRevision !== row!.continuation!.revision) throw new DecisionError("decision_conflict", "Revision moved", 409);
    calls.push(input.state); row = { ...row!, continuation: { ...row!.continuation!, revision: input.expectedRevision + 1,
      commandId: input.commandId, state: input.state, reason: input.reason ?? null } }; return structuredClone(row);
  });
  client.withdraw = vi.fn(async () => { row = { ...row!, state: "withdrawn", revision: row!.revision + 1 }; return structuredClone(row); });
  client.invalidate = vi.fn(async () => { row = { ...row!, state: "stale", revision: row!.revision + 1 }; return structuredClone(row); });
  const manager = { store: { dataDir: root }, getSession: vi.fn(async () => record), checkDecision: vi.fn(async () => {}),
    recordDecisionAnswer: vi.fn(async () => {}), advanceTaskBarrier: vi.fn(async () => {}),
    resumeTaskBarrier: vi.fn(async () => { record.decisionRunIds = { [wait.commandId]: "resumed" }; }),
    messageReceipt: vi.fn(async () => ({ state: "accepted" })), taskCheckpoint: vi.fn(async () => run),
    finishDecision: vi.fn(async () => {}), stopDecisionExecution: vi.fn(async () => {}),
    decisionProjections: vi.fn(async () => ({ items: [] })) };
  const service = new DecisionsService(manager as unknown as SessionManager, () => client);
  vi.spyOn(service, "kick").mockImplementation(() => {});
  await service.waits.update(wait.id, () => wait); service.authorize("alice", "volatile-authority");
  cleanup.push(() => service.close());
  return { root, service, manager, client, record, wait, calls, row: () => row!,
    answer: () => { row = { ...row!, state: "answered", revision: 2,
      resolution: { revision: 2, userId: "alice", principalId: "alice", answeredAt: new Date().toISOString(), answers: { setup: { text: "Ready" } } },
      delivery: { resolutionRevision: 2, receivedAt: null } } as DecisionRecord; },
    run: (patch: Partial<AgentRunSnapshot>) => { run = { ...run, ...patch }; } };
}

it("persists the answer before acknowledgement and resumes the same task command once", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); await f.service.tick(); await f.service.tick();
  expect(f.calls.indexOf("ack")).toBeLessThan(f.calls.indexOf("admitted"));
  expect(f.manager.resumeTaskBarrier).toHaveBeenCalledTimes(1);
  expect((await f.service.local("alice", f.wait.id)).resumedRunId).toBe("resumed");
});
it("retries a lost acknowledgement with its original identity before admitting task continuation", async () => {
  const f = await fixture(); await f.service.tick(); f.answer();
  vi.mocked(f.client.acknowledge).mockRejectedValueOnce(new Error("Lost acknowledgement"));
  await f.service.tick(); expect((await f.service.local("alice", f.wait.id)).inbox).toBeDefined();
  expect(f.manager.resumeTaskBarrier).not.toHaveBeenCalled(); await f.service.tick();
  expect(f.manager.resumeTaskBarrier).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.client.acknowledge).mock.calls.map(call => call[1].requestId)).toEqual([f.wait.acknowledgementId, f.wait.acknowledgementId]);
});
it("observes provider stop confirmation before completing a continuation", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); await f.service.tick();
  f.run({ state: "succeeded", stopConfirmed: false }); await f.service.tick();
  expect(f.manager.finishDecision).not.toHaveBeenCalled();
  f.run({ stopConfirmed: true }); await f.service.tick(); await f.service.tick();
  expect(f.row().continuation?.state).toBe("completed"); expect(f.manager.finishDecision).toHaveBeenCalledTimes(1);
});
it("never substitutes another run or resubmits after an uncertain provider observation", async () => {
  const f = await fixture(); await f.service.tick(); f.answer(); await f.service.tick();
  f.manager.taskCheckpoint.mockRejectedValueOnce(new Error("Provider unavailable")); await f.service.tick();
  f.run({ ref: { id: "another-run", provider: { appId: "other.agent", installationId: "opaque", key: "default" } } });
  await f.service.tick(); expect((await f.service.local("alice", f.wait.id)).reason).toBe("unknown_admission");
  expect(f.manager.resumeTaskBarrier).toHaveBeenCalledTimes(1); expect(f.manager.finishDecision).not.toHaveBeenCalled();
});
it("withdraws a cancelled task question without reviving execution and isolates private waits", async () => {
  const f = await fixture(); await f.service.tick(); f.record.decisionGeneration = 1; await f.service.tick();
  expect(f.row().state).toBe("withdrawn"); expect((await f.service.local("alice", f.wait.id)).cancellationSettled).toBe(true);
  expect(f.manager.resumeTaskBarrier).not.toHaveBeenCalled();
  await expect(f.service.local("bob", f.wait.id)).rejects.toMatchObject({ status: 404 });
});
it("does not import old native-question waits and rejects native registration", async () => {
  const f = await fixture(); await mkdir(path.join(f.root, "decision-waits"), { recursive: true });
  await writeFile(path.join(f.root, "decision-waits", "a".repeat(64) + ".json"), JSON.stringify({ version: 1, id: "a".repeat(64) }));
  expect((await new DecisionWaitStore(f.root).list()).map(row => row.id)).toEqual([f.wait.id]);
  await expect(f.service.register(f.record, f.wait.event)).rejects.toMatchObject({ code: "provider_owned_decision" });
});
