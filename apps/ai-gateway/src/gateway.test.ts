import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SessionStore } from "./sessions/store.js";
import { SessionManager } from "./sessions/manager.js";
import { FakeHarnessAdapter } from "./harness/fake.js";
import { createGatewayServer } from "./server.js";
import { AuditReporter } from "./audit.js";

// One ECDSA key pair for the suite: tokens are minted exactly the way Core mints them, and the
// public half goes into the env the SDK validator reads.
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function mintToken(role: string, appId = "hosty.ai-gateway", sub = "user_admin", ttlSeconds = 300): string {
  const claims = {
    sub,
    role,
    aud: appId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: "test",
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `hosty_delegated.1.${payload}`;
  const signature = signData("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("gateway", () => {
  let dataDir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    process.env.HOSTY_DELEGATED_TOKEN_PUBLIC_KEY = publicKeyBase64;
    process.env.HOSTY_APP_ID = "hosty.ai-gateway";
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-gateway-test-"));
    store = new SessionStore(dataDir);
    manager = new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.ai-gateway"), dataDir);
    server = createGatewayServer(manager, new FakeHarnessAdapter());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.HOSTY_DELEGATED_TOKEN_PUBLIC_KEY;
    delete process.env.HOSTY_APP_ID;
  });

  function call(pathName: string, init: RequestInit = {}, role: string | null = "host.admin"): Promise<Response> {
    const headers = new Headers(init.headers);
    if (role) {
      headers.set("authorization", `Bearer ${mintToken(role)}`);
    }
    headers.set("content-type", "application/json");
    return fetch(`${origin}${pathName}`, { ...init, headers });
  }

  it("rejects missing and non-admin tokens", async () => {
    const anonymous = await call("/api/sessions", { method: "GET" }, null);
    expect(anonymous.status).toBe(401);

    const member = await call("/api/sessions", { method: "GET" }, "host.member");
    expect(member.status).toBe(401);
  });

  it("serves health without a token, including harness availability", async () => {
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { harness: { name: string; available: boolean } };
    expect(body.harness.available).toBe(true);
  });

  it("answers preflight with CORS headers", async () => {
    const preflight = await fetch(`${origin}/api/sessions`, {
      method: "OPTIONS",
      headers: { origin: "http://shell.local:7171" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://shell.local:7171");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("runs a message turn end to end", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({ title: "Test" }) });
    expect(created.status).toBe(200);
    const record = (await created.json()) as { id: string };

    const posted = await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    expect(posted.status).toBe(202);

    const events = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result event");

    const texts = events.filter((event) => event.type === "assistant_text").map((event) => event.text);
    expect(texts).toContain("echo: hello");

    const session = await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.status === "idle" ? current : null;
    }, "idle status");
    expect(session.harnessSessionId).toContain("fake-");
  });

  it("pauses a proposed write until approval and resumes on allow", async () => {
    const record = (await (
      await call("/api/sessions", { method: "POST", body: "{}" })
    ).json()) as { id: string };

    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "please write the file" }),
    });

    const approval = await waitFor(async () => {
      const events = await store.readEvents(record.id);
      return events.find((event) => event.type === "approval_request") ?? null;
    }, "approval request");
    await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.status === "awaiting_approval" ? current : null;
    }, "awaiting_approval status");

    const approved = await call(`/api/sessions/${record.id}/approvals/${approval.approvalId as string}`, {
      method: "POST",
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(approved.status).toBe(200);

    const events = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result after approval");
    expect(events.some((event) => event.type === "tool_use")).toBe(true);
    expect(events.some((event) => event.type === "approval_decision")).toBe(true);

    // A second decision on the same approval is a conflict, not a replay.
    const replayed = await call(`/api/sessions/${record.id}/approvals/${approval.approvalId as string}`, {
      method: "POST",
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(replayed.status).toBe(409);
  });

  it("denies a proposed write without executing it", async () => {
    const record = (await (
      await call("/api/sessions", { method: "POST", body: "{}" })
    ).json()) as { id: string };

    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "write it" }),
    });
    const approval = await waitFor(async () => {
      const events = await store.readEvents(record.id);
      return events.find((event) => event.type === "approval_request") ?? null;
    }, "approval request");

    await call(`/api/sessions/${record.id}/approvals/${approval.approvalId as string}`, {
      method: "POST",
      body: JSON.stringify({ decision: "deny" }),
    });

    const events = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result after denial");
    expect(events.some((event) => event.type === "tool_use")).toBe(false);
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toContain(
      "skipped",
    );
  });

  it("replays persisted events to a late subscriber from a cursor", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello");
    await waitFor(async () => {
      const events = await store.readEvents(record.id);
      return events.some((event) => event.type === "result") ? events : null;
    }, "turn completion");

    const seen: number[] = [];
    const { replay, unsubscribe } = await manager.subscribe(record.id, 1, (event) => seen.push(event.seq));
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.every((event) => event.seq > 1)).toBe(true);
    unsubscribe();
  });

  it("cancels a session and reports 404 for unknown ones", async () => {
    const record = (await (
      await call("/api/sessions", { method: "POST", body: "{}" })
    ).json()) as { id: string };

    const cancelled = await call(`/api/sessions/${record.id}/cancel`, { method: "POST", body: "{}" });
    expect(cancelled.status).toBe(200);
    expect((await manager.getSession(record.id))?.status).toBe("cancelled");

    const missing = await call("/api/sessions/00000000-0000-0000-0000-000000000000", { method: "GET" });
    expect(missing.status).toBe(404);
  });

  it("closes the event stream when the delegated token expires", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    const shortLived = mintToken("host.admin", "hosty.ai-gateway", "user_admin", 1);

    const started = Date.now();
    const response = await fetch(`${origin}/api/sessions/${record.id}/events`, {
      headers: { authorization: `Bearer ${shortLived}` },
    });
    expect(response.status).toBe(200);
    // text() resolves only when the server ends the stream — which must happen at token expiry,
    // not never (a revoked admin's open stream would otherwise outlive their access).
    await response.text();
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("drops a failed harness run so the next message starts a fresh one", async () => {
    let starts = 0;
    const failing: import("./harness/adapter.js").HarnessAdapter = {
      name: "failing",
      probe: async () => ({ available: true }),
      start: (options) => {
        starts += 1;
        const runIndex = starts;
        return {
          send: () =>
            queueMicrotask(() => {
              if (runIndex === 1) {
                options.onEvent({ type: "error", message: "boom" });
              } else {
                options.onEvent({ type: "assistant_text", text: "recovered" });
                options.onEvent({ type: "result", status: "success" });
              }
            }),
          resolveApproval: () => false,
          interrupt: async () => {},
          stop: async () => {},
        };
      },
    };
    const localManager = new SessionManager(
      store,
      failing,
      new AuditReporter(null, null, "hosty.ai-gateway"),
      dataDir,
    );
    const record = await localManager.createSession({ createdBy: "user_admin" });

    await localManager.postMessage(record.id, "first");
    await waitFor(async () => {
      const current = await localManager.getSession(record.id);
      return current?.status === "failed" ? current : null;
    }, "failed status");

    await localManager.postMessage(record.id, "second");
    await waitFor(async () => {
      const events = await store.readEvents(record.id);
      return events.some((event) => event.type === "assistant_text" && event.text === "recovered")
        ? events
        : null;
    }, "recovery on a fresh run");
    expect(starts).toBe(2);
    await localManager.shutdown();
  });

  it("sweeps sessions past retention", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    const fresh = await manager.createSession({ createdBy: "user_admin" });

    const stale = (await store.readRecord(record.id))!;
    stale.updatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await store.saveRecord(stale);

    const deleted = await store.sweepRetention(30);
    expect(deleted).toEqual([record.id]);
    expect(await store.readRecord(record.id)).toBeNull();
    expect(await store.readRecord(fresh.id)).not.toBeNull();
  });
});
