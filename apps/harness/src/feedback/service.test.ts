import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FeedbackService, feedbackTurn } from "./service.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore, type StoredEvent } from "../sessions/store.js";
import { ProviderDirectory } from "../settings/providers.js";
import { DevelopmentClient } from "../sessions/development.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import type { ConnectionService } from "../connections/service.js";
import { ProfileStore } from "../profiles/store.js";
import type { FeedbackServerClient } from "@hosty-sdk/app/feedback/server";
import type { FeedbackDispatch, FeedbackDispatchInput, FeedbackDelivery, FeedbackOutcome, FeedbackReport } from "@hosty-sdk/app/feedback";
let dir: string, manager: SessionManager, service: FeedbackService, run: HarnessStartOptions;
let report: FeedbackReport, attempts: FeedbackDispatch[], directory: ProviderDirectory;
const buildManager = (development: DevelopmentClient | null = null, connections: ConnectionService | null = null, profiles: ProfileStore | null = null) => new SessionManager(new SessionStore(dir), adapter, new AuditReporter(null, null, "harness"), dir, null, directory, null, null, "http://localhost:1234", null, connections, development, null, undefined, profiles);
const sent = vi.fn();
const adapter: HarnessAdapter = { name: "controlled", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false }, probe: async () => ({ available: true }),
  start: options => { run = options; return { send: sent, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {} }; } };
