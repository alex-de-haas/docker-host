import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { Script } from "node:vm";
import { SessionStore } from "./sessions/store.js";
import { SettingsStore } from "./settings/store.js";
import { ProviderDirectory } from "./settings/providers.js";
import { SessionManager } from "./sessions/manager.js";
import { FakeHarnessAdapter } from "./harness/fake.js";
import { createGatewayServer } from "./server.js";
import { AuditReporter } from "./audit.js";
import { captureEnv } from "./test-env.js";

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
  let settings: SettingsStore;
  let manager: SessionManager;
  let server: Server;
  let origin: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    // The last two are borrowed rather than set: individual tests point them at a stub Core they
    // then close, and restoring is what keeps a session from resolving against a dead port.
    restoreEnv = captureEnv({
      HOSTY_DELEGATED_TOKEN_PUBLIC_KEY: publicKeyBase64,
      HOSTY_APP_ID: "hosty.ai-gateway",
      HOSTY_CORE_ORIGIN: undefined,
      HOSTY_APP_SERVICE_TOKEN: undefined,
    });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-gateway-test-"));
    store = new SessionStore(dataDir);
    settings = new SettingsStore(dataDir);
    manager = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.ai-gateway"),
      dataDir,
      settings,
    );
    server = createGatewayServer(manager, new FakeHarnessAdapter(), settings);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    restoreEnv();
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

  it("names an unnamed session after its first message", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string; title: string | null };
    expect(record.title).toBeNull();

    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Why did telemetry stop?\n\nfatal: bind EADDRINUSE" }),
    });

    const named = await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.title ? current : null;
    }, "derived title");
    expect(named.title).toBe("Why did telemetry stop?");
  });

  it("keeps a name the operator chose, and never re-derives over it", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({ title: "disk pressure" }) });
    const record = (await created.json()) as { id: string; title: string };
    expect(record.title).toBe("disk pressure");

    await call(`/api/sessions/${record.id}/messages`, { method: "POST", body: JSON.stringify({ text: "anything else" }) });
    await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.status === "idle" ? current : null;
    }, "idle status");

    // The point of the test: a turn ran, and the session is still called what the operator called it.
    expect((await manager.getSession(record.id))?.title).toBe("disk pressure");
  });

  it("renames a session, and an emptied title returns it to being derived", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };

    const renamed = await call(`/api/sessions/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "  collector  restart " }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { title: string }).title).toBe("collector restart");

    const cleared = await call(`/api/sessions/${record.id}`, { method: "PATCH", body: JSON.stringify({ title: "" }) });
    expect(((await cleared.json()) as { title: string | null }).title).toBeNull();

    // Cleared means derivable again — the alternative is a session pinned to no name for good.
    await call(`/api/sessions/${record.id}/messages`, { method: "POST", body: JSON.stringify({ text: "restart it" }) });
    const named = await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.title ? current : null;
    }, "re-derived title");
    expect(named.title).toBe("restart it");
  });

  it("names a session that predates titles after the message it opened with", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };
    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Why did telemetry stop?" }),
    });
    await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.status === "idle" ? current : null;
    }, "idle status");

    // Exactly the shape upgrading leaves behind: a conversation in the log, no title on the record.
    const stored = (await manager.getSession(record.id))!;
    stored.title = null;
    delete stored.titleSource;
    await store.saveRecord(stored);

    await call(`/api/sessions/${record.id}/messages`, { method: "POST", body: JSON.stringify({ text: "and now?" }) });
    const named = await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.title ? current : null;
    }, "backfilled title");
    // Not "and now?" — a session is named after what it is about, not after its latest turn.
    expect(named.title).toBe("Why did telemetry stop?");
  });

  it("refuses a rename whose title is not a string, and survives a body that is not an object", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({ title: "chosen" }) });
    const record = (await created.json()) as { id: string };

    // `null` reads as "clear it" only if nobody checks; clearing is the empty string's job, and an
    // operator's chosen name must not fall to a client sending the wrong type.
    expect((await call(`/api/sessions/${record.id}`, { method: "PATCH", body: JSON.stringify({ title: null }) })).status).toBe(400);
    expect((await call(`/api/sessions/${record.id}`, { method: "PATCH", body: JSON.stringify({ title: 7 }) })).status).toBe(400);
    // Valid JSON, not a body. Reading a field off it must not become a 500.
    expect((await call(`/api/sessions/${record.id}`, { method: "PATCH", body: "null" })).status).toBe(400);
    expect((await call(`/api/sessions/${record.id}`, { method: "PATCH", body: "[1,2]" })).status).toBe(400);
    expect((await manager.getSession(record.id))?.title).toBe("chosen");
  });

  it("deletes a session, its transcript, and the run producing it", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };
    await call(`/api/sessions/${record.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
    await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result event");

    const deleted = await call(`/api/sessions/${record.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    expect(await manager.getSession(record.id)).toBeNull();
    // The transcript is gone from disk, not merely unlisted: a deleted conversation that a later
    // read could still recover would make the button a lie.
    expect(await store.readEvents(record.id)).toEqual([]);
    expect((await call("/api/sessions", { method: "GET" }).then((r) => r.json())) as { sessions: unknown[] }).toEqual({
      sessions: [],
    });
    expect((await call(`/api/sessions/${record.id}`, { method: "DELETE" })).status).toBe(404);
    // A stream opened for a session that is gone must refuse before committing a 200: the client
    // treats a clean EOF as a dropped connection and reconnects, so an empty 200 would loop.
    const stream = await fetch(`${origin}/api/sessions/${record.id}/events`, {
      headers: { authorization: `Bearer ${mintToken("host.admin")}` },
    });
    expect(stream.status).toBe(404);
    await stream.body?.cancel();
  });

  it("attributes a deletion to the administrator who asked for it", async () => {
    const reports: { action: string; details: Record<string, string> }[] = [];
    const reporting = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      { report: (action: string, details: Record<string, string>) => reports.push({ action, details }) } as unknown as AuditReporter,
      dataDir,
    );
    const record = await reporting.createSession({ createdBy: "user_author" });

    await reporting.deleteSession(record.id, "user_deleter");

    const deletion = reports.find((entry) => entry.action === "ai_session_deleted");
    // Both, deliberately: the transcript is unrecoverable afterwards, and "who removed it" is a
    // different question from "whose session was it".
    expect(deletion?.details).toMatchObject({ sessionId: record.id, deletedBy: "user_deleter", createdBy: "user_author" });
  });

  it("ends the event stream of a session that is deleted under it", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };

    const stream = await fetch(`${origin}/api/sessions/${record.id}/events`, {
      headers: { authorization: `Bearer ${mintToken("host.admin")}` },
    });
    const reader = stream.body!.getReader();

    await call(`/api/sessions/${record.id}`, { method: "DELETE" });

    // Read to the end: the subscriber is told before the record goes, and the connection closes —
    // otherwise another tab sits on a stream that has stopped meaning anything.
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain("session_deleted");
  });

  it("refuses a rename without a title, and 404s an unknown session", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };

    expect((await call(`/api/sessions/${record.id}`, { method: "PATCH", body: JSON.stringify({}) })).status).toBe(400);
    expect(
      (await call("/api/sessions/does-not-exist", { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status,
    ).toBe(404);
  });

  it("advertises the methods its routes answer, so a preflight does not fail alone", async () => {
    const preflight = await fetch(`${origin}/api/sessions/any`, {
      method: "OPTIONS",
      headers: { origin: "http://shell.local:7171" },
    });
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
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
      body: JSON.stringify({ decision: "deny", message: "  use the other host\nand take a backup first  " }),
    });

    const events = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result after denial");
    expect(events.some((event) => event.type === "tool_use")).toBe(false);
    // The reason reaches the harness behind the fixed prefix and on one line: a second line would
    // arrive unprefixed and read like an instruction of its own. The stored copy is the same line.
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toContain(
      "skipped: Denied by the operator in Hosty: use the other host and take a backup first",
    );
    expect(events.find((event) => event.type === "approval_decision")?.message).toBe(
      "use the other host and take a backup first",
    );
  });

  it("refuses a deny reason on a harness whose decline cannot carry one", async () => {
    // Stored-but-undelivered would be the worst outcome: the transcript would show a reason the
    // model never saw. The panel hides the box on such a harness; this covers every other client.
    const declineOnly: import("./harness/adapter.js").HarnessAdapter = {
      name: "decline-only",
      capabilities: { questions: false, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false },
      probe: async () => ({ available: true }),
      start: () => {
        throw new Error("the route under test never starts a run");
      },
    };
    const strict = createGatewayServer(manager, declineOnly, settings);
    await new Promise<void>((resolve) => strict.listen(0, resolve));
    const strictOrigin = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${mintToken("host.admin")}`, "content-type": "application/json" };

    try {
      const record = (await (await call("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
      await call(`/api/sessions/${record.id}/messages`, { method: "POST", body: JSON.stringify({ text: "write it" }) });
      const approval = await waitFor(async () => {
        const events = await store.readEvents(record.id);
        return events.find((event) => event.type === "approval_request") ?? null;
      }, "approval request");
      const path = `${strictOrigin}/api/sessions/${record.id}/approvals/${approval.approvalId as string}`;

      const refused = await fetch(path, { method: "POST", headers, body: JSON.stringify({ decision: "deny", message: "why" }) });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { code: string }).code).toBe("deny_reason_unsupported");

      // The refusal is about the reason, not the deny: the same decision without one goes through.
      const plain = await fetch(path, { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) });
      expect(plain.status).toBe(200);
    } finally {
      await new Promise((resolve) => strict.close(resolve));
    }
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

  it("asks a question and delivers the answer the harness acts on", async () => {
    // The assertion that matters is the LAST one: the harness echoed the chosen answer back. A card
    // that renders, closes, and delivers nothing usable is indistinguishable from a working one at
    // the UI level — the same shape of bug that twice slipped through the Codex adapter, where only
    // checking that *allow* performed the action revealed the gate was inert.
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };

    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "please ask me" }),
    });

    const asked = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.find((event) => event.type === "question_request") ?? null;
    }, "question_request event");

    const questions = asked.questions as Array<{ question: string; options: Array<{ label: string }> }>;
    expect(questions[0]!.options.map((option) => option.label)).toEqual(["First", "Second"]);
    expect(await waitFor(async () => {
      const current = await manager.getSession(record.id);
      return current?.status === "awaiting_question" ? current : null;
    }, "awaiting_question status")).toBeTruthy();

    const answered = await call(`/api/sessions/${record.id}/questions/${String(asked.questionId)}`, {
      method: "POST",
      body: JSON.stringify({ answers: { [questions[0]!.question]: "Second" } }),
    });
    expect(answered.status).toBe(200);

    const events = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.some((event) => event.type === "result") ? stored : null;
    }, "result after the answer");
    const texts = events.filter((event) => event.type === "assistant_text").map((event) => event.text);
    expect(texts).toContain("answered: Second");
  });

  it("refuses a second answer to the same question", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };
    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "ask me" }),
    });
    const asked = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.find((event) => event.type === "question_request") ?? null;
    }, "question_request event");
    const question = (asked.questions as Array<{ question: string }>)[0]!.question;

    const first = await call(`/api/sessions/${record.id}/questions/${String(asked.questionId)}`, {
      method: "POST",
      body: JSON.stringify({ answers: { [question]: "First" } }),
    });
    expect(first.status).toBe(200);

    const second = await call(`/api/sessions/${record.id}/questions/${String(asked.questionId)}`, {
      method: "POST",
      body: JSON.stringify({ answers: { [question]: "Second" } }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("question_not_pending");
  });

  it("replays a pending question to a reconnecting client", async () => {
    // Closing the panel drops the stream but not the pause: a reattaching client must be able to
    // rebuild the card, or the harness sits blocked on a question nobody can see.
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };
    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "ask me" }),
    });
    await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.find((event) => event.type === "question_request") ?? null;
    }, "question_request event");

    const replayed: string[] = [];
    const { replay, unsubscribe } = await manager.subscribe(record.id, 0, () => {});
    for (const event of replay) {
      replayed.push(event.type);
    }
    unsubscribe();
    expect(replayed).toContain("question_request");
  });

  it("cancelling a session resolves a pending question", async () => {
    const created = await call("/api/sessions", { method: "POST", body: JSON.stringify({}) });
    const record = (await created.json()) as { id: string };
    await call(`/api/sessions/${record.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "ask me" }),
    });
    const asked = await waitFor(async () => {
      const stored = await store.readEvents(record.id);
      return stored.find((event) => event.type === "question_request") ?? null;
    }, "question_request event");

    const cancelled = await call(`/api/sessions/${record.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);

    // The pause is gone with the run, so answering it now is a 409 rather than a resurrection.
    const late = await call(`/api/sessions/${record.id}/questions/${String(asked.questionId)}`, {
      method: "POST",
      body: JSON.stringify({ answers: { "Which one?": "First" } }),
    });
    expect(late.status).toBe(409);
  });

  it("reports harness capabilities on health", async () => {
    const health = await fetch(`${origin}/healthz`);
    const body = (await health.json()) as {
      harness: { capabilities: { questions: boolean; liveReconfigure: boolean } };
    };
    expect(body.harness.capabilities).toEqual({
      questions: true,
      appMcp: true,
      liveReconfigure: true,
      autoAllow: true,
      denyReason: true,
    });
  });

  it("defaults every MCP provider to off and round-trips settings", async () => {
    const initial = (await (await call("/api/settings")).json()) as {
      settings: { systemPrompt: string; mcpProviders: Record<string, boolean> };
      harness: { capabilities: { questions: boolean } };
      limits: { systemPromptChars: number };
    };
    // Off by default is the security-relevant part: an app that appears in the fleet must not gain a
    // channel into the model's context by being installed. Core is the one exception — its tools are
    // the platform's own — and it is the only key a fresh store answers with.
    expect(initial.settings.mcpProviders).toEqual({ "hosty:core": true });
    expect(initial.settings.systemPrompt).toBe("");
    expect(initial.harness.capabilities.questions).toBe(true);

    const saved = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        systemPrompt: "Prefer the hosty CLI.",
        mcpProviders: { "com.example.notes": true },
      }),
    });
    expect(saved.status).toBe(200);

    // Survives a restart: a fresh store over the same directory reads what was written.
    const reread = await new SettingsStore(dataDir).read();
    expect(reread.systemPrompt).toBe("Prefer the hosty CLI.");
    expect(reread.mcpProviders).toEqual({ "hosty:core": true, "com.example.notes": true });
    expect(initial.limits.systemPromptChars).toBeGreaterThan(0);
  });

  it("rejects a malformed settings write instead of storing it", async () => {
    const badPrompt = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ systemPrompt: 42 }),
    });
    expect(badPrompt.status).toBe(400);

    const badProviders = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ mcpProviders: { "com.example.notes": "yes" } }),
    });
    expect(badProviders.status).toBe(400);

    const oversize = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ systemPrompt: "x".repeat(20_000) }),
    });
    expect(oversize.status).toBe(400);

    expect((await settings.read()).systemPrompt).toBe("");
  });

  it("prunes provider toggles for apps that are gone", async () => {
    await settings.update({ mcpProviders: { "com.example.kept": true, "com.example.gone": true } });
    const pruned = await settings.prune(["com.example.kept"]);
    // Otherwise an uninstall/reinstall cycle would silently resurrect an enabled provider.
    expect(pruned.mcpProviders).toEqual({ "hosty:core": true, "com.example.kept": true });
  });

  it("requires a token for settings like every other /api route", async () => {
    expect((await call("/api/settings", { method: "GET" }, null)).status).toBe(401);
    expect((await call("/api/settings", { method: "GET" }, "host.member")).status).toBe(401);
  });

  it("serves the settings page shell without a token", async () => {
    // The shell holds no data; everything it renders comes from the admin-gated API above. Serving
    // it unauthenticated is what lets Shell embed it as an ordinary app UI — and is safe precisely
    // because it is a bundle, not a rendering of anything.
    const page = await fetch(`${origin}/settings`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    // The built export, not the old hand-written template: its script tags are what the page needs
    // to become anything at all, so their absence is the failure worth catching.
    expect(html).toContain("<script");
    expect(html).toContain("/_next/static/");
  });

  it("serves the page's own assets, and nothing outside the export", async () => {
    // A request path is untrusted input. Escaping the export directory would turn a settings page
    // into a file server for the host.
    const escape = await fetch(`${origin}/../package.json`, { redirect: "manual" });
    expect(escape.status === 404 || escape.status === 400 || escape.status === 301).toBe(true);

    const missing = await fetch(`${origin}/_next/static/does-not-exist.js`);
    expect(missing.status).toBe(404);
  });

  it("exchanges a launch code for a session, and refuses a request without one", async () => {
    // Establishing the session is what this route is for, so it is the one /api route that answers
    // without a credential — the code itself is the credential, and Core refuses a stale or foreign
    // one. A request carrying no code must still be refused rather than treated as anonymous.
    const empty = await fetch(`${origin}/api/app-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { code?: string }).code).toBe("app_auth_code_required");

    // Unauthenticated is not the same as unprotected. The page calls this with a relative URL, so
    // a real exchange always carries its own origin; a cross-site post of a code the caller owns
    // would otherwise hand this browser someone else's session.
    const foreign = await fetch(`${origin}/api/app-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ code: "stolen" }),
    });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code?: string }).code).toBe("cross_site_request_blocked");
  });

  it("accepts the settings page's own session, in the shape Core actually sends", async () => {
    // The acceptance side of the cookie path, and the test whose absence let a real defect ship: a
    // suite that only asserts refusals passes just as well against a parser that understands
    // nothing, because every refusal is satisfied by refusing everything.
    //
    // The stub answers with Core's own field names — `AppSessionValidationResult` in
    // AppIdentityService.cs, serialized under `JsonSerializerDefaults.Web`. Inventing a friendlier
    // shape here would make this test agree with the app about something Core never said.
    let seenBody: string | null = null;
    const core = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      seenBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          active: true,
          appId: "hosty.ai-gateway",
          userId: "user_admin",
          email: "admin@example.test",
          displayName: "Admin",
          hostRole: "host.admin",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    process.env.HOSTY_CORE_ORIGIN = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
    process.env.HOSTY_APP_SERVICE_TOKEN = "service-token";

    try {
      const response = await fetch(`${origin}/api/settings`, {
        headers: { cookie: "hosty_ai_gateway_identity=session-token" },
      });
      expect(response.status).toBe(200);
      // Core is asked about the token the browser presented, not about something reconstructed.
      expect(JSON.parse(seenBody ?? "{}")).toEqual({ accessToken: "session-token" });
    } finally {
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("refuses a session whose host role is not administrator", async () => {
    // Paired with the acceptance above: same valid session, one field different. Without this the
    // previous test is also satisfied by an app that never looks at the role at all.
    const core = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ active: true, appId: "hosty.ai-gateway", userId: "user_plain", hostRole: "host.user" }),
      );
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    process.env.HOSTY_CORE_ORIGIN = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
    process.env.HOSTY_APP_SERVICE_TOKEN = "service-token";

    try {
      const response = await fetch(`${origin}/api/settings`, {
        headers: { cookie: "hosty_ai_gateway_identity=session-token" },
      });
      expect(response.status).toBe(401);
    } finally {
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("lets a cookie change state only from this app's own pages", async () => {
    // The cookie is SameSite=None by necessity, so the browser will attach it to a request another
    // site caused, and a plain form post needs no CORS permission to arrive. Asserted as a pair:
    // the same request differing only in provenance must go both ways, or a gateway that refuses
    // every write would pass the negative alone.
    const core = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ active: true, appId: "hosty.ai-gateway", userId: "user_admin", hostRole: "host.admin" }),
      );
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    process.env.HOSTY_CORE_ORIGIN = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
    process.env.HOSTY_APP_SERVICE_TOKEN = "service-token";

    try {
      const foreign = await fetch(`${origin}/api/settings`, {
        method: "PUT",
        headers: {
          cookie: "hosty_ai_gateway_identity=session-token",
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ systemPrompt: "owned" }),
      });
      expect(foreign.status).toBe(403);
      expect(((await foreign.json()) as { code?: string }).code).toBe("cross_site_request_blocked");

      const own = await fetch(`${origin}/api/settings`, {
        method: "PUT",
        headers: {
          cookie: "hosty_ai_gateway_identity=session-token",
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ systemPrompt: "set by the page" }),
      });
      expect(own.status).toBe(200);
      expect((await settings.read()).systemPrompt).toBe("set by the page");

      // The refused write must have changed nothing — a 403 that still applied the body would be
      // the same defect wearing a status code.
      expect((await settings.read()).systemPrompt).not.toBe("owned");
    } finally {
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("does not require provenance from a delegated token", async () => {
    // The token is carried deliberately rather than attached by the browser, so a cross-site page
    // cannot present one. Requiring an Origin here would break the Shell panel, which is the whole
    // reason the check is scoped to the cookie.
    const response = await fetch(`${origin}/api/settings`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${mintToken("host.admin")}`,
        origin: "https://shell.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ systemPrompt: "from the panel" }),
    });
    expect(response.status).toBe(200);
  });

  it("refuses the API to a caller with neither credential shape", async () => {
    // Two clients, two shapes — the Shell panel's delegated token and the settings page's own
    // session — and neither present means refused, not anonymous.
    const response = await fetch(`${origin}/api/settings`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code?: string }).code).toBe("unauthorized");
  });

  it("discovers MCP providers from Core and prunes toggles for apps that are gone", async () => {
    // Core is the registry; the gateway asks and keeps only the policy. Stood up as a real HTTP
    // server so the service-token header and the response shape are both exercised.
    let seenAuth: string | null = null;
    const core = createServer((request, response) => {
      seenAuth = request.headers.authorization ?? null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          apps: [
            {
              id: "com.haas.demo-app",
              displayName: "Demo App",
              runtimeState: "running",
              interfaces: [{ name: "mcp", key: "default", url: "http://127.0.0.1:3101/api/mcp" }],
            },
            { id: "hosty.shell", displayName: "Shell", runtimeState: "running", interfaces: [] },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    const coreOrigin = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;

    // A toggle for an app Core no longer lists must not survive: otherwise an uninstall/reinstall
    // cycle silently resurrects a provider the operator once enabled.
    await settings.update({ mcpProviders: { "com.example.gone": true } });

    const directory = new ProviderDirectory(coreOrigin, "service-token", "hosty.ai-gateway");
    const withProviders = createGatewayServer(manager, new FakeHarnessAdapter(), settings, directory);
    await new Promise<void>((resolve) => withProviders.listen(0, resolve));
    const providerOrigin = `http://127.0.0.1:${(withProviders.address() as AddressInfo).port}`;

    // try/finally, not trailing closes: a failed assertion would otherwise leak a listening socket
    // for the rest of the file, and a leaked listener is exactly how one broken test turns into an
    // unrelated flaky one later.
    try {
      const response = await fetch(`${providerOrigin}/api/settings`, {
        headers: { authorization: `Bearer ${mintToken("host.admin")}` },
      });
      const body = (await response.json()) as {
        providers: Array<{ appId: string; url: string | null; running: boolean }>;
        discovery: string;
        settings: { mcpProviders: Record<string, boolean> };
      };

      expect(seenAuth).toBe("Bearer service-token");
      expect(body.discovery).toBe("ok");
      // Only the app that declares `mcp` — Shell declares none and must not appear.
      expect(body.providers).toEqual([
        {
          appId: "com.haas.demo-app",
          displayName: "Demo App",
          url: "http://127.0.0.1:3101/api/mcp",
          running: true,
          // Every declaration with the key Core resolved it under. Dropping the key renamed the
          // tools of any non-default interface, which is exactly what the facade's naming must not
          // do — it has to match the CLI connector's.
          interfaces: [{ key: "default", url: "http://127.0.0.1:3101/api/mcp" }],
        },
      ]);
      expect(body.settings.mcpProviders).toEqual({ "hosty:core": true });
    } finally {
      await new Promise((resolve) => withProviders.close(resolve));
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("offers Core as the first provider when its MCP URL is configured, on by default and never pruned", async () => {
    // Core is not an app: it is not in the roster Core lists, so it has to be added by the surface
    // that wants it and kept out of the pruning that roster drives. Both halves are asserted — the
    // row being present, and an explicit "off" surviving the read that prunes.
    const core = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ apps: [] }));
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    const coreOrigin = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;

    const directory = new ProviderDirectory(coreOrigin, "service-token", "hosty.ai-gateway", `${coreOrigin}/api/mcp`);
    const withCore = createGatewayServer(manager, new FakeHarnessAdapter(), settings, directory);
    await new Promise<void>((resolve) => withCore.listen(0, resolve));
    const coreGateway = `http://127.0.0.1:${(withCore.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${mintToken("host.admin")}` };

    try {
      const initial = (await (await fetch(`${coreGateway}/api/settings`, { headers })).json()) as {
        providers: Array<{ appId: string; displayName: string; url: string | null; running: boolean }>;
        settings: { mcpProviders: Record<string, boolean>; mcpAutoAllow: Record<string, boolean> };
      };
      expect(initial.providers).toEqual([
        {
          appId: "hosty:core",
          displayName: "Hosty Core",
          url: `${coreOrigin}/api/mcp`,
          running: true,
          interfaces: [{ key: "default", url: `${coreOrigin}/api/mcp` }],
        },
      ]);
      expect(initial.settings.mcpProviders).toEqual({ "hosty:core": true });
      expect(initial.settings.mcpAutoAllow).toEqual({ "hosty:core": true });

      // Switched off, then read again — the read prunes against a roster Core is never in.
      await fetch(`${coreGateway}/api/settings`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ mcpProviders: { "hosty:core": false } }),
      });
      const reread = (await (await fetch(`${coreGateway}/api/settings`, { headers })).json()) as {
        settings: { mcpProviders: Record<string, boolean> };
      };
      expect(reread.settings.mcpProviders).toEqual({ "hosty:core": false });
    } finally {
      await new Promise((resolve) => withCore.close(resolve));
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("reports discovery as unavailable rather than as an empty fleet", async () => {
    // An unreachable Core and a host where genuinely no app declares MCP are different facts, and
    // showing the first as the second would quietly tell the operator their apps vanished.
    const directory = new ProviderDirectory("http://127.0.0.1:1", "service-token", "hosty.ai-gateway");
    const server2 = createGatewayServer(manager, new FakeHarnessAdapter(), settings, directory);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const origin2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

    try {
      const response = await fetch(`${origin2}/api/settings`, {
        headers: { authorization: `Bearer ${mintToken("host.admin")}` },
      });
      const body = (await response.json()) as { discovery: string; providers: unknown[] };
      expect(body.discovery).toBe("unavailable");
      expect(body.providers).toEqual([]);
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  it("does not wipe provider toggles when Core answers 200 with a malformed body", async () => {
    // The dangerous path: a 200 whose body is not the expected shape would otherwise read as an
    // empty fleet, flow into prune([]) and permanently delete every toggle the operator had set.
    const core = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ unexpected: "shape" }));
    });
    await new Promise<void>((resolve) => core.listen(0, resolve));
    const coreOrigin = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;

    await settings.update({ mcpProviders: { "com.example.notes": true } });
    const directory = new ProviderDirectory(coreOrigin, "service-token", "hosty.ai-gateway");
    const server3 = createGatewayServer(manager, new FakeHarnessAdapter(), settings, directory);
    await new Promise<void>((resolve) => server3.listen(0, resolve));
    const origin3 = `http://127.0.0.1:${(server3.address() as AddressInfo).port}`;

    try {
      const response = await fetch(`${origin3}/api/settings`, {
        headers: { authorization: `Bearer ${mintToken("host.admin")}` },
      });
      const body = (await response.json()) as {
        discovery: string;
        settings: { mcpProviders: Record<string, boolean> };
      };
      expect(body.discovery).toBe("unavailable");
      expect(body.settings.mcpProviders).toEqual({ "hosty:core": true, "com.example.notes": true });
    } finally {
      await new Promise((resolve) => server3.close(resolve));
      await new Promise((resolve) => core.close(resolve));
    }
  });

  it("drops a failed harness run so the next message starts a fresh one", async () => {
    let starts = 0;
    const failing: import("./harness/adapter.js").HarnessAdapter = {
      name: "failing",
      capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
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
          resolveQuestion: () => false,
          setMcpServers: async () => false,
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
