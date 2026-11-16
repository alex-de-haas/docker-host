import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DecisionClient, type DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionsService } from "./service.js";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import type { AgentRunSnapshot } from "@hosty-sdk/app/agent";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-input-provider-boundary-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const record = { id: randomUUID(), createdBy: "owner", taskExecutionId: randomUUID(), harnessKind: "agent", status: "running",
    harnessSessionId: randomUUID(), providerExecution: { selection: { provider: { appId: "independent.agent", installationId: "one", key: "native" },
      connection: { id: "account", revision: "1" } }, session: { configurationDigest: "a".repeat(64) } } } as SessionRecord;
  let snapshot = { ref: { id: "original", provider: { appId: "independent.agent", installationId: "one", key: "native" } },
    state: "running", phase: "executing", stopConfirmed: false, freshness: "current", pending: [] } as unknown as AgentRunSnapshot;
  const rows = new Map<string, DecisionRecord>();
  const client = new DecisionClient(async () => { throw new Error("Unexpected external request"); });
  client.create = vi.fn(async input => {
    const existing = [...rows.values()].find(row => row.input?.correlationKey === input.input.correlationKey); if (existing) return structuredClone(existing);
    const row: DecisionRecord = { id: randomUUID(), userId: "owner", sequence: 1, revision: 1, sourceAppId: "consumer", sourceInstallation: "one", sourcePrincipal: "app",
      correlationHash: "hash", input: input.input, state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null, delivery: null, continuation: null };
    rows.set(row.id, row); return structuredClone(row);
  });
  client.get = vi.fn(async id => structuredClone(rows.get(id)!));
  client.responses = vi.fn(async () => ({ items: [...rows.values()].filter(row => row.resolution && !row.delivery?.receivedAt).map(row => structuredClone(row)), pendingCount: 0, cursor: null }));
  client.resolve = vi.fn(async (id, input) => {
    const row = rows.get(id)!; row.state = "answered"; row.revision++;
    row.resolution = { revision: row.revision, userId: "owner", principalId: "owner", answers: input.answers, answeredAt: new Date().toISOString() };
    row.delivery = { resolutionRevision: row.revision, receivedAt: null }; row.continuation = { revision: 1, commandId: null, state: "pending", updatedAt: row.createdAt };
    return structuredClone(row);
  });
  client.acknowledge = vi.fn(async id => { const row = rows.get(id)!; row.delivery!.receivedAt = new Date().toISOString(); row.continuation!.state = "received"; return structuredClone(row); });
  client.withdraw = vi.fn(async id => { const row = rows.get(id)!; row.state = "withdrawn"; return structuredClone(row); });
  client.invalidate = vi.fn(async id => { const row = rows.get(id)!; row.state = "stale"; return structuredClone(row); });
  client.continuation = vi.fn(async (id, input) => { const row = rows.get(id)!;
    expect(input.expectedRevision).toBe(row.continuation!.revision); row.continuation = { ...row.continuation!, revision: input.expectedRevision + 1,
      commandId: input.commandId, state: input.state, reason: input.reason ?? null }; return structuredClone(row); });
  const manager = { store: { dataDir: directory }, getSession: vi.fn(async () => record), checkDecision: vi.fn(async () => {}),
    recordDecisionAnswer: vi.fn(async () => {}), decisionProjections: vi.fn(async () => ({ items: [] })),
    advanceTaskBarrier: vi.fn(async () => { if (snapshot.phase === "parked" && snapshot.stopConfirmed) record.taskBarrier!.state = "parked"; }),
    resumeTaskBarrier: vi.fn(async () => { record.decisionRunIds = { [record.taskBarrier!.commandId]: "resumed" }; snapshot = { ...snapshot, ref: { ...snapshot.ref, id: "resumed" }, phase: "executing", stopConfirmed: false }; }),
    messageReceipt: vi.fn(async () => ({ state: "accepted" })), taskCheckpoint: vi.fn(async () => snapshot), finishDecision: vi.fn(async () => {}),
    stopDecisionExecution: vi.fn(async () => { if (!snapshot.stopConfirmed) throw new Error("Process stop not confirmed"); }) };
  const services: DecisionsService[] = [];
  const open = () => { const next = new DecisionsService(manager as unknown as SessionManager, () => client); vi.spyOn(next, "kick").mockImplementation(() => {});
    next.authorize("owner", "volatile-current-authority"); services.push(next); return next; };
  const service = open(); cleanup.push(async () => { for (const instance of services) await instance.close(); });
  const request = { requestId: randomUUID(), reason: "Missing setup", questions: [{ id: "setup", header: "Setup", question: "Is setup configured?", isOther: true }] };
  const wait = await service.registerTask(record, request);
  record.decisionWaitIds = [wait.id];
  record.taskBarrier = { id: request.requestId, kind: "human_input", state: "armed", commandId: wait.commandId } as SessionRecord["taskBarrier"];
  return { directory, record, client, service, manager, request, wait, open,
    park: () => { snapshot = { ...snapshot, phase: "parked", stopConfirmed: true }; },
    answer: async (target = service) => { const value = await target.local("owner", wait.id); await target.resolve("owner", value.core!.id,
      { requestId: randomUUID(), expectedRevision: value.core!.revision, answers: { setup: { text: "Configured" } } }); } };
}

