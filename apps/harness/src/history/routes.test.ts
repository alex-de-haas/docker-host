import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import { SessionStore } from "../sessions/store.js";
import { HistoryService } from "./service.js";
import { historyRoute } from "./routes.js";

let root: string, history: HistoryService, server: Server, origin: string, conversation: string;
const provider = { appId: "independent.harness", installationId: "one", key: "default" };
const token = "hosty_provider.2.test.signature";
const actor: MediatedProviderInvocation = { version: 2, callerAppId: null, callerInstallation: null, userId: "owner", hostRole: "host.admin", principalId: "oauth:independent", kind: "conversation-history", key: "default", operation: "entries.get", resourceIds: [] };
beforeEach(async () => {
  vi.stubEnv("HOSTY_APP_ID", provider.appId); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "test-service-token");
  root = await mkdtemp(path.join(tmpdir(), "hosty-history-route-")); conversation = randomUUID();
  const sessions = new SessionStore(root); history = new HistoryService(sessions, provider);
  const now = new Date().toISOString();
  await sessions.createSession({ id: conversation, createdBy: "owner", title: "Private title", context: null, status: "idle", createdAt: now, updatedAt: now, harnessSessionId: null, lastEventSeq: 1 });
  await sessions.appendEvent(conversation, { type: "user_message", seq: 1, ts: now, text: "private content" });
  server = createServer((request, response) => { void historyRoute(request, response, new URL(request.url!, "http://local"), history).catch(() => response.writeHead(500).end()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); history.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
const body = () => JSON.stringify({ entry: { conversation: { provider, id: conversation }, id: "event-1" } }, null, 2);
const get = (headers: Record<string, string> = {}, payload = body()) => fetch(origin + "/api/history/v1/entries/get", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

it("introspects actual request bytes before and after source access without accepting v1 or cookies", async () => {
  const validate = vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValue(actor);
  const payload = body(); const result = await get({ authorization: `Bearer ${token}` }, payload);
  expect(result.status).toBe(200); expect(JSON.stringify(await result.json())).toContain("private content");
  expect(validate).toHaveBeenCalledTimes(2);
  for (const [credential, kind, request, key] of validate.mock.calls) {
    expect(credential).toBe(token); expect(kind).toBe("conversation-history"); expect(key).toBe("default");
    expect(request).toMatchObject({ method: "POST", operation: "entries.get", path: "/entries/get" });
    expect(Buffer.from(request.body).toString()).toBe(payload);
  }
  for (const headers of [{}, { authorization: "Bearer hosty_provider.1.legacy" }, { authorization: `Bearer ${token}`, cookie: "session=other" }] as Record<string, string>[]) expect((await get(headers)).status).toBe(401);
  expect(validate).toHaveBeenCalledTimes(2);
});

it("does not deliver content if original authority is revoked during a source read", async () => {
  vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValueOnce(actor).mockRejectedValueOnce(new ProviderError("permission_denied", "Current authority was revoked.", 403));
  const response = await get({ authorization: `Bearer ${token}` });
  expect(response.status).toBe(403); expect(await response.text()).not.toContain("private content");
});

it("preserves provider admission and owner ACL after successful Core introspection", async () => {
  const validate = vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValue({ ...actor, hostRole: "host.user" });
  expect((await get({ authorization: `Bearer ${token}` })).status).toBe(403);
  validate.mockResolvedValue({ ...actor, userId: "other-admin" });
  const response = await get({ authorization: `Bearer ${token}` }); expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "not_found", retryable: false } });
});


it("rechecks the source share after the final Core introspection", async () => {
  const owner = actor;
  const reference = { provider, id: conversation };
  const grant = await history.share(owner, { ref: reference, requestId: randomUUID(), expectedRevision: (await history.conversation(owner, reference)).revision,
    recipientUserIds: ["recipient"], selection: { entryIds: ["event-1"] }, includeAttachments: false, extensions: [] });
  const recipient = { ...actor, userId: "recipient" };
  vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValueOnce(recipient).mockImplementationOnce(async () => {
    await history.share(owner, { ref: reference, grantId: grant.grant.id, requestId: randomUUID(), expectedRevision: grant.conversationRevision }, true);
    return recipient;
  });
  const response = await get({ authorization: `Bearer ${token}` });
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("private content");
});
