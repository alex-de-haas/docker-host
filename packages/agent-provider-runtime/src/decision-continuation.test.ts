import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import type { ProviderAuthority } from "./core.js";
import { syncDecisionDeliveries } from "./decision-continuation.js";
import { responseFromDecision } from "./native-driver.js";
import { questionAnswers } from "./decision-answers.js";
import type { AgentPendingDecision } from "@hosty-sdk/app/agent";
import type { DecisionContinue, DecisionRecord } from "@hosty-sdk/app/decisions";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(nextTurn = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-decision-progress-")); roots.push(root);
  const provider = { appId: "unrelated.provider", installationId: "installation", key: "default" }, store = new ProviderStore(root, provider); await store.initialize();
  const actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "unrelated.consumer", callerInstallation: "consumer", admissionRef: "original-authority", operation: "runs.respond", provider };
  const sid = randomUUID(); await store.create(sid, actor, "{}", { configuration: { connection: { id: "account", revision: "1" } } }, { configuration: { connection: { id: "account", revision: "1" } }, digest: "opaque", resolvedSkills: [] });
  const session = await store.load(sid), runId = randomUUID(), run = store.makeRun(session, runId, actor, "{}"); session.runs[runId] = run;
  run.snapshot.state = "running"; run.snapshot.phase = "executing";
  const requestId = randomUUID(), coreId = randomUUID();
  run.controls[requestId] = { hash: "request", receipt: { requestId, generation: run.snapshot.generation, revision: "1", state: "applied" } as never };
  let reservedId: string | undefined;
  if (nextTurn) { reservedId = randomUUID(); const reserved = store.makeRun(session, reservedId, actor, ""); reserved.snapshot.stopConfirmed = true; session.runs[reservedId] = reserved;
    run.controls[requestId]!.receipt.continuation = { run: reserved.snapshot.ref, state: "awaiting_authorization" }; }
  run.decisionDeliveries = { [coreId]: { decisionId: coreId, resolutionRevision: 2, commandId: randomUUID(), submitted: true,
    input: { requestId, expectedGeneration: run.snapshot.generation, expectedRevision: "1", decisionId: "public-decision", decisionRevision: "1", response: { kind: "question", answers: { q: "yes" } } } } };
  await store.save(session);
  let remote = { id: coreId, state: "answered", continuation: { revision: 1, commandId: null, state: "received" } } as unknown as DecisionRecord;
  const history: DecisionContinue[] = [], replays = new Map<string, DecisionRecord>(); let lose = false;
  const client = { acknowledge: vi.fn(async () => structuredClone(remote)), get: vi.fn(async () => structuredClone(remote)), continuation: vi.fn(async (_id: string, input: DecisionContinue) => {
    history.push(structuredClone(input)); const old = replays.get(input.requestId); if (old) return structuredClone(old);
    expect(input.expectedRevision).toBe(remote.continuation!.revision); if (remote.continuation!.commandId) expect(input.commandId).toBe(remote.continuation!.commandId);
    const allowed: Record<string,string[]> = { received: ["blocked","admitted","failed","cancelled"], blocked: ["blocked","admitted","failed","cancelled"], admitted: ["running","failed","blocked","cancelled"], running: ["completed","failed","blocked","cancelled"] };
    expect(allowed[remote.continuation!.state]).toContain(input.state);
    remote = { ...remote, continuation: { revision: remote.continuation!.revision + 1, state: input.state, commandId: input.commandId, updatedAt: new Date().toISOString(), reason: input.reason } }; replays.set(input.requestId, structuredClone(remote));
    if (lose) { lose = false; throw new Error("Metadata response lost after commit"); } return structuredClone(remote);
  }) };
  const authority = { decisions: vi.fn(() => client) } as unknown as ProviderAuthority, controller = { respond: vi.fn() } as unknown as ProviderController;
  return { store, runId, reservedId, sid, requestId, coreId, client, history, controller, authority, remote: () => remote, lose: () => { lose = true; }, sync: () => syncDecisionDeliveries(store, controller, authority, runId) };
}
it("reports ordered native continuation stages through confirmed completion without repeating SDK delivery", async () => {
  const f = await fixture(); await f.sync(); expect(f.history.map(x => x.state)).toEqual(["admitted","running"]);
  const { session, record } = await f.store.run(f.runId); record.snapshot.state = "succeeded"; record.snapshot.stopConfirmed = true; await f.store.save(session);
  await f.sync(); expect(f.remote().continuation!.state).toBe("completed"); const count = f.history.length; await f.sync(); expect(f.history).toHaveLength(count);
  expect(f.controller.respond).not.toHaveBeenCalled();
});
it("keeps next-turn answers blocked until fresh consumer authorization and follows the reserved run", async () => {
  const f = await fixture(true); await f.sync(); expect(f.remote().continuation).toMatchObject({ state: "blocked", reason: "missing_authority" });
  const { session, record } = await f.store.run(f.runId); record.controls[f.requestId]!.receipt.continuation!.state = "admitted";
  session.runs[f.reservedId!]!.snapshot.stopConfirmed = false; await f.store.save(session);
  await f.sync(); expect(f.remote().continuation!.state).toBe("admitted");
  const fresh = await f.store.run(f.reservedId!); fresh.record.snapshot.state = "running"; fresh.record.snapshot.phase = "executing"; await f.store.save(fresh.session);
  await f.sync(); expect(f.remote().continuation!.state).toBe("running");
});
it("recovers a lost metadata response using the same durable UUID and exact expected revision", async () => {
  const f = await fixture(); f.lose(); await expect(f.sync()).rejects.toThrow("lost");
  expect((await f.store.run(f.runId)).record.decisionDeliveries![f.coreId]!.report).toEqual(f.history[0]);
  await f.sync(); expect(f.history[1]).toEqual(f.history[0]); expect(f.remote().continuation!.state).toBe("running"); expect(f.controller.respond).not.toHaveBeenCalled();
});
it("never reports completion for an uncertain native response", async () => {
  const f = await fixture(), { session, record } = await f.store.run(f.runId); record.controls[f.requestId]!.receipt.state = "unknown"; await f.store.save(session);
  await f.sync(); expect(f.remote().continuation).toMatchObject({ state: "blocked", reason: "unknown_admission" });
});
it("preserves Core question IDs, multiple stable choice IDs and free-text answers", () => {
  const pending: AgentPendingDecision = { id: "decision", revision: "1", kind: "question", delivery: "continue_run", questions: [
    { id: "one", text: "Same question", multiple: true, allowText: false, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { id: "two", text: "Same question", allowText: true } ] };
  const response = responseFromDecision(pending, { one: { optionIds: ["a","b"] }, two: { text: "Independent answer" } });
  expect(response).toEqual({ kind: "question", answers: { one: ["a","b"], two: "Independent answer" } });
  expect(questionAnswers(pending, response)).toEqual({ one: "A, B", two: "Independent answer" });
});

it("keeps repeated option labels distinct and refuses ambiguous label-only answers", () => {
  const pending: AgentPendingDecision = { id: "q", revision: "1", kind: "question", delivery: "continue_run", questions: [{ id: "q", text: "Pick", multiple: true, allowText: false, options: [{ id: "first", label: "Same" }, { id: "second", label: "Same" }] }] };
  expect(questionAnswers(pending, responseFromDecision(pending, { q: { optionIds: ["first","second"] } }))).toEqual({ q: "Same [first], Same [second]" });
  expect(() => questionAnswers(pending, { kind: "question", answers: { q: "Same" } })).toThrow("stable option ID");
});
it("refreshes only a definitively rejected unadmitted CAS, retaining the old request bytes", async () => {
  const f = await fixture(), value = await f.store.run(f.runId), delivery = value.record.decisionDeliveries![f.coreId]!;
  delete delivery.submitted; delete value.record.controls[f.requestId]; value.record.snapshot.revision = "2";
  value.record.snapshot.pending = [{ id: "public-decision", revision: "1", kind: "question", delivery: "continue_run", questions: [{ id: "q", text: "Continue?" }] }]; await f.store.save(value.session);
  const original = structuredClone(delivery.input);
  const actual = new ProviderController(f.store, f.authority, {} as never, fixtureCapabilities);
  const delivered = vi.fn(async () => {}); actual.driver = { respond: delivered } as never;
  await syncDecisionDeliveries(f.store, actual, f.authority, f.runId); const retry = (await f.store.run(f.runId)).record.decisionDeliveries![f.coreId]!;
  expect(retry.previousInputs).toEqual([original]); expect(retry.input.requestId).not.toBe(original.requestId); expect(retry.input.expectedRevision).toBe("2");
  expect(retry.rejected).toBeUndefined(); expect(f.client.acknowledge).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
});
it("withdraws a linked Core question answered through the public API while native execution continues", async () => {
  const f = await fixture(), value = await f.store.run(f.runId); delete value.record.decisionDeliveries;
  value.record.decisionLinks = { "public-decision": f.coreId }; value.record.snapshot.pending = []; await f.store.save(value.session);
  vi.mocked(f.client.get).mockResolvedValue({ id: f.coreId, revision: 3, state: "pending" } as DecisionRecord);
  const withdraw = vi.fn(async () => ({})); Object.assign(f.client, { withdraw });
  await f.sync(); expect(withdraw).toHaveBeenCalledWith(f.coreId, expect.objectContaining({ expectedRevision: 3 }));
  await f.sync(); expect(withdraw).toHaveBeenCalledOnce(); expect((await f.store.run(f.runId)).record.snapshot.stopConfirmed).toBe(false);
});
