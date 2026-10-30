import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FeedbackService, feedbackTurn } from "./service.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore, type StoredEvent } from "../sessions/store.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import type { FeedbackServerClient } from "@hosty-sdk/app/feedback/server";
import type { FeedbackDispatch, FeedbackDispatchInput, FeedbackDelivery, FeedbackOutcome, FeedbackReport } from "@hosty-sdk/app/feedback";
let dir: string, manager: SessionManager, service: FeedbackService, run: HarnessStartOptions;
let report: FeedbackReport, attempts: FeedbackDispatch[];
const sent = vi.fn();
const adapter: HarnessAdapter = { name: "controlled", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false }, probe: async () => ({ available: true }),
  start: options => { run = options; return { send: sent, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {} }; } };
const client = {
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
  manager = new SessionManager(new SessionStore(dir), adapter, new AuditReporter(null, null, "harness"), dir, null, null, null, null, "http://localhost:1234");
  service = new FeedbackService(manager, () => client as unknown as FeedbackServerClient);
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
it("does not use an unrelated later turn, idle state, or failed result as success", () => {
  const events = (...items: Record<string, unknown>[]) => items.map((item, i) => ({ seq: i + 1, ts: "now", ...item })) as StoredEvent[];
  expect(feedbackTurn(events({ type: "user_message" }, { type: "session_status", status: "idle" }), 1)).toBeNull();
  expect(feedbackTurn(events({ type: "user_message" }, { type: "user_message" }, { type: "result", status: "success" }), 1)).toMatchObject({ state: "unknown" });
  expect(feedbackTurn(events({ type: "user_message" }, { type: "result", status: "error" }), 1)).toMatchObject({ state: "failed" });
  expect(feedbackTurn(events({ type: "user_message" }, { type: "question_request" }), 1)).toBeNull();
});
