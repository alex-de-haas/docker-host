import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AgentClient } from "@hosty-sdk/app/agent/client";
import type { AgentAuthorizationRequest } from "@hosty-sdk/app/agent";
import { OllamaConnections as AgentConnections, ollamaCapabilities } from "./connections.js";
import { ProviderStore, type VerifiedOperation } from "@hosty/agent-provider-runtime/store";
import { ProviderController } from "@hosty/agent-provider-runtime/controller";
import type { ProviderAuthority } from "@hosty/agent-provider-runtime/core";
import { AttachmentStore } from "@hosty/agent-provider-runtime/attachments";
import { agentRoutes, json } from "@hosty/agent-provider-runtime/server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server): Promise<string> {
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener.");
  return `http://127.0.0.1:${address.port}`;
}

it("serves real Ollama connection capabilities and content-revision model metadata to the public SDK", async () => {
  const requests: string[] = [];
  const ollama = await listen(createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/version") json(response, 200, { version: "fixture" });
    else if (request.url === "/api/tags") json(response, 200, { models: [{ name: "managed-fixture:latest" }] });
    else if (request.url === "/api/show") json(response, 200, { capabilities: ["completion", "tools"], model_info: { "fixture.context_length": 32768 } });
    else json(response, 404, { error: "Metadata checks must not run inference." });
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-metadata-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const provider = { appId: "third.party.ollama", installationId: "fixture-installation", key: "independent" };
  const registry = new AgentConnections(path.join(directory, "connections"), path.join(directory, "cache"), {
    get: async () => null, set: async () => { throw new Error("Ollama metadata needs no secret."); }, delete: async () => {},
  });
  cleanups.push(() => registry.shutdown());
  const connection = await registry.update({ kind: "ollama", name: "Managed fixture", auth: "none", baseUrl: ollama });
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const proofs = new Map<string, AgentAuthorizationRequest>();
  const authority = { introspect: async (token: string, operation: string, method: string, route: string, bodyHash: string): Promise<VerifiedOperation> => {
    const proof = proofs.get(token); expect(proof).toMatchObject({ operation, method, path: route, bodyHash });
    return { provider, operation: proof!.operation, userId: "operator", principalId: "original-user", callerAppId: "unrelated.consumer", callerInstallation: "consumer-installation", admissionRef: "fixture-admission", sessionId: proof?.sessionId, runId: proof?.runId };
  } } as unknown as ProviderAuthority;
  const controller = new ProviderController(store, authority, registry, ollamaCapabilities);
  const routes = agentRoutes(controller, new AttachmentStore(path.join(directory, "attachments"), provider));
  const origin = await listen(createServer((request, response) => {
    void routes(request, response, new URL(request.url!, "http://fixture.invalid")).catch(error => json(response, error.status ?? 500, { error: { code: error.code, message: error.message } }));
  }));
  const client = new AgentClient({ provider, authorize: async request => {
    const token = randomUUID(); proofs.set(token, request);
    return { provider, baseUrl: `${origin}/api/agent/v1`, token, expiresAt: new Date(Date.now() + 60000).toISOString() };
  } });
  expect((await client.capabilities()).nativeTools).toEqual({ default: "provider_default", none: true });
  expect((await client.connections()).connections).toContainEqual(expect.objectContaining({ id: connection.id, revision: "1", ready: true }));
  const nativeCatalog = await registry.models(connection.id), catalog = await client.models(connection.id);
  expect(catalog).toEqual({ revision: nativeCatalog.revision, defaultModel: "managed-fixture:latest", models: [{ id: "managed-fixture:latest", name: "managed-fixture:latest", reasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
  expect(catalog.revision).toMatch(/^[a-f0-9]{64}$/);
  const session = await client.createSession(randomUUID(), { configuration: { connection: { id: connection.id, revision: "1" } } });
  expect(session.nativeState).toBe("not_created");
  expect(requests).toContain("GET /api/tags"); expect(requests).toContain("POST /api/show");
  expect(requests.every(request => !request.includes("/api/chat"))).toBe(true);
});
