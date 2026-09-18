import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentConnections } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { createGatewayServer } from "../server.js";
import { captureEnv } from "../test-env.js";

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ env: Record<string, string>; resume?: string }>,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: {
    prompt: AsyncIterable<unknown>;
    options: { env: Record<string, string>; resume?: string };
  }) => {
    calls.push(args.options);
    const id = args.options.resume ?? `claude-session-${calls.length}`;
    return Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: id };
        for await (const _message of args.prompt) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Claude reply" }] },
          };
          yield { type: "result", subtype: "success", session_id: id };
        }
      })(),
      { interrupt: async () => {}, close() {} },
    );
  },
}));
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
function token(role = "host.admin") {
  const payload = Buffer.from(
    JSON.stringify({
      sub: "operator",
      role,
      aud: "hosty.ai-gateway",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: "test",
    }),
  ).toString("base64url");
  const input = `hosty_delegated.1.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for session");
}

describe("sessions with provider connections", () => {
  let root: string,
    store: SessionStore,
    registry: AgentConnections,
    manager: SessionManager,
    server: Server,
    origin: string;
  let values: Map<string, string>, restore: () => void;
  const fallback = new FakeHarnessAdapter();
  function newManager() {
    return new SessionManager(
      store,
      fallback,
      new AuditReporter(null, null, "hosty.ai-gateway"),
      root,
      null,
      null,
      null,
      null,
      null,
      null,
      registry,
    );
  }
  beforeEach(async () => {
    calls.length = 0;
    root = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-sessions-"));
    values = new Map();
    restore = captureEnv({
      HOSTY_DELEGATED_TOKEN_PUBLIC_KEY: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      HOSTY_APP_ID: "hosty.ai-gateway",
      HOSTY_AI_GATEWAY_CODEX_COMMAND: path.resolve(
        "test/fake-codex-server.mjs",
      ),
      OPENAI_API_KEY: "inherited-wrong-account",
      ANTHROPIC_API_KEY: "inherited-wrong-account",
    });
    store = new SessionStore(path.join(root, "data"), path.join(root, "cache"));
    registry = new AgentConnections(
      path.join(root, "data"),
      path.join(root, "cache"),
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
    );
    manager = newManager();
    server = createGatewayServer(
      manager,
      fallback,
      null,
      null,
      null,
      null,
      registry,
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await manager.shutdown();
    await registry.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
    await rm(root, { recursive: true, force: true });
  });
  const connection = (kind: "claude" | "codex", name: string = kind) =>
    registry.update({
      name,
      kind,
      auth: "api-key",
      secret: `synthetic-${name}`,
    });
  const request = (
    route: string,
    method = "GET",
    body?: unknown,
    role: string | null = "host.admin",
  ) =>
    fetch(`${origin}/api${route}`, {
      method,
      headers: {
        ...(role ? { authorization: `Bearer ${token(role)}` } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("keeps health endpoints available when a host login cannot resolve its identity", async () => {
    const broken = await registry.update({
      name: "Signed-out host",
      kind: "codex",
      auth: "host-login",
      hostDirectory: path.join(root, "signed-out-home"),
    });
    await registry.setDefault(broken.id);
    await expect(registry.binding(broken.id)).rejects.toMatchObject({
      code: "provider_host_identity_unavailable",
    });
    const checkHealth = async (available: boolean) => {
      for (const response of [await fetch(`${origin}/healthz`), await request("/health")]) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "ok", harness: { available } });
      }
    };
    await checkHealth(false);
    await connection("codex", "Working managed account");
    await checkHealth(true);
  });

  it("runs two providers and two Claude accounts concurrently without environment leakage; binds defaults and resumes identity", async () => {
    const claude = await connection("claude");
    const codex = await connection("codex");
    const otherClaude = await connection("claude", "other");
    await registry.setDefault(claude.id);
    const first = await manager.createSession({
      createdBy: "operator",
      clientRequestId: "stable",
    });
    await registry.setDefault(codex.id);
    expect(
      (
        await manager.createSession({
          createdBy: "operator",
          clientRequestId: "stable",
        })
      ).id,
    ).toBe(first.id);
    const second = await manager.createSession({ createdBy: "operator" });
    const third = await manager.createSession({
      createdBy: "operator",
      connectionId: otherClaude.id,
    });
    await Promise.all([
      manager.postMessage(first.id, "hello"),
      manager.postMessage(second.id, "hello"),
      manager.postMessage(third.id, "hello"),
    ]);
    for (const s of [first, second, third])
      await waitFor(async () =>
        (await store.readEvents(s.id)).some((e) => e.type === "result"),
      );
    expect(calls.map((c) => c.env.ANTHROPIC_API_KEY).sort()).toEqual([
      "synthetic-claude",
      "synthetic-other",
    ]);
    expect(new Set(calls.map((c) => c.env.CLAUDE_CONFIG_DIR)).size).toBe(2);
    expect(calls.every((c) => !c.env.OPENAI_API_KEY)).toBe(true);
    expect(
      (await manager.sessionHealth(first.id)).capabilities.denyReason,
    ).toBe(true);
    expect(
      (await manager.sessionHealth(second.id)).capabilities.denyReason,
    ).toBe(false);
    await expect(
      manager.setConnection(first.id, codex.id, false),
    ).rejects.toMatchObject({ code: "provider_locked" });
    const nativeId = (await manager.getSession(first.id))!.harnessSessionId;
    await manager.shutdown();
    manager = newManager();
    await manager.postMessage(first.id, "resume");
    await waitFor(async () => calls.some((c) => c.resume === nativeId));
    expect((await manager.getSession(first.id))!.connectionId).toBe(claude.id);
    values.delete(claude.secretKey);
    const count = (await store.readEvents(first.id)).length;
    await expect(
      manager.postMessage(first.id, "blocked"),
    ).rejects.toMatchObject({ code: "provider_reconnect_required" });
    expect((await store.readEvents(first.id)).length).toBe(count);
    expect((await manager.sessionHealth(second.id)).available).toBe(true);
    expect((await registry.summary()).available).toBe(true);
  });

  it("allows empty-chat selection, requires explicit binding for old chats, and preserves removed connection history", async () => {
    const c = await connection("codex");
    const blank = await manager.createSession({ createdBy: "operator" });
    await expect(
      manager.postMessage(blank.id, "no provider"),
    ).rejects.toMatchObject({ code: "provider_required" });
    await manager.setConnection(blank.id, c.id, false);
    const legacy = {
      ...(await manager.createSession({ createdBy: "operator" })),
      id: "legacy",
      providerLocked: undefined,
      harnessSessionId: "legacy-native-thread",
    };
    await store.createSession(legacy);
    await store.appendEvent(legacy.id, {
      seq: 1,
      ts: new Date().toISOString(),
      type: "user_message",
      text: "old prompt",
    });
    await expect(
      manager.setConnection(legacy.id, c.id, false),
    ).rejects.toMatchObject({ code: "provider_legacy_confirmation" });
    await manager.setConnection(legacy.id, c.id, true);
    await manager.postMessage(legacy.id, "hello");
    await waitFor(async () =>
      (await store.readEvents(legacy.id)).some((e) => e.type === "result"),
    );
    expect((await manager.getSession(legacy.id))!.harnessSessionId).toBe(
      "legacy-native-thread",
    );
    await manager.cancelSession(legacy.id);
    await registry.remove(c.id);
    expect(
      (await store.readEvents(legacy.id)).some((e) => e.text === "old prompt"),
    ).toBe(true);
    await expect(manager.postMessage(legacy.id, "again")).rejects.toMatchObject(
      { code: "provider_not_found" },
    );
  });

  it("gates provider APIs, keeps credentials out of responses, and applies capabilities from the chat, not default", async () => {
    for (const role of [null, "host.member"]) {
      expect(
        (await request("/connections", "GET", undefined, role)).status,
      ).toBe(401);
      expect(
        (await request("/connections", "POST", { name: "x" }, role)).status,
      ).toBe(401);
      expect(
        (await request("/provider-logins/unknown", "GET", undefined, role))
          .status,
      ).toBe(401);
    }
    const result = await request("/connections", "POST", {
      name: "API",
      kind: "codex",
      auth: "api-key",
      secret: "synthetic-http-secret",
    });
    expect(result.status).toBe(201);
    const c = (await result.json()) as { id: string };
    expect(JSON.stringify(c)).not.toContain("synthetic-http-secret");
    expect(await (await request("/connections")).text()).not.toContain(
      "synthetic-http-secret",
    );
    const s = (await (
      await request("/sessions", "POST", { connectionId: c.id })
    ).json()) as { id: string };
    const claude = await connection("claude");
    await registry.setDefault(claude.id);
    const health = (await (
      await request(`/health?sessionId=${s.id}`)
    ).json()) as { harness: { capabilities: { denyReason: boolean } } };
    expect(health.harness.capabilities.denyReason).toBe(false);
    expect(
      (
        await request(`/sessions/${s.id}/approvals/unknown`, "POST", {
          decision: "deny",
          message: "reason",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/sessions/${s.id}/provider`, "PUT", {
          connectionId: claude.id,
        })
      ).status,
    ).toBe(200);
    const changed = (await (
      await request(`/health?sessionId=${s.id}`)
    ).json()) as typeof health;
    expect(changed.harness.capabilities.denyReason).toBe(true);
  });
});
