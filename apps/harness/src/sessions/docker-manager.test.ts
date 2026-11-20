import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { publicProviderFixture, type PublicProviderFixture } from "../agent-providers/test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(options: { predictions?: boolean } = {}) {
  const f = await publicProviderFixture(); fixtures.push(f);
  if (options.predictions) f.capabilities.capabilities.push("predictions");
  const session = await f.manager.createSession({ createdBy: f.owner, connectionId: f.connectionId,
    executionSelection: { model: "model", reasoningEffort: null } });
  return { ...f, session, async send(text = "Perform the work", predictions = false) {
    return f.manager.postMessage(session.id, text, f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID(), promptSuggestions: predictions });
  } };
}
it("submits the selected model through the public provider without a consumer filesystem path", async () => {
  const f = await fixture(); await f.send();
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.input).toMatchObject({ continuation: "start", selection: { model: "model", reasoningEffort: null }, input: { text: "Perform the work" } });
  expect(f.starts[0]!.body).not.toContain(f.root);
  expect(f.requests.filter(request => request.path.startsWith("/v1/"))).toEqual([]);
  expect(f.authorizations.some(request => request.operation === "runs.start")).toBe(true);
});

it("keeps an available answer separate from authoritative native exit", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  f.complete(runId, "The answer is ready", false);
  await vi.waitFor(async () => expect((await f.store.readEvents(f.session.id)).some(event => event.type === "assistant_text")).toBe(true));
  expect((await f.manager.getSession(f.session.id))?.status).toBe("running");
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "result")).toEqual([]);
  f.update(runId, { state: "succeeded", phase: "terminal", stopConfirmed: true });
  await vi.waitFor(async () => expect((await f.manager.getSession(f.session.id))?.status).toBe("idle"));
  const events = await f.store.readEvents(f.session.id);
  expect(events.filter(event => event.type === "assistant_text")).toHaveLength(1);
  expect(events.filter(event => event.type === "result")).toHaveLength(1);
});

it("preserves the provider's actionable terminal failure", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  f.update(runId, { state: "failed", phase: "terminal", stopConfirmed: true,
    result: { status: "failed", error: { code: "native_failed", message: "Refresh the configured provider account.", retryable: false } } });
  await vi.waitFor(async () => expect((await f.manager.getSession(f.session.id))?.status).toBe("failed"));
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "error")).toEqual([
    expect.objectContaining({ message: "Refresh the configured provider account." }),
  ]);
});

it("recovers append-before-cursor failures without duplicating terminal text or starting another execution", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  const committed = f.store.commitProviderObservation.bind(f.store);
  let rejected = false;
  vi.spyOn(f.store, "commitProviderObservation").mockImplementation(async (id, value) => {
    if (value.run?.stopConfirmed && !rejected) { rejected = true; throw new Error("Temporary projection checkpoint failure"); }
    return committed(id, value);
  });
  f.complete(runId, "Persist exactly once");
  await vi.waitFor(async () => expect((await f.store.readProviderExecution(f.session.id))?.run?.stopConfirmed).toBe(true));
  const events = await f.store.readEvents(f.session.id);
  expect(events.filter(event => event.type === "assistant_text" && event.text === "Persist exactly once")).toHaveLength(1);
  expect(events.filter(event => event.type === "result")).toHaveLength(1);
  expect(f.starts).toHaveLength(1);
});

