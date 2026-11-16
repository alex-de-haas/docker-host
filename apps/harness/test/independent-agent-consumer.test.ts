import { fixtureCapabilities } from "../../../packages/agent-provider-runtime/src/test-support/provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AgentApiError, type AgentAuthorizationRequest } from "@hosty-sdk/app/agent";
import { createConsumer } from "../../../scripts/fixtures/agent-consumer/main.mjs";
import { ProviderController } from "../../../packages/agent-provider-runtime/src/controller.js";
import { ProviderStore, bytesHash, type VerifiedOperation } from "../../../packages/agent-provider-runtime/src/store.js";
import { agentRoutes, json } from "../../../packages/agent-provider-runtime/src/server.js";
import { AttachmentStore } from "../../../packages/agent-provider-runtime/src/attachments.js";
import type { ProviderAuthority } from "../../../packages/agent-provider-runtime/src/core.js";
import type { AgentConnections } from "../../../packages/agent-provider-runtime/src/internal/connections/registry.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture({ staleProviderCode = "provider_unavailable" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-independent-consumer-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = { appId: "another.vendor.runtime", installationId: "actual-installation", key: "coding" };
  const consumer = "example.unrelated.consumer", grants = new Map<string, AgentAuthorizationRequest>();
  const authority = { introspect: async (token: string, operation: string, method: string, route: string, hash: string) => {
    const request = grants.get(token);
    if (!request || request.operation !== operation || request.method !== method || request.path !== route || request.bodyHash !== hash) throw new AgentApiError("operation_mismatch", "Wrong exact operation", 403);
    return { ...request, provider, userId: "operator", principalId: "principal", callerAppId: consumer, callerInstallation: "consumer-installation", admissionRef: token } as VerifiedOperation;
  } } as ProviderAuthority;
  const connections = { binding: async () => ({ harnessKind: "fixture-engine", connectionRevision: 1 }) } as unknown as AgentConnections;
  const store = new ProviderStore(path.join(root, "sessions"), provider); await store.initialize();
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities); cleanup.push(() => controller.close());
  controller.connections.list = vi.fn(async () => ({ defaultId: "account", connections: [{ id: "account", name: "Test account", kind: "fixture-engine", auth: "none", available: true, revision: 1 }] })) as never;
  const starts: string[] = [];
  controller.driver = { start: async (sessionId, runId) => {
    starts.push(runId);
    await store.exclusive(async () => {
      const session = await store.load(sessionId), record = session.runs[runId]!;
      session.nativeId = "native-private-only"; session.session.nativeState = "available"; session.session.activeRun = null;
      record.snapshot.state = "succeeded"; record.snapshot.phase = "terminal"; record.snapshot.stopConfirmed = true;
      record.snapshot.result = { status: "succeeded", text: "hello" }; store.lifecycle(record); await store.save(session);
    });
  }, cancel: async () => {}, respond: async () => {}, control: async () => {}, synchronize: async () => {}, close: async () => {} };
  const routes = agentRoutes(controller, new AttachmentStore(path.join(root, "attachments"), provider));
  const providerOrigin = await listen(createServer((req, res) => { void routes(req, res, new URL(req.url!, "http://provider.test")).catch(error => json(res, error.status ?? 500, { error: { code: error.code, message: error.message } })); }));
  const calls: Array<{ path: string; user: string | null; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)); if (parsed.hostname !== "core.test") return fetch(url, init);
    const headers = new Headers(init?.headers), input = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path: parsed.pathname, user: headers.get("X-Hosty-User-Token"), body: input });
    expect(headers.get("authorization")).toBe("Bearer own-service");
    if (parsed.pathname === "/api/auth/apps/token") return Response.json({ accessToken: "hostyg_own-user", expiresInSeconds: 120 });
    if (parsed.pathname === "/api/auth/apps/revalidate") return Response.json({ active: input.accessToken === "hostyg_own-user", appId: consumer, userId: "operator" });
    if (parsed.pathname.endsWith("/providers/agent")) return Response.json({ providers: [{ ...provider, available: true, version: 1 }] });
    if (parsed.pathname.endsWith("/agent/authorize")) {
      if (headers.get("X-Hosty-User-Token") !== "hostyg_own-user") return Response.json({ code: "actor_required" }, { status: 401 });
      if (input.provider.installationId !== provider.installationId) return Response.json({ code: staleProviderCode }, { status: 503 });
      const { provider: _ref, ...request } = input, token = randomUUID(); grants.set(token, request);
      return Response.json({ provider, token, baseUrl: providerOrigin + "/api/agent/v1", expiresAt: new Date(Date.now() + 60000).toISOString() });
    }
    throw new Error("Unexpected Core route");
  };
  const handler = createConsumer({ env: { HOSTY_APP_ID: consumer, HOSTY_APP_SERVICE_TOKEN: "own-service", HOSTY_CORE_ORIGIN: "http://core.test" }, fetch: fetcher });
  const origin = await listen(createServer((req, res) => { void handler(req, res); }));
  const call = (route: string, body: unknown, cookie?: string) => fetch(origin + route, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { call, calls, store, starts, provider };
}

