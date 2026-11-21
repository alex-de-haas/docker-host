import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAppSession } from "../app-session.js";
import { providerDecisionCardId, transcriptRunId } from "../agent-providers/decision-identity.js";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";

vi.mock("../app-session.js", async original => ({ ...await original<typeof import("../app-session.js")>(), resolveAppSession: vi.fn() }));

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.restoreAllMocks();
});

async function started(history = false) {
  const f = await publicProviderFixture(history);
  fixtures.push(f);
  const chat = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(chat.id, "Original prompt", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const first = f.starts[0]!;
  return { f, chat, first };
}

async function freshChoice(f: PublicProviderFixture, id: string) {
  const options = await f.manager.contextOptions(id, f.owner, f.credential);
  const target = options.connections[0]!;
  return { requestId: randomUUID(), expectedRevision: options.selectionRevision, connectionId: target.id,
    expectedBinding: target.bindingRevision, mode: "fresh", model: "model", reasoningEffort: null };
}

it("routes late installation history to the archived native context before and after Harness restarts", async () => {
  const { f, chat, first } = await started(true);
  f.complete(first.runId, "Original answer");
  await vi.waitFor(async () => expect((await f.store.readRecord(chat.id))?.status).toBe("idle"));
  const changed = await f.manager.changeContext(chat.id, f.owner, f.credential, await freshChoice(f, chat.id));
  await f.manager.postMessage(chat.id, "New context prompt", f.credential, [], {
    actorUserId: f.owner, selectionRevision: changed.selectionRevision, clientRequestId: randomUUID(),
  });
  const second = f.starts[1]!;
  expect(second.sessionId).not.toBe(first.sessionId);
  const card = randomUUID();
  const publish = (sequence: number, message: string) => {
    const old = f.snapshot(first.runId);
    old.lastSequence = String(BigInt(old.lastSequence) + BigInt(sequence));
    old.revision = String(BigInt(old.revision) + BigInt(sequence));
    old.cursor = "cursor-" + old.lastSequence;
    old.result = { status: "succeeded", messageId: "repair-" + sequence, text: message };
    old.decisions = [{ decision: { id: card, revision: "1", kind: "approval", delivery: "continue_run",
      title: "Previously resolved action", toolName: "Read" }, state: "resolved", response: { kind: "approval", decision: "allow" } }];
    f.publishHistory(first.sessionId, first.runId, f.owner, { kind: "snapshot", snapshot: old });
  };
  const assertEvidence = async (text: string) => {
    const log = await f.store.readEvents(chat.id);
    const repaired = log.filter(event => event.text === text);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ providerHistoryEarlier: true,
      providerSource: { runId: first.runId, generation: f.snapshot(first.runId).generation } });
    const active = await f.store.readProviderExecution(chat.id);
    expect(active).toMatchObject({ runId: second.runId, sessionId: second.sessionId, run: { state: "running", pending: [] } });
    expect((await f.store.readRecord(chat.id))?.status).toBe("running");
  };

  publish(1, "Report received from the previous context");
  await vi.waitFor(() => assertEvidence("Report received from the previous context"), { timeout: 5000 });
  await f.manager.shutdown();
  publish(2, "Previous context evidence received during restart");
  const reopened = f.makeManager();
  await reopened.manager.recoverProviderRuns();
  await vi.waitFor(() => assertEvidence("Previous context evidence received during restart"), { timeout: 5000 });
  const history = await reopened.store.readEvents(chat.id);
  expect(history.filter(event => event.type === "approval_request" && event.approvalId === providerDecisionCardId(first.runId, card)))
    .toMatchObject([{ providerHistoryEarlier: true, providerSource: { runId: first.runId } }]);
  await reopened.manager.refreshSessionCredentials(chat.id, f.owner, f.credential);
  expect(await reopened.manager.resolveApproval(chat.id, providerDecisionCardId(first.runId, card), "allow", undefined, f.owner)).toBe(false);
  expect(f.starts).toHaveLength(2);
  expect(f.controls).toHaveLength(0);
  expect(f.authorizations.some(operation => operation.operation === "runs.respond")).toBe(false);
});

it("reads old unqualified archives only for their original installation and session", async () => {
  const { f, chat, first } = await started();
  const old = f.snapshot(first.runId), runId = randomUUID();
  old.ref.id = runId;
  const directory = path.join(f.store.dataDir, "sessions", chat.id, "provider-history");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, runId + ".json"), JSON.stringify({ principalId: f.owner, snapshot: old }));
  const original = { provider: old.ref.provider, sessionId: first.sessionId };
  const replacement = { provider: { ...old.ref.provider, installationId: "replacement" }, sessionId: first.sessionId };
  expect((await f.store.readHistoryRun(chat.id, runId, original))?.snapshot).toEqual(old);
  expect(await f.store.readHistoryRun(chat.id, runId, replacement)).toBeNull();
  const fresh = { ...old, ref: { ...old.ref, provider: replacement.provider }, generation: randomUUID() };
  await f.store.saveHistoryRun(chat.id, f.owner, fresh);
  expect((await f.store.readHistoryRun(chat.id, runId, original))?.snapshot).toEqual(old);
  expect((await f.store.readHistoryRun(chat.id, runId, replacement))?.snapshot).toEqual(fresh);
  expect(await f.store.readHistoryRun(chat.id, runId)).toBeNull();
  await expect(f.store.saveHistoryRun(chat.id, f.owner, { ...fresh, generation: randomUUID() })).rejects.toThrow("generation");
});