it("retains a failed task-input registration and recovers the same request after reopening", async () => {
  const f = await setup(); const original = f.client.create;
  vi.mocked(f.client.create).mockRejectedValueOnce(new Error("Core unavailable")); await f.service.tick();
  expect((await f.service.local("owner", f.wait.id)).error).toContain("Core unavailable");
  expect((await f.service.projections("owner")).items).toContainEqual(expect.objectContaining({ id: `decision-wait:${f.wait.id}`, kind: "recovery" }));
  await f.service.close(); const reopened = f.open(); f.client.create = original; await reopened.tick();
  expect((await reopened.local("owner", f.wait.id)).create.requestId).toBe(f.wait.create.requestId);
  expect((await reopened.local("owner", f.wait.id)).core?.state).toBe("pending");
  const bytes = await readFile(path.join(f.directory, "task-decision-waits-v2", f.wait.id + ".json"), "utf8");
  expect(bytes).not.toContain("volatile-current-authority");
});
it("keeps an early answer durable until the provider checkpoint proves parking", async () => {
  const f = await setup(); await f.service.tick(); await f.answer(); await f.service.tick();
  expect((await f.service.local("owner", f.wait.id)).inbox).toBeDefined(); expect(f.manager.resumeTaskBarrier).not.toHaveBeenCalled();
  f.park(); await f.service.tick(); await f.service.tick(); expect(f.manager.resumeTaskBarrier).toHaveBeenCalledTimes(1);
  expect((await f.service.local("owner", f.wait.id)).resumedRunId).toBe("resumed");
});
it("fences an answered task input after cancellation without starting another run", async () => {
  const f = await setup(); await f.service.tick(); f.park(); await f.service.tick(); await f.answer(); f.record.decisionGeneration = 1;
  await f.service.tick(); expect(f.manager.resumeTaskBarrier).not.toHaveBeenCalled();
  expect((await f.service.local("owner", f.wait.id)).cancellationSettled).toBe(true);
});
it("retains an unknown stop and its cleanup fence", async () => {
  const f = await setup(); await f.service.tick(); await f.answer(); f.record.decisionGeneration = 1; await f.service.tick();
  expect(f.manager.resumeTaskBarrier).not.toHaveBeenCalled(); expect(f.manager.finishDecision).not.toHaveBeenCalled();
  expect(await f.service.local("owner", f.wait.id)).toMatchObject({ state: "cancelled", reason: "unknown_stop" });
});
it("replays only the original task-input arguments and rejects changed requests", async () => {
  const f = await setup(); const replay = await f.service.registerTask(f.record, f.request);
  expect(replay.id).toBe(f.wait.id); expect(replay.create.requestId).toBe(f.wait.create.requestId);
  await expect(f.service.registerTask(f.record, { ...f.request, reason: "Different input" })).rejects.toMatchObject({ code: "request_conflict" });
});