describe("independent SDK-only acceptance consumer", () => {
  it("requires its own authenticated session before any discovery or execution", async () => {
    const f = await fixture(), response = await f.call("/probe", {});
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: { code: "app_identity_required" } });
    expect(f.calls).toEqual([]); expect(f.starts).toEqual([]);
  });
  it("validates app-owned exchange proof before contacting Core", async () => {
    const f = await fixture(), response = await f.call("/api/auth/exchange", { code: "single-use-code", codeVerifier: "bad" });
    expect(response.status).toBe(400); expect(f.calls).toEqual([]);
  });
  it("does not treat another service failure as a successful stale-installation denial", async () => {
    const f = await fixture({ staleProviderCode: "core_unavailable" });
    const login = await f.call("/api/auth/exchange", { code: "owned-code", codeVerifier: "a".repeat(64) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await f.call("/probe", { providerAppId: f.provider.appId, connectionId: "account", connectionRevision: "1" }, cookie);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "core_unavailable", message: "Core refused the fixture operation." } });
    expect(f.starts).toEqual([]); expect(await f.store.records()).toEqual([]);
  });
  it("uses SDK transport and the actual controller for exact authority, negative selection checks, SSE and same-session resume", async () => {
    const f = await fixture(), login = await f.call("/api/auth/exchange", { code: "owned-code", codeVerifier: "a".repeat(64) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await f.call("/probe", { providerAppId: f.provider.appId, connectionId: "account", connectionRevision: "1" }, cookie);
    const result = await response.json(); expect(result, JSON.stringify(result)).toMatchObject({ appId: "example.unrelated.consumer", provider: f.provider, connection: { id: "account", revision: "1" } });
    expect(response.status).toBe(200); expect(result.runs).toHaveLength(2);
    expect(result.runs.every((run: { stopConfirmed: boolean; replayedEvents: number }) => run.stopConfirmed && run.replayedEvents > 0)).toBe(true);
    expect(result.denied).toMatchObject({ noActor: { status: 401 }, staleProvider: { status: 503, code: "provider_unavailable" }, staleAccount: { status: 409, code: "connection_revision_mismatch" } });
    const sessions = await f.store.records(); expect(sessions).toHaveLength(1);
    expect(Object.values(sessions[0]!.runs).map(run => run.input?.continuation)).toEqual(["start", "resume"]);
    expect(sessions[0]!.session.configuration).toEqual({ connection: { id: "account", revision: "1" } });
    expect(f.starts).toHaveLength(2);
    for (const request of f.calls.filter(call => call.path.endsWith("/agent/authorize") && call.body.operation === "runs.start")) {
      expect(request.user).toBe("hostyg_own-user"); expect(request.body.configurationDigest).toBe(sessions[0]!.session.configurationDigest);
      expect(bytesHash(JSON.stringify(sessions[0]!.runs[request.body.runId as string]!.input))).toBe(request.body.bodyHash);
    }
  });
});
