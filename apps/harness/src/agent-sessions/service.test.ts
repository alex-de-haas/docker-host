import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import { AgentSessionService } from "./service.js";
const provider = { appId: "independent.executor", installationId: "install-one", key: "default" };
const owner = { userId: "owner", principalId: "client-one", hostRole: "host.admin" };
let dir: string, manager: SessionManager, store: SessionStore, service: AgentSessionService, options: HarnessStartOptions, proof: boolean, stops: number;
const adapter: HarnessAdapter = { name: "observed-test", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }), start: input => {
    options = input;
    return { send() {}, stop: async () => { stops++; }, ...(proof ? { stopAndWait: async () => { stops++; } } : {}), interrupt: async () => {}, setMcpServers: async () => false,
      resolveApproval: () => false, resolveQuestion: () => false };
  } };
const build = () => { manager = new SessionManager(store, adapter, new AuditReporter(null, null, provider.appId), dir); service = new AgentSessionService(manager, provider); };
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "hosty-execution-observation-")); store = new SessionStore(dir, path.join(dir, "cache")); proof = true; stops = 0; build(); });
afterEach(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); });
const begin = async () => {
  const chat = await manager.createSession({ createdBy: owner.userId });
  await manager.postMessage(chat.id, "private prompt");
  options.onEvent({ type: "harness_session", harnessSessionId: "private-native-backend-id" });
  await vi.waitFor(async () => expect((await store.readRecord(chat.id))!.harnessSessionId).toBe("private-native-backend-id"));
  return { chat, run: { provider, id: (await store.readRecord(chat.id))!.agentRunId! } };
};
it("keeps conversation, native-session and attempt identities distinct and does not treat turn completion as process exit", async () => {
  const { chat, run } = await begin();
  const page = await service.list(owner, { provider }); const native = page.sessions[0]!;
  expect(native.ref.id).not.toBe(chat.id); expect(native.ref.id).not.toBe(run.id); expect(run.id).not.toBe(chat.id);
  expect(native.activeRuns).toEqual([run]); expect(JSON.stringify(page)).not.toContain("private-native-backend-id");
  options.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(chat.id))!.status).toBe("idle"));
  expect(await service.getRun(owner, run)).toMatchObject({ state: "waiting_for_input", freshness: "current", stopConfirmed: false });
  await expect(service.getRun({ ...owner, userId: "other-admin" }, run)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.getRun({ ...owner, hostRole: "host.user" }, run)).rejects.toMatchObject({ status: 403 });
});
it("confirms only real exit, replays cancellation without stopping a replacement attempt and preserves session revision", async () => {
  const { chat, run } = await begin(); const original = await service.getRun(owner, run);
  const native = await service.getSession(owner, original.nativeSession!);
  const request = { run, requestId: randomUUID(), expectedRevision: original.revision };
  const receipt = await service.cancel(owner, request, async () => {});
  expect(receipt).toMatchObject({ state: "completed", run: { state: "cancelled", stopConfirmed: true } }); expect(stops).toBe(1);
  expect((await service.getSession(owner, original.nativeSession!)).activeRuns).toEqual([]);
  expect((await service.getSession(owner, original.nativeSession!)).revision).not.toBe(native.revision);
  await manager.postMessage(chat.id, "next attempt");
  const replacement = (await store.readRecord(chat.id))!.agentRunId!; expect(replacement).not.toBe(run.id);
  expect((await service.cancel(owner, request, async () => {})).run.stopConfirmed).toBe(true); expect(stops).toBe(1);
  await expect(service.cancel(owner, { ...request, run: { provider, id: replacement } }, async () => {})).rejects.toMatchObject({ code: "request_conflict" });
});
it("retains unconfirmed native observations across coordinator restart and cannot cancel by guessing a conversation id", async () => {
  proof = false; const { chat, run } = await begin(); await manager.shutdown(); build();
  expect(await service.getRun(owner, run)).toMatchObject({ state: "unknown", freshness: "last_known", stopConfirmed: false });
  await expect(service.getRun(owner, { provider, id: chat.id })).rejects.toMatchObject({ code: "not_found" });
  const current = await service.getRun(owner, run);
  await expect(service.cancel(owner, { run, requestId: randomUUID(), expectedRevision: current.revision }, async () => {})).rejects.toMatchObject({ code: "provider_unavailable" });
  expect((await service.getRun(owner, run)).stopConfirmed).toBe(false);
});
it("does not dispatch cancellation when current authority fails and pins a stale-revision refusal", async () => {
  const { run } = await begin(), current = await service.getRun(owner, run);
  const request = { run, requestId: randomUUID(), expectedRevision: current.revision };
  await expect(service.cancel(owner, request, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked"); expect(stops).toBe(0);
  const stale = { ...request, expectedRevision: "0" };
  await expect(service.cancel(owner, stale, async () => {})).rejects.toMatchObject({ code: "revision_conflict" }); expect(stops).toBe(0);
  await expect(service.cancel(owner, request, async () => {})).rejects.toMatchObject({ code: "request_conflict" });
  await expect(service.cancel(owner, stale, async () => {})).rejects.toMatchObject({ code: "revision_conflict" });
});


it("resumes content-free run notifications and wakes on confirmed executor exit", async () => {
  const { run } = await begin();
  const first = await service.notifications(owner, { run, waitSeconds: 0 }); expect(first.rescanRequired).toBe(true);
  const waiting = service.notifications(owner, { run, cursor: first.cursor, waitSeconds: 20 });
  await service.cancel(owner, { run, requestId: randomUUID(), expectedRevision: first.run.revision }, async () => {});
  const changed = await waiting; expect(changed.run.revision).not.toBe(first.run.revision);
  const current = await service.getRun(owner, run); expect(current.stopConfirmed).toBe(true);
  expect(JSON.stringify(changed)).not.toContain("private prompt");
  const other = await service.notifications({ ...owner, principalId: "other-client" }, { run, cursor: first.cursor, waitSeconds: 0 });
  expect(other.rescanRequired).toBe(true);
});
