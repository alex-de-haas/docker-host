import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentConfiguration, AgentRunInput, AgentSessionCreate } from "@hosty-sdk/app/agent";
import type { AgentConnection } from "@hosty/agent-provider-runtime/connections/registry";
import { ClaudeConnections, claudeCapabilities, claudeSettings } from "./connections.js";
import { CodexConnections, codexCapabilities, codexSettings } from "../../codex-provider/src/connections.js";
import { captureEnv } from "@hosty/agent-provider-runtime/test-env";
import { ProviderStore, type VerifiedOperation } from "@hosty/agent-provider-runtime/store";
import { ProviderController } from "@hosty/agent-provider-runtime/controller";
import type { ProviderAuthority } from "@hosty/agent-provider-runtime/core";
import { NativeExecution } from "@hosty/agent-provider-runtime/native-driver";
import { AttachmentStore } from "@hosty/agent-provider-runtime/attachments";
import { createProviderSettings } from "@hosty/agent-provider-runtime/settings";
import { TrackedNativeProcesses } from "@hosty/agent-provider-runtime/tracked-process";

const sdk = vi.hoisted(() => ({ calls: [] as Array<{ env: NodeJS.ProcessEnv; resume?: string }>, wrongResume: false, hold: false }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: { prompt: AsyncIterable<unknown>; options: { env: NodeJS.ProcessEnv; resume?: string } }) => {
  sdk.calls.push(args.options);
  const id = args.options.resume ? sdk.wrongResume ? "unexpected-native-session" : args.options.resume : `native-claude-${sdk.calls.length}`;
  return Object.assign((async function* () {
    yield { type: "system", subtype: "init", session_id: id };
    for await (const _message of args.prompt) { yield { type: "assistant", message: { content: [{ type: "text", text: "Account-scoped answer" }] } }; if (!sdk.hold) { yield { type: "result", subtype: "success", session_id: id }; yield { type: "system", subtype: "session_state_changed", session_id: id, state: "idle" }; } }
  })(), { interrupt: async () => {}, close() {}, applyFlagSettings: async () => {} });
} }));

const cleanup: Array<() => Promise<void>> = [];
let directory: string, restore: () => void;
beforeEach(async () => {
  sdk.calls.length = 0; sdk.wrongResume = false; sdk.hold = false; directory = await mkdtemp(path.join(os.tmpdir(), "hosty-public-connections-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  restore = captureEnv({ HOSTY_HARNESS_CODEX_COMMAND: fileURLToPath(new URL("../../codex-provider/test/fake-codex-server.mjs", import.meta.url)), OPENAI_API_KEY: "inherited-wrong-account", ANTHROPIC_API_KEY: "inherited-wrong-account" });
});
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { restore(); } });