it("retains command outcomes across snapshot replacement and consumer restart", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  f.update(runId, { tools: [{ id: "command", name: "Bash", input: { command: "test" }, state: "completed",
    command: { status: "completed", exitCode: 0, durationMs: 20, summary: "3 passed" } }] });
  await vi.waitFor(async () => expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "command_result")).toHaveLength(1));
  await f.manager.shutdown();
  const next = f.makeManager();
  await next.manager.refreshSessionCredentials(f.session.id, f.owner, f.credential);
  await vi.waitFor(async () => expect((await next.store.readProviderExecution(f.session.id))?.run?.tools?.[0]?.command?.exitCode).toBe(0));
  f.complete(runId);
  await vi.waitFor(async () => expect((await next.manager.getSession(f.session.id))?.status).toBe("idle"));
  expect((await next.store.readEvents(f.session.id)).filter(event => event.type === "command_result")).toEqual([
    expect.objectContaining({ status: "completed", exitCode: 0, summary: "3 passed" }),
  ]);
  expect(f.starts).toHaveLength(1);
});

it("keeps received history when a bounded snapshot omits earlier items", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  f.update(runId, { messages: [{ id: "first", role: "assistant", state: "complete", text: "Earlier received text" }] });
  await vi.waitFor(async () => expect((await f.store.readEvents(f.session.id)).some(event => event.text === "Earlier received text")).toBe(true));
  f.update(runId, { messages: [], tools: [], coverage: { messages: "truncated", tools: "truncated" } });
  await vi.waitFor(async () => expect((await f.store.readProviderExecution(f.session.id))?.cursor).toBe(f.snapshot(runId).cursor));
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "notice" && String(event.message).includes("incomplete"))).toEqual([]);
  expect((await f.store.readEvents(f.session.id)).some(event => event.text === "Earlier received text")).toBe(true);
});

it("does not mistake a child result for the root execution's completion", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  f.emit(runId, "result.available", { result: { status: "succeeded", text: "Child finished" } }, { agentId: "child", parentAgentId: "root" });
  f.update(runId, { phase: "executing", state: "running", stopConfirmed: false });
  await vi.waitFor(async () => expect((await f.store.readProviderExecution(f.session.id))?.cursor).toBe(f.snapshot(runId).cursor));
  expect((await f.manager.getSession(f.session.id))?.status).toBe("running");
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "result")).toEqual([]);
});

it("projects external question answers from the authoritative decision snapshot", async () => {
  const f = await fixture(); await f.send(); const runId = f.starts[0]!.runId;
  const decision = { id: "question", revision: "1", kind: "question" as const, delivery: "continue_run" as const,
    questions: [{ id: "choice", text: "Which option?", options: [{ id: "one", label: "One" }] }] };
  f.update(runId, { state: "waiting_for_input", phase: "waiting", pending: [decision] });
  await vi.waitFor(async () => expect((await f.manager.getSession(f.session.id))?.status).toBe("awaiting_question"));
  f.update(runId, { state: "running", phase: "executing", pending: [],
    decisions: [{ decision, state: "resolved", response: { kind: "question", answers: { choice: "One" } } }] });
  await vi.waitFor(async () => {
    expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "question_answered")).toHaveLength(1);
    expect((await f.manager.getSession(f.session.id))?.status).toBe("running");
  });
});

it("preserves optional prediction history through the public extension stream", async () => {
  const f = await fixture({ predictions: true }); await f.send("Answer the question", true); const runId = f.starts[0]!.runId;
  f.update(runId, { messages: [{ id: "answer", role: "assistant", state: "complete", text: "Answer" }] });
  f.emit(runId, "extension", { namespace: "hosty.agent.answer", name: "answer.complete" });
  await vi.waitFor(async () => expect((await f.manager.getSession(f.session.id))?.status).toBe("suggesting"));
  f.emit(runId, "extension", { namespace: "hosty.agent.predictions", name: "predictions", text: "Continue?" });
  await vi.waitFor(async () => expect((await f.store.readEvents(f.session.id)).some(event => event.type === "prompt_suggestion_created")).toBe(true));
  f.complete(runId, "Answer");
  await vi.waitFor(async () => expect((await f.manager.getSession(f.session.id))?.status).toBe("idle"));
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "prompt_suggestion_created")).toEqual([
    expect.objectContaining({ text: "Continue?", attemptId: runId }),
  ]);
});
