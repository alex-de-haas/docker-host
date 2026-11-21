import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); });

async function started() {
  const f = await publicProviderFixture(); fixtures.push(f);
  const chat = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(chat.id, "Earlier private history", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const first = f.starts[0]!;
  f.complete(first.runId);
  await vi.waitFor(async () => expect((await f.store.readRecord(chat.id))?.providerStopProof?.runId).toBe(first.runId));
  await vi.waitFor(async () => expect((await f.store.readProviderExecution(chat.id))?.run?.stopConfirmed).toBe(true));
  const options = await f.manager.contextOptions(chat.id, f.owner, f.credential);
  const target = options.connections[0]!;
  const choice = { requestId: randomUUID(), mode: "fresh", connectionId: target.id, expectedBinding: target.bindingRevision,
    expectedRevision: options.selectionRevision, model: "model", reasoningEffort: null };
  return { ...f, chat, first, choice };
}

it("switches models in the same conversation only after confirmation and starts a separate native session on Send", async () => {
  const f = await started();
  const old = await f.store.readProviderExecution(f.chat.id);
  const next = await f.manager.changeContext(f.chat.id, f.owner, f.credential, f.choice);
  expect(next.providerExecution?.sessionId).not.toBe(old?.sessionId);
  expect(next.executionSelection?.model).toBe("model");
  expect(f.starts).toHaveLength(1);
  expect(await f.manager.changeContext(f.chat.id, f.owner, f.credential, f.choice)).toMatchObject({ selectionRevision: 1 });
  expect((await f.store.readEvents(f.chat.id)).filter(event => event.contextChanged)).toHaveLength(1);
  await f.manager.shutdown();
  const { manager, store } = f.makeManager();
  await expect(manager.changeContext(f.chat.id, f.owner, f.credential, { ...f.choice, model: null })).rejects.toMatchObject({ code: "context_request_conflict" });
  await manager.postMessage(f.chat.id, "Only this new message", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID(), selectionRevision: 1 });
  expect(f.starts).toHaveLength(2);
  expect(f.starts[1]!).toMatchObject({ sessionId: next.providerExecution!.sessionId, input: { continuation: "start", input: { text: "Only this new message" }, selection: { model: "model" } } });
  expect(f.starts[1]!.body).not.toContain("Earlier private history");
  expect((await store.readEvents(f.chat.id)).some(event => event.text === "Earlier private history")).toBe(true);
  // A delayed write from the old outbox can never become the current execution.
  await store.saveProviderExecution(f.chat.id, old!);
  expect((await store.readProviderExecution(f.chat.id))?.runId).toBe(f.starts[1]!.runId);
});

it("preserves the old context on stale choice, changed account, missing confirmation and a different actor", async () => {
  const f = await started();
  const read = () => f.store.readProviderExecution(f.chat.id);
  const before = await read();
  for (const [change, code] of [[{ expectedRevision: 8 }, "selection_conflict"], [{ expectedBinding: "a".repeat(64) }, "provider_connection_changed"],
    [{ mode: "resume" }, "native_context_missing"], [{ mode: "" }, "context_choice_invalid"]] as const)
    await expect(f.manager.changeContext(f.chat.id, f.owner, f.credential, { ...f.choice, ...change })).rejects.toMatchObject({ code });
  await expect(f.manager.changeContext(f.chat.id, "other-user", f.credential, f.choice)).rejects.toThrow();
  expect(await read()).toEqual(before);
  expect(f.starts).toHaveLength(1);
});

it("allows explicit fresh start after a wiped installation and rejects the old reviewed target", async () => {
  const f = await started();
  f.provider.installationId = "reinstalled";
  f.sessions.clear(); f.runs.clear();
  const options = await f.manager.contextOptions(f.chat.id, f.owner, f.credential);
  const replacement = options.connections[0]!;
  expect(replacement.id).toBe(f.choice.connectionId);
  expect(replacement.bindingRevision).not.toBe(f.choice.expectedBinding);
  expect(replacement.canResume).toBe(false);
  await expect(f.manager.changeContext(f.chat.id, f.owner, f.credential, f.choice)).rejects.toMatchObject({ code: "provider_connection_changed" });
  const next = await f.manager.changeContext(f.chat.id, f.owner, f.credential, { ...f.choice, expectedBinding: replacement.bindingRevision });
  expect(next.selection!.provider.installationId).toBe("reinstalled");
  expect(next.providerExecution!.sessionId).not.toBe(f.first.sessionId);
});