const client = {
  capabilities: vi.fn(async () => ({ appId: "harness", installation: "one", userId: "owner" })),
  list: vi.fn(async () => ({ reports: [report], dispatches: attempts })),
  reserve: vi.fn(async (input: FeedbackDispatchInput) => {
    const prior = attempts.find(d => d.id === input.requestId); if (prior) { expect(input).toEqual(prior.input); return prior; }
    const d: FeedbackDispatch = { id: input.requestId, input, actorId: "owner", callerAppId: "harness", callerInstallation: "one", snapshot: [report], createdAt: "now", state: "reserved", workspaceId: null, messageSequence: null, outcomes: null, error: null }; attempts.push(d); return d;
  }),
  delivery: vi.fn(async (id: string, value: FeedbackDelivery) => {
    const d = attempts.find(a => a.id === id)!; if (["succeeded", "failed", "cancelled", "rejected"].includes(d.state)) return d;
    Object.assign(d, value); return d;
  }),
  outcomes: vi.fn(async (id: string, outcomes: FeedbackOutcome[]) => { const d = attempts.find(a => a.id === id)!; d.outcomes = outcomes; return d; }),
  image: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })),
};
beforeEach(async () => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_HTTP", "https://feedback.example.test");
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-feedback-service-")); vi.clearAllMocks(); attempts = [];
  report = { id: "a".repeat(64), revision: 1, workspaceId: null, currentAttemptId: null, disposition: null, status: "unprocessed", reporterId: "reporter", comment: "Align controls",
    context: { appId: "independent.app", appName: "App", installation: "one", version: "1.0", observedAt: "now", executionKind: "package", workspaceId: null, sourceRevision: null },
    annotations: [{ id: randomUUID(), text: "Move button", route: "/", capturedAt: "now", mediaType: "image/png" }] };
  directory = new ProviderDirectory(null, null, "harness");
  vi.spyOn(directory, "readApps").mockResolvedValue([{ id: "independent.app", displayName: "App" }]);
  manager = buildManager();
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
});
afterEach(async () => { await service.close(); await manager.shutdown(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const body = (id: string) => ({ requestId: randomUUID(), sessionId: id, workspaceId: null, reports: [{ id: report.id, revision: 1 }], instruction: "Keep the label" });
it("replays a lost acceptance reply without creating another native turn", async () => {
  const session = await manager.createSession({ createdBy: "owner" }); const input = body(session.id);
  client.delivery.mockRejectedValueOnce(new Error("Lost response after admission"));
  await expect(service.send(input, "own-app-grant", "owner")).rejects.toThrow("Lost response");
  await service.send(input, "own-app-grant", "owner"); expect(sent).toHaveBeenCalledTimes(1);
  expect((await manager.store.readEvents(session.id)).filter(e => e.type === "user_message")).toHaveLength(1);
  expect(attempts).toHaveLength(1); expect(attempts[0]!.messageSequence).toBeGreaterThan(0);
});
it("refuses a busy or foreign chat before reserving any feedback", async () => {
  const foreign = await manager.createSession({ createdBy: "other" });
  await expect(service.send(body(foreign.id), "grant", "owner")).rejects.toMatchObject({ status: 403 });
  const session = await manager.createSession({ createdBy: "owner" });
  await manager.postMessage(session.id, "Existing work", undefined, [], { clientRequestId: randomUUID(), actorUserId: "owner" });
  await expect(service.send(body(session.id), "grant", "owner")).rejects.toMatchObject({ code: "session_busy" });
  expect(client.reserve).not.toHaveBeenCalled(); expect(sent).toHaveBeenCalledTimes(1);
});
it("scopes tools to the exact prompt, records explicit results and observes terminal success", async () => {
  const session = await manager.createSession({ createdBy: "owner" });
  await expect(manager.feedbackAction!(session.id, "feedback-current", {}, "grant")).rejects.toMatchObject({ code: "feedback_prompt_unbound" });
  const attempt = await service.send(body(session.id), "grant", "owner");
  expect(await manager.feedbackAction!(session.id, "feedback-current", {}, "grant")).toMatchObject({ attemptId: attempt.id });
  await expect(manager.feedbackAction!(session.id, "feedback-image", { reportId: "foreign", annotationId: report.annotations[0]!.id }, "grant")).rejects.toMatchObject({ status: 404 });
  expect(client.image).not.toHaveBeenCalled();
  await manager.feedbackAction!(session.id, "feedback-result", { outcomes: [{ reportId: report.id, summary: "Aligned", handledAnnotationIds: report.annotations.map(n => n.id) }] }, "grant");
  expect(attempt.state).toBe("accepted");
  run.onEvent({ type: "result", status: "success" });
  await vi.waitFor(() => expect(attempt.state).toBe("succeeded"));
  await expect(manager.feedbackAction!(session.id, "feedback-result", { outcomes: [] }, "grant")).rejects.toMatchObject({ code: "feedback_prompt_unbound" });
});
it("explains recovery after cancellation and continuation, then binds a deliberate resend to a new attempt", async () => {
  const session = await manager.createSession({ createdBy: "owner" });
  const original = await service.send(body(session.id), "grant", "owner");
  await manager.cancelSession(session.id);
  await vi.waitFor(() => expect(original.state).toBe("cancelled"));
  await manager.postMessage(session.id, "Продолжай", "grant", [], { clientRequestId: randomUUID(), actorUserId: "owner", promptSuggestions: false });
  const imageInput = { reportId: report.id, annotationId: report.annotations[0]!.id };
  const outcomes = [{ reportId: report.id, summary: "Aligned", handledAnnotationIds: report.annotations.map(n => n.id), handled: true }];
  for (const [action, input] of [["feedback-current", {}], ["feedback-image", imageInput], ["feedback-result", { outcomes }]] as const) {
    await expect(manager.feedbackAction!(session.id, action, input, "grant")).rejects.toMatchObject({
      code: "feedback_prompt_unbound", status: 409,
      message: expect.stringMatching(/Feedback.*Needs review.*Send again.*destination workspace and chat.*new attempt.*Ordinary continuation/),
    });
  }
  expect(client.image).not.toHaveBeenCalled(); expect(client.outcomes).not.toHaveBeenCalled();
  await manager.cancelSession(session.id);
  const repeated = await service.send(body(session.id), "grant", "owner");
  expect(repeated.id).not.toBe(original.id); expect(repeated.messageSequence).toBeGreaterThan(original.messageSequence!);
  expect(await manager.feedbackAction!(session.id, "feedback-current", {}, "grant")).toMatchObject({ attemptId: repeated.id, reports: [report] });
  expect(await manager.feedbackAction!(session.id, "feedback-image", imageInput, "grant")).toEqual({ content: [{ type: "image", mimeType: "image/png", data: "AQID" }] });
  await manager.feedbackAction!(session.id, "feedback-result", { outcomes }, "grant");
  run.onEvent({ type: "result", status: "success" });
  await vi.waitFor(() => expect(repeated.state).toBe("succeeded"));
  expect(repeated.outcomes).toEqual(outcomes);
  expect(original.state).toBe("cancelled"); expect(original.outcomes).toBeNull();
  expect(client.outcomes).toHaveBeenCalledExactlyOnceWith(repeated.id, outcomes, "grant");
});
it.each(["userId", "appId", "installation"] as const)("refuses feedback tools when the current %s no longer owns the attempt", async field => {
  const session = await manager.createSession({ createdBy: "owner" });
  await service.send(body(session.id), "grant", "owner");
  for (const action of ["feedback-current", "feedback-image", "feedback-result"]) {
    client.capabilities.mockResolvedValueOnce({ appId: "harness", installation: "one", userId: "owner", [field]: "different" });
    await expect(manager.feedbackAction!(session.id, action, { reportId: report.id, annotationId: report.annotations[0]!.id, outcomes: [] }, "grant"))
      .rejects.toMatchObject({ code: "feedback_prompt_unbound", status: 409 });
  }
  expect(client.image).not.toHaveBeenCalled(); expect(client.outcomes).not.toHaveBeenCalled();
});
it("does not use an unrelated later turn, idle state, or failed result as success", () => {
  const events = (...items: Record<string, unknown>[]) => items.map((item, i) => ({ seq: i + 1, ts: "now", ...item })) as StoredEvent[];
  expect(feedbackTurn(events({ type: "user_message" }, { type: "session_status", status: "idle" }), 1)).toBeNull();
  expect(feedbackTurn(events({ type: "user_message" }, { type: "user_message" }, { type: "result", status: "success" }), 1)).toMatchObject({ state: "unknown" });
  expect(feedbackTurn(events({ type: "user_message" }, { type: "result", status: "error" }), 1)).toMatchObject({ state: "failed" });
  expect(feedbackTurn(events({ type: "user_message" }, { type: "question_request" }), 1)).toBeNull();
});

it("keeps foreign-client and prior-installation attempts read-only while reconciling its own", async () => {
  const session = await manager.createSession({ createdBy: "owner" });
  const own = await service.send(body(session.id), "grant", "owner");
  attempts.push({ ...own, id: randomUUID(), callerAppId: "another.client", input: { ...own.input, sessionId: "foreign-chat" } },
    { ...own, id: randomUUID(), callerInstallation: "previous", input: { ...own.input, sessionId: "old-chat" } });
  client.delivery.mockClear();
  const subscribe = vi.spyOn(manager, "subscribe");
  const receipt = vi.spyOn(manager, "messageReceipt");
  const listed = await service.list("grant", "owner");
  expect(listed.dispatches).toHaveLength(3);
  expect(client.delivery.mock.calls.every(([id]) => id === own.id)).toBe(true);
  expect(receipt.mock.calls.every(([id]) => id === session.id)).toBe(true);
  expect(subscribe.mock.calls.every(([id]) => id === session.id)).toBe(true);
  run.onEvent({ type: "result", status: "success" });
  await vi.waitFor(() => expect(own.state).toBe("succeeded"));
  expect(attempts.slice(1).every(d => d.state === "accepted")).toBe(true);
});

it("reconciles a terminal result persisted while restoring a feedback subscription", async () => {
  const session = await manager.createSession({ createdBy: "owner" });
  const attempt = await service.send(body(session.id), "grant", "owner");
  await service.close();
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
  const subscribe = manager.subscribe.bind(manager);
  vi.spyOn(manager, "subscribe").mockImplementationOnce(async (...args) => {
    const events = await manager.store.readEvents(session.id);
    await manager.store.appendEvent(session.id, { seq: events.at(-1)!.seq + 1, ts: new Date().toISOString(), type: "result", status: "success" });
    return subscribe(...args);
  });
  const result = await service.list("grant", "owner");
  expect(attempt.state).toBe("succeeded");
  expect(result.dispatches[0]!.state).toBe("succeeded");
});

it("starts a chat for retained feedback after its application is uninstalled", async () => {
  vi.mocked(directory.readApps).mockResolvedValue([]);
  const { sessionId: _unused, ...input } = body("");
  const attempt = await service.send(input, "grant", "owner");
  expect((await manager.getSession(attempt.input.sessionId))!.appIds).toEqual([]);
  expect(attempt.snapshot[0]!.context.appId).toBe("independent.app");
  expect(sent.mock.calls[0]![0]).toContain("independent.app");
});

it.each(["attach", "reserve"])("replays original workspace attachment after a lost %s response and app removal", async failure => {
  const workspaceId = "b".repeat(64);
  const development = new DevelopmentClient("http://core.test", "harness", "service");
  let revision = 4, lost = failure === "attach";
  const inventory = vi.spyOn(development, "inspection").mockImplementation(async () => ({ workspaces: [{ id: workspaceId, participation: { revision } }] }));
  vi.spyOn(development, "activity").mockResolvedValue({ workspaceId, revision: 5, stopRequested: false, state: "in-progress" });
  const calls = vi.spyOn(development, "call").mockImplementation(async (_id, _token, action, command) => {
    if (action === "attach") {
      expect(command.expectedRevision).toBe(4); revision = 5;
      if (lost) { lost = false; throw new Error("Lost attach response"); }
      return { workspace: { id: workspaceId, revision } };
    }
    return { workspaces: [] };
  });
  await service.close(); await manager.shutdown(); manager = buildManager(development);
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
  if (failure === "reserve") client.reserve.mockRejectedValueOnce(new Error("Lost reserve response"));
  const { sessionId: _unused, ...input } = { ...body(""), workspaceId };
  await expect(service.send(input, "grant", "owner")).rejects.toThrow("Lost " + failure + " response");
  const created = (await manager.store.listRecords())[0]!;
  await service.close(); await manager.shutdown(); manager = buildManager(development);
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
  vi.mocked(directory.readApps).mockResolvedValue([]);
  const attempt = await service.send(input, "grant", "owner");
  expect(attempt.input.sessionId).toBe(created.id);
  expect(await manager.store.listRecords()).toHaveLength(1);
  expect(sent).toHaveBeenCalledTimes(1);
  expect(inventory).toHaveBeenCalledTimes(1);
  const attachments = calls.mock.calls.filter(c => c[2] === "attach");
  expect(attachments).toHaveLength(2); expect(attachments[1]).toEqual(attachments[0]);
  expect((await service.send(input, "grant", "owner")).id).toBe(attempt.id);
  expect(calls.mock.calls.filter(c => c[2] === "attach")).toHaveLength(2); expect(sent).toHaveBeenCalledTimes(1);
});

it.each(["profileId", "profileRevision", "connectionId", "executionSelection", "autonomy"])("does not apply %s to an existing feedback destination", async field => {
  const session = await manager.createSession({ createdBy: "owner" });
  const before = await manager.store.readRecord(session.id);
  await expect(service.send({ ...body(session.id), [field]: field === "autonomy" ? "autonomous" : null }, "grant", "owner"))
    .rejects.toMatchObject({ code: "feedback_existing_settings", status: 400 });
  expect(await manager.store.readRecord(session.id)).toEqual(before);
  expect(client.reserve).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
});

async function configureAgentSettings() {
  const profiles = new ProfileStore(dir, async () => ({ name: "Default", description: "", instructions: "", connectionId: "account",
    model: "model-one", reasoningEffort: "high", skillIds: [] }));
  const choices = await profiles.read(); await profiles.setDefault(choices.profiles[0]!.id, choices.revision);
  const binding = vi.fn(async (id?: unknown) => ({ connectionId: id ?? "account", connectionRevision: 1, harnessKind: "claude" }));
  const models = vi.fn(async () => ({ revision: "models", defaultModel: "model-one",
    models: [{ id: "model-one", label: "One", efforts: [{ id: "high", label: "High" }] }] }));
  const connections = { binding, models, reserve: async () => () => {}, adapter: async () => adapter } as unknown as ConnectionService;
  await service.close(); await manager.shutdown(); manager = buildManager(null, connections, profiles);
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
  return { profiles, connections, binding, models };
}

it("keeps initial feedback agent settings through a lost reserve reply, restart and exact concurrent replay", async () => {
  const config = await configureAgentSettings();
  const { sessionId: _unused, ...input } = { ...body(""), profileId: null, connectionId: "account",
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "autonomous" };
  client.reserve.mockRejectedValueOnce(new Error("Lost reserve response"));
  await expect(service.send(input, "grant", "owner")).rejects.toThrow("Lost reserve response");
  const created = (await manager.store.listRecords())[0]!;
  expect(created).toMatchObject({ agentProfile: null, connectionId: "account", executionSelection: input.executionSelection, autonomy: "autonomous" });
  await service.close(); await manager.shutdown(); manager = buildManager(null, config.connections, config.profiles);
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient, directory);
  config.binding.mockRejectedValue(new Error("Provider catalog unavailable"));
  config.models.mockRejectedValue(new Error("Model catalog unavailable"));
  vi.mocked(directory.readApps).mockResolvedValue([]);
  const [first, replay] = await Promise.all([service.send(input, "grant", "owner"), service.send(input, "grant", "owner")]);
  expect(first.id).toBe(replay.id); expect(first.input.sessionId).toBe(created.id);
  expect(await manager.store.listRecords()).toHaveLength(1); expect(sent).toHaveBeenCalledTimes(1);
  expect(run).toMatchObject({ model: "model-one", reasoningEffort: "high", autonomy: "autonomous" });
  await expect(service.send({ ...input, autonomy: "normal" }, "grant", "owner")).rejects.toMatchObject({ code: "creation_conflict" });
  expect((await manager.getSession(created.id))!.autonomy).toBe("autonomous");
  expect(sent).toHaveBeenCalledTimes(1);
});

it("preserves a feedback profile snapshot after its deletion and rejects replacement on retry", async () => {
  const { profiles } = await configureAgentSettings();
  const directory = await profiles.read(); const profile = directory.profiles[0]!;
  const { sessionId: _unused, ...input } = { ...body(""), profileId: profile.id, profileRevision: profile.revision, autonomy: "normal" };
  const attempt = await service.send(input, "grant", "owner");
  await profiles.remove(profile.id, directory.revision);
  expect((await service.send(input, "grant", "owner")).input.sessionId).toBe(attempt.input.sessionId);
  await expect(service.send({ ...input, profileId: null }, "grant", "owner")).rejects.toMatchObject({ code: "creation_conflict" });
  expect((await manager.getSession(attempt.input.sessionId))!.agentProfile?.id).toBe(profile.id);
  expect(sent).toHaveBeenCalledTimes(1);
});

it("replays completed new-chat dispatches after later app selection changes", async () => {
  const { sessionId: _unused, ...input } = body("");
  const attempt = await service.send(input, "grant", "owner");
  run.onEvent({ type: "result", status: "success" });
  await vi.waitFor(() => expect(attempt.state).toBe("succeeded"));
  await manager.setAppContext(attempt.input.sessionId, [], 0, "owner");
  expect((await service.send(input, "grant", "owner")).id).toBe(attempt.id);
  expect((await manager.getSession(attempt.input.sessionId))!.appIds).toEqual([]);
  expect(sent).toHaveBeenCalledTimes(1); expect(await manager.store.listRecords()).toHaveLength(1);
});

it("resolves concurrent conflicting settings to one original feedback chat", async () => {
  await configureAgentSettings();
  const { sessionId: _unused, ...input } = { ...body(""), profileId: null, connectionId: "account",
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "normal" };
  const results = await Promise.allSettled([service.send(input, "grant", "owner"), service.send({ ...input, autonomy: "autonomous" }, "grant", "owner")]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "creation_conflict" } });
  expect(await manager.store.listRecords()).toHaveLength(1); expect(sent).toHaveBeenCalledTimes(1);
  expect((await manager.store.listRecords())[0]!.autonomy).toBe("normal");
});

