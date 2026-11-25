import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { AgentClient } from "@hosty-sdk/app/agent/client";
import type { AgentAuthorizationRequest } from "@hosty-sdk/app/agent";
import { ClaudeConnections as AgentConnections, claudeCapabilities } from "./connections.js";
import type { ProviderAuthority } from "@hosty/agent-provider-runtime/core";
import { ProviderStore, type VerifiedOperation } from "@hosty/agent-provider-runtime/store";
import { ProviderController } from "@hosty/agent-provider-runtime/controller";
import { AttachmentStore } from "@hosty/agent-provider-runtime/attachments";
import { agentRoutes, json } from "@hosty/agent-provider-runtime/server";

const sdk = vi.hoisted(() => ({ query: vi.fn(), usage: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (input: unknown) => {
  sdk.query(input);
  return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sdk.usage, close: sdk.close };
} }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });

async function fixture(auth: "claude-token" | "api-key" = "claude-token") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-cold-usage-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const secrets = new Map<string, string>(), registry = new AgentConnections(directory, directory, {
    get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  cleanups.push(() => registry.shutdown());
  const connection = await registry.update({ name: "Independent account", kind: "claude", auth, secret: "synthetic" });
  const provider = { appId: "independent.usage-provider", installationId: "fixture-installation", key: "execution" };
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const proofs = new Map<string, AgentAuthorizationRequest>();
  const authority = { introspect: vi.fn(async (token: string, operation: string, method: string, route: string, bodyHash: string): Promise<VerifiedOperation> => {
    const proof = proofs.get(token); expect(proof).toMatchObject({ operation, method, path: route, bodyHash });
    return { provider, operation, userId: "operator", principalId: "original-user", callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "metadata-only" };
  }) } as unknown as ProviderAuthority;
  const controller = new ProviderController(store, authority, registry, claudeCapabilities), routes = agentRoutes(controller, new AttachmentStore(path.join(directory, "attachments"), provider));
  const server = createServer((request, response) => { void routes(request, response, new URL(request.url!, "http://fixture.invalid")).catch(error => json(response, error.status ?? 500, { error: { code: error.code, message: error.message, retryable: false } })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No isolated listener.");
  const origin = `http://127.0.0.1:${address.port}/api/agent/v2`;
  const client = new AgentClient({ provider, authorize: async request => {
    const token = randomUUID(); proofs.set(token, request);
    return { provider, baseUrl: origin, token, expiresAt: new Date(Date.now() + 60000).toISOString() };
  } });
  return { connection, client, registry, store, origin, authority };
}

it("reads cold account limits through public HTTP without a model turn and shares concurrent/repeated diagnostics", async () => {
  const f = await fixture(); let finish: ((value: unknown) => void) | undefined;
  const sample = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12 } } };
  sdk.usage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = [f.client.connectionUsage(f.connection.id), f.client.connectionUsage(f.connection.id)];
  try {
    await vi.waitFor(() => expect(sdk.usage).toHaveBeenCalledOnce()); finish!(sample);
    const values = await Promise.all(pending);
    expect(values[0]).toMatchObject({ available: true, data: { state: "available", rows: [expect.objectContaining({ used: 12 })], connectionRevision: 1 } });
    expect(values[1]?.data).toEqual(values[0]?.data);
    expect((await f.client.connectionUsage(f.connection.id)).data).toEqual(values[0]?.data);
    expect(sdk.query).toHaveBeenCalledOnce(); expect(sdk.usage).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce();
    expect(sdk.usage).toHaveBeenCalledWith({ skipBehaviors: true });
    const input = sdk.query.mock.calls[0]![0];
    expect(typeof input.prompt).not.toBe("string");
    expect(input.options).toMatchObject({ tools: [], mcpServers: {}, persistSession: false, settingSources: [] });
    expect(input.options.abortController.signal.aborted).toBe(true);
    expect(await f.store.records()).toEqual([]);
  } finally { finish?.(sample); await Promise.allSettled(pending); }
});

it("rejects unauthenticated usage before starting a native diagnostic and preserves unsupported API-key state", async () => {
  const f = await fixture("api-key");
  expect((await fetch(`${f.origin}/connections/${f.connection.id}/usage`)).status).toBe(401);
  expect(f.authority.introspect).not.toHaveBeenCalled(); expect(sdk.query).not.toHaveBeenCalled();
  expect(await f.client.connectionUsage(f.connection.id)).toMatchObject({ available: false, data: { state: "unsupported", reason: "unsupported_auth", connectionRevision: 1 } });
  expect(sdk.query).not.toHaveBeenCalled(); expect(await f.store.records()).toEqual([]);
});