async function provider(kind: "claude" | "codex", retainedSecrets = new Map<string, string>()) {
  const root = path.join(directory, kind), ref = { appId: `independent.example.${kind}`, installationId: `${kind}-installation`, key: "execution" };
  const actor: VerifiedOperation = { userId: "operator", principalId: "original-user", callerAppId: "unrelated.consumer", callerInstallation: "consumer-installation", operation: "runs.start", admissionRef: `opaque_${kind}_authority`, provider: ref };
  const registry = new (kind === "claude" ? ClaudeConnections : CodexConnections)(path.join(root, "accounts"), path.join(root, "cache"), { get: async key => retainedSecrets.get(key) ?? null, set: async (key, value) => { retainedSecrets.set(key, value); }, delete: async key => { retainedSecrets.delete(key); } });
  const store = new ProviderStore(path.join(root, "sessions"), ref); await store.initialize();
  const authority = { admit: vi.fn(async () => ({})), renew: vi.fn(async () => ({})), workspace: vi.fn(async () => ({})), skills: vi.fn(async () => { throw new Error("A plain turn needs no skill catalog authority."); }) } as unknown as ProviderAuthority;
  const controller = new ProviderController(store, authority, registry, kind === "claude" ? claudeCapabilities : codexCapabilities);
  const driver = new NativeExecution(controller, store, authority, registry, new AttachmentStore(path.join(root, "assets"), ref), root, () => "http://127.0.0.1:1");
  controller.driver = driver; await driver.initialize();
  let closed = false; const close = async () => { if (!closed) { closed = true; await controller.close(); } }; cleanup.push(close);
  return { kind, root, ref, actor, registry, store, authority, controller, driver, retainedSecrets, close };
}
type Fixture = Awaited<ReturnType<typeof provider>>;
async function account(f: Fixture, name: string) { return f.registry.update({ kind: f.kind, name, auth: "api-key", secret: `synthetic-${name}` }); }
function configuration(connection: AgentConnection): AgentConfiguration { return { connection: { id: connection.id, revision: String(connection.revision) } }; }
async function session(f: Fixture, connection: AgentConnection, id = randomUUID()) {
  const input: AgentSessionCreate = { configuration: configuration(connection) };
  return f.controller.createSession(id, input, JSON.stringify(input), f.actor);
}
async function turn(f: Fixture, sessionId: string, continuation: "start" | "resume" = "start", text = "hello") {
  const current = (await f.store.load(sessionId)).session, id = randomUUID();
  const input: AgentRunInput = { expectedSessionRevision: current.revision, configurationRevision: current.configurationRevision, continuation, input: { text } };
  await f.controller.startRun(sessionId, id, input, JSON.stringify(input), f.actor);
  try { await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true), { timeout: 10000, interval: 20 }); }
  catch { const snapshot = await f.controller.snapshot(id), native = await f.driver.engine.journal.load(id).catch(() => null);
    throw new Error(JSON.stringify({ kind: f.kind, state: snapshot.state, phase: snapshot.phase, nativeState: native?.receipt.state, error: native?.receipt.error, evidence: await TrackedNativeProcesses.readEvidence(f.root, id, snapshot.generation) })); }
  return f.controller.snapshot(id);
}
async function settings(f: Fixture) {
  const handler = createProviderSettings({ definition: f.kind === "claude" ? claudeSettings : codexSettings, connections: f.registry,
    isConnectionInUse: async id => (await f.store.records()).some(value => value.session.activeRun && value.session.configuration?.connection.id === id),
    env: { HOSTY_APP_ID: f.ref.appId, HOSTY_CORE_ORIGIN: "http://isolated-core.test", HOSTY_APP_SERVICE_TOKEN: "synthetic-own-service" },
    fetch: vi.fn(async (_url, init) => { const token = JSON.parse(String(init?.body)).accessToken as string;
      return Response.json({ active: true, appId: token === "hostyg_other" ? "different.provider" : f.ref.appId, userId: "operator", hostRole: token === "hostyg_member" ? "host.user" : "host.admin" }); }) as typeof fetch });
  const server: Server = createServer((request, response) => { void handler(request, response, new URL(request.url!, "http://isolated.test").pathname).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("No isolated listener");
  return (route: string, method = "GET", input?: unknown, token: string | null = "hostyg_own") => fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
}

describe("provider-owned accounts and public sessions", () => {
  it("pins explicit connection revisions and exact session retries across default changes", async () => {
    const f = await provider("claude"), first = await account(f, "first"), id = randomUUID(), input = { configuration: configuration(first) };
    const initial = await f.controller.createSession(id, input, JSON.stringify(input), f.actor), second = await account(f, "second"); await f.registry.setDefault(second.id);
    expect(await f.controller.createSession(id, input, JSON.stringify(input), f.actor)).toEqual(initial);
    expect((await f.store.load(id)).session.configuration?.connection.id).toBe(first.id);
    expect((await session(f, second)).configuration?.connection.id).toBe(second.id);
    expect(sdk.calls).toEqual([]);
  });
  it("runs two Claude accounts and an independent Codex provider without ambient credential leakage", async () => {
    const claude = await provider("claude"), codex = await provider("codex");
    const a = await account(claude, "claude-a"), b = await account(claude, "claude-b"), c = await account(codex, "codex-c");
    const [sa, sb, sc] = await Promise.all([session(claude, a), session(claude, b), session(codex, c)]);
    const [ra, rb, rc] = await Promise.all([turn(claude, sa.ref.id), turn(claude, sb.ref.id), turn(codex, sc.ref.id)]);
    expect([ra.state, rb.state, rc.state]).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(sdk.calls.map(call => call.env.ANTHROPIC_API_KEY).sort()).toEqual(["synthetic-claude-a", "synthetic-claude-b"]);
    expect(new Set(sdk.calls.map(call => call.env.CLAUDE_CONFIG_DIR)).size).toBe(2);
    expect(sdk.calls.every(call => !call.env.OPENAI_API_KEY && !call.env.HOSTY_APP_SERVICE_TOKEN)).toBe(true);
    await expect(codex.store.run(ra.ref.id, codex.actor)).rejects.toMatchObject({ status: 404 });
    expect(claude.controller.capabilities.capabilities).toContain("decisions.deny-reason"); expect(codex.controller.capabilities.capabilities).not.toContain("decisions.deny-reason");
    expect(JSON.stringify([sa, sb, sc, ra, rb, rc])).not.toContain("synthetic-claude-a");
    expect(claude.authority.skills).not.toHaveBeenCalled(); expect(codex.authority.skills).not.toHaveBeenCalled();
  }, 15000); // Includes isolated Node login/app-server processes and durable runner teardown.
  it("resumes the exact native identity after provider restart and rejects a silent replacement", async () => {
    const f = await provider("claude"), connection = await account(f, "resume"), created = await session(f, connection);
    const first = await turn(f, created.ref.id), nativeId = (await f.store.load(created.ref.id)).nativeId; await f.close();
    const restarted = await provider("claude", f.retainedSecrets); expect(sdk.calls).toHaveLength(1);
    expect((await turn(restarted, created.ref.id, "resume")).state).toBe("succeeded"); expect(sdk.calls[1]?.resume).toBe(nativeId);
    sdk.wrongResume = true; const failed = await turn(restarted, created.ref.id, "resume");
    expect(failed.state).toBe("failed"); expect((await restarted.store.load(created.ref.id)).nativeId).toBe(nativeId);
    expect((await restarted.controller.snapshot(first.ref.id)).result).toEqual(first.result);
  });
  it("requires native continuation, locks its account revision, and never rebinds to the new default", async () => {
    const f = await provider("claude"), a = await account(f, "locked"), b = await account(f, "new-default"), created = await session(f, a);
    await turn(f, created.ref.id); await f.registry.setDefault(b.id);
    const current = (await f.store.load(created.ref.id)).session, change = { requestId: randomUUID(), expectedSessionRevision: current.revision, configuration: configuration(b) };
    await expect(f.controller.configureSession(created.ref.id, change, JSON.stringify(change), f.actor)).rejects.toMatchObject({ code: "connection_fixed" });
    const input: AgentRunInput = { expectedSessionRevision: current.revision, configurationRevision: current.configurationRevision, continuation: "start", input: { text: "wrong continuation" } };
    await expect(f.controller.startRun(created.ref.id, randomUUID(), input, JSON.stringify(input), f.actor)).rejects.toMatchObject({ code: "continuation_required" });
    const changed = await f.registry.update({ name: "Credential replacement", secret: "synthetic-replacement" }, a.id);
    expect(changed.revision).toBeGreaterThan(a.revision); const count = sdk.calls.length;
    expect((await turn(f, created.ref.id, "resume")).state).toBe("failed"); expect(sdk.calls).toHaveLength(count);
    expect((await f.store.load(created.ref.id)).session.configuration?.connection).toEqual(configuration(a).connection);
  });
  it("preserves prior output when selected credentials or the connection disappear", async () => {
    const f = await provider("claude"), connection = await account(f, "removed"), created = await session(f, connection), first = await turn(f, created.ref.id), count = sdk.calls.length;
    f.retainedSecrets.delete(connection.secretKey);
    expect((await turn(f, created.ref.id, "resume")).state).toBe("failed"); expect(sdk.calls).toHaveLength(count);
    await f.registry.remove(connection.id);
    expect((await turn(f, created.ref.id, "resume")).state).toBe("failed"); expect(sdk.calls).toHaveLength(count);
    expect((await f.controller.snapshot(first.ref.id)).result).toEqual(first.result);
  });
  it("authenticates own-app settings with real account storage and keeps secrets out of public responses", async () => {
    const f = await provider("claude"), connection = await account(f, "private"), request = await settings(f);
    expect((await request("/api/settings/connections", "GET", undefined, null)).status).toBe(401);
    expect((await request("/api/settings/connections", "GET", undefined, "hostyg_member")).status).toBe(403);
    expect((await request("/api/settings/connections", "GET", undefined, "hostyg_other")).status).toBe(503);
    const response = await request("/api/settings/connections"), text = await response.text(); expect(response.status).toBe(200);
    expect(text).toContain(connection.id); expect(text).not.toContain("synthetic-private"); expect(text).not.toContain("secretKey");
    expect((await request("/api/settings/connections", "POST", { name: "Cross-kind", kind: "codex", auth: "api-key", secret: "synthetic" })).status).toBe(400);
    expect((await request(`/api/settings/connections/${connection.id}`, "PUT", { name: "Stale", expectedRevision: "0" })).status).toBe(409);
    await session(f, connection);
    expect((await readFile(f.store.databasePath)).includes("synthetic-private")).toBe(false);
  });
  it("blocks settings replacement, removal and relogin while a public run owns the selected account", async () => {
    sdk.hold = true;
    const f = await provider("claude"), connection = await account(f, "active"), created = await session(f, connection), request = await settings(f), id = randomUUID();
    const command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Keep the native query open" } };
    await f.controller.startRun(created.ref.id, id, command, JSON.stringify(command), f.actor);
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));
    for (const method of ["PUT", "DELETE", "LOGIN"]) {
      const response = await request(`/api/settings/connections/${connection.id}` + (method === "LOGIN" ? "/login" : ""), method === "LOGIN" ? "POST" : method, { expectedRevision: "1", ...(method === "PUT" ? { secret: "synthetic-replacement" } : {}) });
      expect(response.status).toBe(409);
    }
    expect((await f.registry.get(connection.id)).revision).toBe(1); expect(f.retainedSecrets.get(connection.secretKey)).toBe("synthetic-active");
  });
});
