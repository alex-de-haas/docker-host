import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerJournal } from "./journal.js";
import { WorkerEngine } from "./engine.js";
import { createWorkerServer } from "./http.js";
import { ensureServiceIdentity } from "./auth.js";
import type { WorkerRunRequest } from "./contracts.js";
import type { HarnessStartOptions } from "../harness/adapter.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (): WorkerRunRequest => ({ conversationId: "chat-1", binding: { connectionId: "account-1", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat-1" }, input: "test", options: {}, autoAllowedPrefixes: [] });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-test-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(path.join(root, "journal")); await journal.initialize();
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  let starts = 0, options: HarnessStartOptions | undefined;
  const engine = new WorkerEngine(journal, {
    reserve: async () => () => {}, validateSelection: async () => {}, cwd: async () => root,
    adapter: async () => ({ name: "fixture", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: true, denyReason: true },
      probe: async () => ({ available: true }), start: value => { starts++; options = value; return {
        send() {}, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false,
        interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {},
      }; } }),
  }, 1);
  const server = createWorkerServer(engine, async () => identity, {
    capabilities: async () => ({ capacity: 1 }), configure: async () => ({}), connection: async () => ({}), models: async () => ({}),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${identity.secret}`, "x-hosty-worker-installation": identity.installation, "content-type": "application/json" };
  return { root, journal, engine, base, headers, starts: () => starts, options: () => options,
    put: (id: string, value = request()) => fetch(`${base}/v1/runs/${id}`, { method: "PUT", headers, body: JSON.stringify(value) }) };
}
describe("direct worker contract", () => {
  it("authenticates execution independently from public health", async () => {
    const f = await setup();
    expect((await fetch(`${f.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${f.base}/v1/capabilities`)).status).toBe(401);
    expect((await fetch(`${f.base}/v1/capabilities`, { headers: { ...f.headers, "x-hosty-worker-installation": "wrong" } })).status).toBe(409);
    expect(f.starts()).toBe(0);
  });
  it("accepts identical retries once and rejects changed payload/capacity", async () => {
    const f = await setup();
    const responses = await Promise.all([f.put("run-1"), f.put("run-1")]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    await expect.poll(f.starts).toBe(1);
    expect((await f.put("run-1", { ...request(), selection: { model: "another", reasoningEffort: "high" } })).status).toBe(409);
    expect((await f.put("run-2")).status).toBe(409);
    expect(f.starts()).toBe(1);
  });
  it("replays retained events after the client disconnects without resubmitting", async () => {
    const f = await setup(); await f.put("run-1"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "assistant_delta", text: "one" });
    await expect.poll(async () => (await f.journal.load("run-1")).events.length).toBe(1);
    const first = (await f.journal.load("run-1")).events[0]!;
    f.options()!.onEvent({ type: "assistant_delta", text: "two" });
    f.options()!.onEvent({ type: "result", status: "success" });
    await expect.poll(async () => (await f.journal.load("run-1")).receipt.state).toBe("completed");
    const stream = await fetch(`${f.base}/v1/runs/run-1/events`, { headers: { ...f.headers, "last-event-id": String(first.sequence) } });
    const text = await stream.text(); expect(text).toContain('"text":"two"'); expect(text).not.toContain('"text":"one"');
    expect(text).toContain('"state":"completed"'); expect(f.starts()).toBe(1);
  });
  it("keeps acceptance across restart and never re-executes interrupted work", async () => {
    const f = await setup(); await f.put("run-1"); await expect.poll(f.starts).toBe(1);
    const restarted = new WorkerJournal(path.join(f.root, "journal")); await restarted.initialize();
    const record = await restarted.load("run-1"); expect(record.receipt.state).toBe("interrupted");
    expect((await restarted.accept("run-1", request())).fresh).toBe(false);
    expect(JSON.stringify(record)).not.toContain('"input"');
  });
  it("cancels a run without stopping its service", async () => {
    const f = await setup(); await f.put("run-1"); await expect.poll(f.starts).toBe(1);
    const response = await fetch(`${f.base}/v1/runs/run-1/cancel`, { method: "POST", headers: f.headers, body: JSON.stringify({ controlId: "cancel-1" }) });
    expect(response.status).toBe(200); expect((await response.json() as { state: string }).state).toBe("cancelled");
    expect((await fetch(`${f.base}/healthz`)).status).toBe(200);
    expect((await f.put("run-2")).status).toBe(202);
  });
});

it("correlates concurrent pending decisions and replays only acknowledged controls", async () => {
  const f = await setup(); await f.put("decisions"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "approval_request", approvalId: "first", toolName: "write", input: {} });
  f.options()!.onEvent({ type: "approval_request", approvalId: "second", toolName: "write", input: {} });
  await expect.poll(async () => (await f.journal.load("decisions")).receipt.pending?.length).toBe(2);
  // The second append exposes pending=2 before its event finishes updating the receipt revision.
  // Read behind both queued handlers so the decision uses the fully committed revision.
  const current = await f.journal.exclusive(async () => (await f.journal.load("decisions")).receipt);
  const input = { kind: "approval" as const, id: "first", decision: "allow" as const, controlId: "answer-1", eventId: current.pending![0]!.sequence, expectedRevision: current.revision };
  const accepted = await f.engine.respond("decisions", input);
  expect(accepted.state).toBe("awaiting_input"); expect(accepted.pending).toHaveLength(1);
  expect(await f.engine.respond("decisions", input)).toEqual(accepted);
  await expect(f.engine.respond("decisions", { ...input, controlId: "answer-2" })).rejects.toMatchObject({ code: "stale_control" });
});
it("retains request tombstones and final snapshots after detailed replay expires", async () => {
  const f = await setup(); await f.put("expired"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "assistant_text", text: "retained answer" });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(async () => (await f.journal.load("expired")).receipt.state).toBe("completed");
  const expired = new WorkerJournal(path.join(f.root, "journal"), -1); await expired.initialize();
  expect((await expired.load("expired")).events).toEqual([]);
  expect((await expired.load("expired")).receipt.snapshot?.text).toBe("retained answer");
  expect((await expired.accept("expired", request())).fresh).toBe(false);
  await expect(expired.accept("expired", { ...request(), input: "different" })).rejects.toMatchObject({ code: "run_conflict" });
});
it("refuses executable MCP configuration at the HTTP boundary", async () => {
  const f = await setup();
  expect((await f.put("bad-config", { ...request(), options: { mcpServers: { shell: { type: "stdio", command: "sh" } } } })).status).toBe(400);
  expect(f.starts()).toBe(0);
});

it("distinguishes container exit proof from unknown local children after Worker restart", async () => {
  const f = await setup();
  for (const boundary of ["container", "local"] as const) {
    const directory = path.join(f.root, boundary);
    const before = new WorkerJournal(directory, undefined, undefined, boundary); await before.initialize();
    await before.accept("unfinished", request()); await before.update("unfinished", "running");
    const after = new WorkerJournal(directory, undefined, undefined, boundary); await after.initialize();
    expect((await after.load("unfinished")).receipt).toMatchObject({ state: "interrupted", exitConfirmed: boundary === "container" });
    expect((await after.accept("unfinished", request())).fresh).toBe(false);
  }
});

it("does not retain child setup passwords in replay or pending-decision snapshots", async () => {
  const f = await setup(); await f.put("privacy"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "approval_request", approvalId: "setup", toolName: "mcp__hosty-workspaces__environment_setup", input: { password: "fixture-secret", email: "test@example.test" } });
  await expect.poll(async () => (await f.journal.load("privacy")).receipt.state).toBe("awaiting_input");
  const stored = JSON.stringify(await f.journal.load("privacy"));
  expect(stored).not.toContain("fixture-secret"); expect(stored).toContain("[redacted]");
});
