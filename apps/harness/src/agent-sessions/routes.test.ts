import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { AuditReporter } from "../audit.js";
import { AgentSessionService } from "./service.js";
import { agentSessionRoute } from "./routes.js";
const provider = { appId: "independent.executor", installationId: "install-one", key: "default" };
const actor: MediatedProviderInvocation = { version: 2, userId: "owner", hostRole: "host.admin", principalId: "direct-client", callerAppId: null, callerInstallation: null, kind: "agent-sessions", key: "default", operation: "runs.get", resourceIds: [] };
const token = "hosty_provider.2.synthetic.signature";
let directory: string, manager: SessionManager, server: Server, origin: string, payload: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "hosty-run-http-"));
  vi.stubEnv("HOSTY_APP_ID", provider.appId); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "test-service");
  manager = new SessionManager(new SessionStore(directory), { name: "test", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false }, probe: async () => ({ available: true }), start: () => { throw new Error("No native execution in an HTTP metadata test."); } }, new AuditReporter(null, null, provider.appId), directory);
  const chat = await manager.createSession({ createdBy: actor.userId, title: "private conversation title" });
  const run = await manager.observations.begin(chat);
  payload = JSON.stringify({ run: { provider, id: run } }, null, 2);
  const service = new AgentSessionService(manager, provider);
  server = createServer((req, res) => { void agentSessionRoute(req, res, new URL(req.url!, origin), service).catch(() => res.writeHead(500).end()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await manager.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const get = (headers: Record<string, string> = {}) => fetch(origin + "/api/agent-sessions/v1/runs/get", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
it("validates actual bytes twice and refuses legacy or mixed credentials", async () => {
  const validation = vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValue(actor);
  const response = await get({ authorization: `Bearer ${token}` }); expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("private conversation title"); expect(validation).toHaveBeenCalledTimes(2);
  for (const [credential, kind, request] of validation.mock.calls) {
    expect(credential).toBe(token); expect(kind).toBe("agent-sessions"); expect(request.path).toBe("/runs/get"); expect(Buffer.from(request.body).toString()).toBe(payload);
  }
  for (const headers of [{}, { authorization: "Bearer hosty_provider.1.legacy" }, { authorization: `Bearer ${token}`, cookie: "session=other" }] as Record<string, string>[]) expect((await get(headers)).status).toBe(401);
});
it("withholds execution metadata after revocation during the read", async () => {
  vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValueOnce(actor).mockRejectedValueOnce(new ProviderError("permission_denied", "Revoked", 403));
  const response = await get({ authorization: `Bearer ${token}` }); expect(response.status).toBe(403); expect(await response.text()).not.toContain('"run"');
});