it.each([
  [{ executionSelection: { model: "unavailable", reasoningEffort: null } }, "model_unavailable"],
  [{ executionSelection: { model: "model-one", reasoningEffort: "unsupported" } }, "effort_unavailable"],
  [{ autonomy: "unrestricted" }, "autonomy_invalid"],
] as const)("rejects invalid new feedback chat settings before reserving or creating a chat: %j", async (settings, code) => {
  await configureAgentSettings();
  const { sessionId: _unused, ...input } = { ...body(""), profileId: null, connectionId: "account", ...settings };
  await expect(service.send(input, "grant", "owner")).rejects.toMatchObject({ code });
  expect(await manager.store.listRecords()).toHaveLength(0); expect(client.reserve).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
});

it("keeps new feedback browser defaults after response loss and changed browser preferences", async () => {
  await configureAgentSettings();
  const selection = { model: "model-one", reasoningEffort: "high" };
  const { sessionId: _unused, ...input } = { ...body(""), profileId: null,
    browserDefaults: { ownerId: "owner", models: { account: selection }, autonomy: "autonomous" } };
  client.reserve.mockRejectedValueOnce(new Error("Lost reserve response"));
  await expect(service.send(input, "grant", "owner")).rejects.toThrow("Lost reserve response");
  const created = (await manager.store.listRecords())[0]!;
  expect(created).toMatchObject({ executionSelection: selection, autonomy: "autonomous" });
  const replay = await service.send({ ...input, browserDefaults: { ownerId: "owner", models: { account: { model: null, reasoningEffort: null } }, autonomy: "normal" } }, "grant", "owner");
  expect(replay.input.sessionId).toBe(created.id);
  expect((await manager.getSession(created.id))).toMatchObject({ executionSelection: selection, autonomy: "autonomous" });
  expect(sent).toHaveBeenCalledTimes(1); expect(await manager.store.listRecords()).toHaveLength(1);
});

it("ignores browser defaults when feedback targets an existing chat", async () => {
  const session = await manager.createSession({ createdBy: "owner" });
  await service.send({ ...body(session.id), browserDefaults: { ownerId: "owner", autonomy: "autonomous", models: { account: { model: "missing", reasoningEffort: "high" } } } }, "grant", "owner");
  const saved = (await manager.getSession(session.id))!;
  expect(saved.autonomy).toBeUndefined(); expect(saved.executionSelection).toBeUndefined();
  expect(run.autonomy).toBe("normal"); expect(sent).toHaveBeenCalledTimes(1);
});