it("isolates reused run and decision IDs in an archived session and its replacement", async () => {
  const { f, chat, first } = await started(true);
  f.complete(first.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(chat.id))?.status).toBe("idle"));
  const choice = await freshChoice(f, chat.id);
  const changed = await f.manager.changeContext(chat.id, f.owner, f.credential, choice);
  await f.manager.postMessage(chat.id, "New turn", f.credential, [], { actorUserId: f.owner,
    selectionRevision: changed.selectionRevision, clientRequestId: randomUUID() });
  const current = f.starts[1]!, decision = { id: "same-decision", revision: "1", kind: "approval" as const,
    delivery: "continue_run" as const, toolName: "Read", title: "Current approval" };
  f.update(current.runId, { state: "waiting_for_input", phase: "waiting", pending: [decision],
    messages: [{ id: "same-message", role: "assistant", text: "Current message", state: "complete" }] });
  await vi.waitFor(async () => expect((await f.store.readEvents(chat.id)).some(event => event.text === "Current message")).toBe(true));
  const historical = f.snapshot(first.runId);
  historical.ref.id = current.runId;
  historical.messages = [{ id: "same-message", role: "assistant", text: "Archived message", state: "complete" }];
  historical.decisions = [{ decision, state: "resolved", response: { kind: "approval", decision: "deny" } }];
  f.publishHistory(first.sessionId, current.runId, f.owner, { kind: "snapshot", snapshot: historical });
  const legacyCard = providerDecisionCardId(current.runId, decision.id);
  const currentCard = providerDecisionCardId(transcriptRunId(current.runId, choice.requestId), decision.id);
  await vi.waitFor(async () => {
    const log = await f.store.readEvents(chat.id);
    expect(log.filter(event => event.text === "Current message" || event.text === "Archived message")).toHaveLength(2);
    expect(log.find(event => event.text === "Archived message")?.providerHistoryEarlier).toBe(true);
    expect(log.some(event => event.approvalId === legacyCard && event.type === "approval_decision")).toBe(true);
    expect(log.some(event => event.approvalId === currentCard && event.type === "approval_request")).toBe(true);
    expect((await f.store.readHistoryRun(chat.id, current.runId, { provider: f.provider, sessionId: current.sessionId }))?.snapshot.generation).toBe(f.snapshot(current.runId).generation);
    expect((await f.store.readHistoryRun(chat.id, current.runId, { provider: f.provider, sessionId: first.sessionId }))?.snapshot.generation).toBe(historical.generation);
  });
  expect(await f.store.readHistoryRun(chat.id, current.runId)).toBeNull();
  expect(await f.manager.resolveApproval(chat.id, legacyCard, "allow", undefined, f.owner)).toBe(false);
  expect(f.authorizations.some(op => op.operation === "runs.respond")).toBe(false);
  expect(await f.manager.resolveApproval(chat.id, currentCard, "allow", undefined, f.owner)).toBe(true);
  expect(f.authorizations.filter(op => op.operation === "runs.respond").at(-1)?.runId).toBe(current.runId);
});

it.each(["verified", "missing", "unavailable"] as const)("handles a queued owner send after reinstallation when native continuity is %s", async evidence => {
  const { f, chat, first } = await started();
  f.complete(first.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(chat.id))?.status).toBe("idle"));
  vi.mocked(resolveAppSession).mockResolvedValue({ status: "active", identity: { userId: f.owner, hostRole: "host.admin" } });
  f.capabilities.capabilities.push("session.reconnect");
  f.provider.installationId = "new-provider-installation";
  if (evidence === "missing") f.sessions.clear();
  if (evidence === "unavailable") f.behavior.failSessionLookup = true;
  const text = "Explicit queued message", entryId = randomUUID();
  const receipt = await f.manager.messageQueueCommand(chat.id, f.owner, {
    requestId: randomUUID(), expectedRevision: (await f.manager.messageQueue(chat.id, f.owner)).revision,
    command: { type: "enqueue", text, entryId, attachments: [] },
  }, f.credential);
  expect(receipt.queue.entries[0]).toMatchObject({ id: entryId, text });
  if (evidence === "verified") {
    await vi.waitFor(async () => {
      expect((await f.manager.messageQueue(chat.id, f.owner)).entries).toHaveLength(0);
      expect(f.starts).toHaveLength(2);
    });
    expect(f.starts[1]).toMatchObject({ sessionId: first.sessionId, input: { continuation: "resume", input: { text } } });
    const current = await f.store.readRecord(chat.id);
    expect(current?.selection?.provider.installationId).toBe(f.provider.installationId);
    expect((await f.store.readEvents(chat.id)).filter(event => event.contextChanged)).toMatchObject([{ contextMode: "resume" }]);
    expect(f.requests.filter(r => r.method === "PUT" && r.path.includes("/configurations/") && r.body.includes("session.reconnect"))).toHaveLength(1);
  } else {
    await vi.waitFor(async () => {
      const queue = await f.manager.messageQueue(chat.id, f.owner);
      expect(queue.paused).toBe(true);
      expect(queue.entries[0]).toMatchObject({ id: entryId, text, state: "failed" });
    });
    expect((await f.store.readRecord(chat.id))?.selection?.provider.installationId).toBe("installation-one");
    expect((await f.store.readEvents(chat.id)).filter(event => event.contextChanged || event.text === text)).toEqual([]);
    expect(f.starts).toHaveLength(1);
  }
});

it("keeps the original run and selection when a fresh context is requested during an active turn", async () => {
  const { f, chat, first } = await started();
  await expect(f.manager.changeContext(chat.id, f.owner, f.credential, await freshChoice(f, chat.id)))
    .rejects.toMatchObject({ code: "context_change_blocked" });
  expect(await f.store.readProviderExecution(chat.id)).toMatchObject({ runId: first.runId, sessionId: first.sessionId });
  expect((await f.store.readEvents(chat.id)).some(event => event.contextChanged)).toBe(false);
  expect(f.starts).toHaveLength(1);
  expect(f.controls).toHaveLength(0);
});
