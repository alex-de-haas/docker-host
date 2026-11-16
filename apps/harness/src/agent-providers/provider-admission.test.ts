import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AgentApiError, type AgentAuthorizationRequest, type AgentConfiguration, type AgentRunInput } from "@hosty-sdk/app/agent";
import { prepareAgentCancel, prepareAgentRun } from "@hosty-sdk/app/agent/client";
import { ProviderController } from "../../../../packages/agent-provider-runtime/src/controller.js";
import { ProviderStore, bytesHash, type VerifiedOperation } from "../../../../packages/agent-provider-runtime/src/store.js";
import { agentRoutes, json } from "../../../../packages/agent-provider-runtime/src/server.js";
import { AttachmentStore } from "../../../../packages/agent-provider-runtime/src/attachments.js";
import type { ProviderAuthority } from "../../../../packages/agent-provider-runtime/src/core.js";
import type { AgentConnections } from "../../../../packages/agent-provider-runtime/src/internal/connections/registry.js";
import { CoreAgentBackend } from "./core.js";
import { ProviderExecution, type ProviderExecutionState } from "./execution.js";
import { ProviderHarnessRun } from "./run.js";

const cleanup: Array<() => Promise<void>> = [];
const skillId = "6".repeat(64);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-consumer-admission-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const provider = { appId: "independent.execution", installationId: "provider-installation", key: "coding" };
  const actor = { userId: "operator", principalId: "original-principal", callerAppId: "independent.consumer", callerInstallation: "consumer-installation" };
  const grants = new Map<string, AgentAuthorizationRequest>(), authorizations: AgentAuthorizationRequest[] = [];
  const authority = { introspect: vi.fn(async (token: string, operation: string, method: string, route: string, bodyHash: string) => {
    const request = grants.get(token);
    if (!request || request.operation !== operation || request.method !== method || request.path !== route || request.bodyHash !== bodyHash) throw new AgentApiError("operation_mismatch", "Wrong operation authority.", 403);
    // Core's nullable optional fields are present in its real JSON invocation response.
    return { ...actor, ...request, provider, admissionRef: token, configurationDigest: request.configurationDigest ?? null } as unknown as VerifiedOperation;
  }), skills: vi.fn(async () => ({ id: "immutable-snapshot", path: directory, digest: "b".repeat(64), skills: [{ skillId, digest: "c".repeat(64) }] })) } as unknown as ProviderAuthority;
  const connections = { binding: vi.fn(async () => ({ harnessKind: "ollama", connectionRevision: 1 })) } as unknown as AgentConnections;
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const controller = new ProviderController(store, authority, connections, "ollama");
  const start = vi.fn(async () => {});
  controller.driver = { start, cancel: vi.fn(async () => {}), respond: vi.fn(async () => {}), control: vi.fn(async () => {}), synchronize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const routes = agentRoutes(controller, new AttachmentStore(path.join(directory, "attachments"), provider));
  const server = createServer((request, response) => { void routes(request, response, new URL(request.url!, "http://isolated.test")).catch(error => {
    json(response, error instanceof AgentApiError ? error.status : 500, { error: { code: error.code, message: error.message } });
  }); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await controller.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing isolated provider listener.");
  const origin = `http://127.0.0.1:${address.port}`;
  let loseStartResponse = false;
  const sent: Array<{ path: string; body: string }> = [];
  const backend = new CoreAgentBackend({ coreOrigin: "http://isolated-core.test", appId: actor.callerAppId, serviceToken: "synthetic-consumer-service", fetch: (async (url, init) => {
    if (String(url).endsWith("/agent/authorize")) {
      const { provider: _provider, ...request } = JSON.parse(String(init?.body)) as AgentAuthorizationRequest & { provider: unknown };
      authorizations.push(structuredClone(request)); const token = randomUUID(); grants.set(token, request);
      return Response.json({ provider, baseUrl: origin + "/api/agent/v1", token, expiresAt: new Date(Date.now() + 60000).toISOString() });
    }
    if (init?.body) sent.push({ path: new URL(String(url)).pathname, body: String(init.body) });
    const response = await fetch(url, init);
    if (loseStartResponse && new URL(String(url)).pathname.includes("/runs/") && init?.method === "PUT") { loseStartResponse = false; await response.text(); throw new Error("Admission response lost after commit"); }
    // JSON peers may normalize field order without changing the acknowledged configuration.
    if (response.ok && new URL(String(url)).pathname.includes("/sessions/") && !new URL(String(url)).pathname.includes("/runs/"))
      return Response.json(ordered(await response.json()), { status: response.status });
    return response;
  }) as typeof fetch });
  const client = backend.client(provider, async () => "original-user-grant");
  const state: ProviderExecutionState = { version: 1, selection: { provider, connection: { id: "account", revision: "1" } }, sessionId: randomUUID() };
  let durable = structuredClone(state);
  const persistence = { save: async (next: ProviderExecutionState) => { durable = structuredClone(next); }, observe: async () => {} };
  const configuration: AgentConfiguration = { skills: [{ skillId }], instructions: [{ text: "Caller instructions", id: "guide" }], connection: { revision: "1", id: "account" } };
  const run = (restored = state) => new ProviderHarnessRun(async () => ({ client, state: restored, persistence, configuration, input: async text => ({ input: { text } }), unavailable: async () => {} }), { sessionId: "conversation", cwd: "/unused", onEvent: () => {} });
  return { state, store, controller, start, client, persistence, configuration, run, authorizations, sent, durable: () => durable, loseResponse: () => { loseStartResponse = true; } };
}

describe("Harness admission against the actual public provider controller", () => {
  it("keeps an applied cancellation's exact bytes across repeated Stop and serialized consumer recovery while exit remains unknown", async () => {
    const f = await fixture(), run = f.run(); cleanup.push(() => run.detach());
    f.controller.driver.cancel = vi.fn(async runId => {
      await f.store.exclusive(async () => {
        const { session, record } = await f.store.run(runId);
        record.snapshot.state = "unknown"; record.snapshot.phase = "interrupted";
        record.snapshot.effects = { certainty: "unknown", unresolvedCallIds: ["external-call"] };
        f.store.lifecycle(record); await f.store.save(session);
      });
    });
    run.send("One original execution"); await run.waitForAdmission();
    const runId = f.state.runId!, realNow = Date.now;
    let now = realNow();
    // Keep real HTTP timers; advance only the consumer's bounded stop deadline after each read.
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = f.client.run.bind(f.client);
    vi.spyOn(f.client, "run").mockImplementation(async (...args) => {
      const value = await read(...args);
      if (f.durable().cancellations?.[runId]) now += 31000;
      return value;
    });
    try {
      await expect(run.stopAndWait()).rejects.toMatchObject({ code: "stop_unconfirmed" });
      const original = f.durable().cancellations![runId]!.request;
      const input = JSON.parse(original.body);
      await vi.waitFor(async () => expect((await f.client.control(runId, input.requestId)).state).toBe("applied"));
      const controls = vi.spyOn(f.client, "control");
      // The public revision advances independently after command acknowledgement.
      await f.store.exclusive(async () => {
        const { session, record } = await f.store.run(runId);
        f.store.lifecycle(record); await f.store.save(session);
      });
      await expect(run.stopAndWait()).rejects.toMatchObject({ code: "stop_unconfirmed" });
      expect(controls).toHaveBeenCalledWith(runId, input.requestId);
      expect(f.durable().mutations).toEqual({});
      expect(f.durable().cancellations![runId]).toEqual({ request: original, receipt: expect.objectContaining({ state: "applied", requestId: input.requestId }) });
      expect(run.stopProof).toBeNull();
      await run.detach();
      const serialized: ProviderExecutionState = JSON.parse(JSON.stringify(f.durable()));
      const restored = f.run(serialized); cleanup.push(() => restored.detach()); await restored.attach();
      await expect(restored.stopAndWait()).rejects.toMatchObject({ code: "stop_unconfirmed" });
      expect(serialized.cancellations![runId]!.request).toEqual(original);
      expect(f.sent.filter(request => request.path.endsWith("/cancel"))).toEqual([{ path: `/api/agent/v1/runs/${runId}/cancel`, body: original.body }]);
      expect(f.controller.driver.cancel).toHaveBeenCalledOnce();
      expect(f.start).toHaveBeenCalledOnce();
      expect(restored.stopProof).toBeNull();
      // Real controller hashing demonstrates that the former changed-CAS retry is a conflict.
      await expect(f.client.execute(prepareAgentCancel(runId, { ...input, expectedRevision: "999" }))).rejects.toMatchObject({ code: "request_conflict" });
      expect(f.controller.driver.cancel).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });

  it("uses the provider's resolved configuration digest across JSON field normalization", async () => {
    const f = await fixture(), run = f.run(); cleanup.push(() => run.detach());
    run.send("First turn"); await run.waitForAdmission();
    const session = (await f.store.load(f.state.sessionId)).session;
    expect(session.configurationDigest).not.toBe(bytesHash(JSON.stringify(f.configuration)));
    expect(f.authorizations.find(request => request.operation === "runs.start")?.configurationDigest).toBe(session.configurationDigest);
    expect(f.state.appliedConfiguration?.digest).toBe(session.configurationDigest);
    expect(f.sent.filter(request => request.path.includes("/configurations/"))).toEqual([]);
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.state.sessionId, f.state.runId);
  });

  it("retries a lost admission with its original digest, UUID and exact bytes without a second execution", async () => {
    const f = await fixture(), run = f.run(); cleanup.push(() => run.detach());
    f.loseResponse(); run.send("Execute exactly once");
    await expect(run.waitForAdmission()).rejects.toThrow("Admission response lost");
    const prepared = Object.values(f.durable().mutations!)[0]!;
    await run.detach();
    const restored = f.run(); cleanup.push(() => restored.detach()); await restored.attach();
    const starts = f.sent.filter(request => request.path.includes("/runs/"));
    expect(starts).toHaveLength(2); expect(starts[1]).toEqual(starts[0]);
    expect(f.authorizations.filter(request => request.operation === "runs.start").map(request => request.configurationDigest)).toEqual([prepared.configurationDigest, prepared.configurationDigest]);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.state.mutations).toEqual({});
  });

  it("enriches an old unadmitted start only after the exact provider configuration revision is confirmed", async () => {
    const f = await fixture(), execution = new ProviderExecution(f.client, f.state, f.persistence);
    const session = await execution.create(f.configuration), runId = randomUUID();
    const input: AgentRunInput = { expectedSessionRevision: session.revision, configurationRevision: session.configurationRevision, continuation: "start", input: { text: "Original retained input" } };
    const prepared = prepareAgentRun(f.state.sessionId, runId, input), key = `${prepared.method}:${prepared.path}:${prepared.bodyHash}`;
    f.state.runId = runId; f.state.mutations = { [key]: prepared }; await f.persistence.save(f.state);
    await execution.reconcileMutation(prepared);
    expect(f.sent.at(-1)?.body).toBe(prepared.body);
    expect(f.authorizations.at(-1)).toMatchObject({ runId, bodyHash: prepared.bodyHash, configurationDigest: session.configurationDigest });
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.state.sessionId, runId);
  });

  it("does not retarget an old unadmitted start after the provider configuration changes", async () => {
    const f = await fixture(), execution = new ProviderExecution(f.client, f.state, f.persistence);
    const session = await execution.create(f.configuration), runId = randomUUID();
    const prepared = prepareAgentRun(f.state.sessionId, runId, { expectedSessionRevision: session.revision, configurationRevision: session.configurationRevision, continuation: "start", input: { text: "Keep original policy" } });
    const key = `${prepared.method}:${prepared.path}:${prepared.bodyHash}`;
    const actor = { userId: "operator", principalId: "original-principal", callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "configuration-authority", operation: "sessions.configure", provider: f.state.selection.provider };
    const change = { requestId: randomUUID(), expectedSessionRevision: session.revision, configuration: { ...f.configuration, approvalMode: "autonomous" as const } };
    await f.controller.configureSession(f.state.sessionId, change, JSON.stringify(change), actor);
    f.state.runId = runId; f.state.mutations = { [key]: prepared }; await f.persistence.save(f.state);
    await expect(execution.reconcileMutation(prepared)).rejects.toMatchObject({ code: "configuration_unknown" });
    expect(f.state.mutations[key]).toEqual(prepared);
    expect(f.authorizations.filter(request => request.operation === "runs.start")).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("delivers a retained Stop fence before restoring an unadmitted start and observes its tombstone", async () => {
    const f = await fixture(), execution = new ProviderExecution(f.client, f.state, f.persistence);
    const session = await execution.create(f.configuration), runId = randomUUID();
    const prepared = prepareAgentRun(f.state.sessionId, runId, { expectedSessionRevision: session.revision, configurationRevision: session.configurationRevision, continuation: "start", input: { text: "The user already stopped this turn" } });
    const cancel = prepareAgentCancel(runId, { requestId: randomUUID(), fenceIfNotAdmitted: { sessionId: f.state.sessionId, startDigest: prepared.bodyHash } });
    const key = (request: typeof prepared | typeof cancel) => `${request.method}:${request.path}:${request.bodyHash}`;
    f.state.runId = runId; f.state.mutations = { [key(prepared)]: prepared, [key(cancel)]: cancel }; await f.persistence.save(f.state);
    const restored = f.run(); cleanup.push(() => restored.detach()); await restored.attach();
    expect(f.sent.slice(1).map(request => request.path)).toEqual([`/api/agent/v1/runs/${runId}/cancel`, `/api/agent/v1/sessions/${f.state.sessionId}/runs/${runId}`]);
    expect(f.state.run).toMatchObject({ ref: { id: runId }, state: "cancelled", stopConfirmed: true });
    expect(f.state.mutations).toEqual({});
    expect(f.start).not.toHaveBeenCalled();
  });
});
