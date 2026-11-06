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
async function setup(stopAndWait: () => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-test-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(path.join(root, "journal")); await journal.initialize();
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  let starts = 0, options: HarnessStartOptions | undefined;
  const engine = new WorkerEngine(journal, {
    reserve: async () => () => {}, validateSelection: async () => {}, cwd: async () => root,
    adapter: async () => ({ name: "fixture", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: true, denyReason: true },
      probe: async () => ({ available: true }), start: value => { starts++; options = value; return {
        send() {}, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false,
        interrupt: async () => {}, stop: async () => {}, stopAndWait,
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
  it("transports verified instruction provenance and rejects mismatched metadata", async () => {
    const f = await setup();
    const valid = { ...request(), options: { systemPrompt: "instructions", instructionSources: [{ source: "runtime" as const, text: "instructions" }] } };
    expect((await f.put("run-bad", { ...valid, options: { ...valid.options, systemPrompt: "different" } })).status).toBe(400);
    expect((await f.put("run-invalid", { ...valid, options: { ...valid.options, systemPrompt: 12 as never } })).status).toBe(400);
    expect((await f.put("run-good", valid)).status).toBe(202);
    await expect.poll(f.options).toBeDefined();
    expect(f.options()?.instructionSources).toEqual(valid.options.instructionSources);
  });
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
    expect(await (await fetch(`${f.base}/v1/capabilities`, { headers: f.headers })).json()).toMatchObject({ capacity: 1, occupied: 1 });
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
  it("parks only a blocking question, retaining its checkpoint and releasing execution capacity", async () => {
    const f = await setup(); await f.put("run-1"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-session" });
    f.options()!.onEvent({ type: "question_request", questionId: "question-1", blocking: true,
      questions: [{ id: "q1", question: "Continue?", header: "Choice", multiSelect: false, options: [], allowText: true }] });
    await expect.poll(async () => (await f.journal.load("run-1")).receipt.state).toBe("awaiting_input");
    const before = (await f.journal.load("run-1")).receipt;
    const command = { controlId: "park-1", id: "question-1", expectedRevision: before.revision, eventId: before.pending![0]!.sequence };
    const park = () => fetch(`${f.base}/v1/runs/run-1/park`, { method: "POST", headers: f.headers, body: JSON.stringify(command) });
    const response = await park(); expect(response.status).toBe(200);
    const receipt = await response.json() as import("./contracts.js").WorkerReceipt;
    expect(receipt).toMatchObject({ state: "parked", exitConfirmed: true, snapshot: { nativeSessionId: "native-session" } });
    expect(receipt.pending).toHaveLength(1);
    expect((await park()).status).toBe(200);
    expect((await f.put("run-2")).status).toBe(202);
    const restarted = new WorkerJournal(path.join(f.root, "journal")); await restarted.initialize();
    expect((await restarted.load("run-1")).receipt).toMatchObject({ state: "parked", exitConfirmed: true });
  });

  it("keeps independent work running when a question is nonblocking", async () => {
    const f = await setup(); await f.put("run-1"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "question_request", questionId: "question-1", blocking: false,
      questions: [{ id: "q1", question: "Continue?", header: "Choice", multiSelect: false, options: [] }] });
    await expect.poll(async () => (await f.journal.load("run-1")).receipt.pending?.length).toBe(1);
    const before = (await f.journal.load("run-1")).receipt;
    expect(before.state).toBe("running");
    await expect(f.engine.park("run-1", { controlId: "park-1", id: "question-1", expectedRevision: before.revision, eventId: before.pending![0]!.sequence })).rejects.toMatchObject({ code: "stale_parking" });
    expect((await f.journal.load("run-1")).receipt.state).toBe("running");
    await f.engine.respond("run-1", { controlId: "answer-1", id: "question-1", kind: "question", answers: { q1: "Yes" }, expectedRevision: before.revision, eventId: before.pending![0]!.sequence });
    expect(await f.journal.controlOutcome("run-1", "answer-1")).toEqual({ state: "applied" });
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

async function blockingQuestion(f: Awaited<ReturnType<typeof setup>>) {
  await f.put("run-1"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-session" });
  f.options()!.onEvent({ type: "question_request", questionId: "question-1", blocking: true,
    questions: [{ id: "q1", question: "Continue?", header: "Choice", multiSelect: false, options: [], allowText: true }] });
  await expect.poll(async () => (await f.journal.load("run-1")).receipt.state).toBe("awaiting_input");
  const before = (await f.journal.load("run-1")).receipt;
  return { controlId: "park-1", id: "question-1", expectedRevision: before.revision, eventId: before.pending![0]!.sequence };
}
it("retains capacity and the parking identity until native exit is proven", async () => {
  let uncertain = true;
  const f = await setup(async () => { if (uncertain) throw new Error("no exit proof"); });
  const command = await blockingQuestion(f);
  await expect(f.engine.park("run-1", command)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect((await f.journal.load("run-1")).receipt.state).toBe("parking");
  expect((await f.journal.load("run-1")).receipt.exitConfirmed).not.toBe(true);
  expect((await f.put("replacement")).status).toBe(409);
  uncertain = false;
  expect(await f.engine.park("run-1", command)).toMatchObject({ state: "parked", exitConfirmed: true });
  expect((await f.put("replacement")).status).toBe(202);
});
it("cancellation wins a parking race and a late native answer cannot restart work", async () => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(() => stopped), command = await blockingQuestion(f);
  const parking = f.engine.park("run-1", command);
  await expect.poll(async () => (await f.journal.load("run-1")).receipt.state).toBe("parking");
  await expect(f.engine.respond("run-1", { ...command, controlId: "late-answer", kind: "question", answers: { q1: "Yes" } })).rejects.toMatchObject({ code: "stale_control" });
  const cancellation = f.engine.cancel("run-1", "cancel-1");
  await expect.poll(async () => (await f.journal.load("run-1")).receipt.state).toBe("cancelling");
  release(); await Promise.all([parking, cancellation]);
  expect((await f.journal.load("run-1")).receipt).toMatchObject({ state: "cancelled", exitConfirmed: true });
  expect(f.starts()).toBe(1);
});
it.each(["local", "container"] as const)("reconciles interrupted parking using only the %s execution boundary", async boundary => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-parking-restart-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(root, undefined, undefined, boundary); await journal.initialize();
  await journal.accept("parked", request());
  await journal.append("parked", { type: "question_request", questionId: "q", blocking: true, questions: [] });
  await journal.update("parked", "parking");
  const restarted = new WorkerJournal(root, undefined, undefined, boundary); await restarted.initialize();
  const receipt = (await restarted.load("parked")).receipt;
  expect(receipt).toMatchObject({ state: boundary === "container" ? "parked" : "interrupted", exitConfirmed: boundary === "container" });
  expect(receipt.pending?.length ?? 0).toBe(boundary === "container" ? 1 : 0);
});

describe("typed task barriers", () => {
  async function acknowledged(stop?: () => Promise<void>) {
    const f = await setup(stop); await f.put("task-run"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-checkpoint" });
    f.options()!.onEvent({ type: "tool_use", toolName: "mcp__hosty-workspaces__task_wait", toolUseId: "wait-call", input: {} });
    f.options()!.onEvent({ type: "tool_result", toolUseId: "wait-call", status: "completed", output: "hosty_task_barrier:wait-one:1" });
    await expect.poll(async () => (await f.journal.load("task-run")).events.length).toBe(3);
    const stored = await f.journal.load("task-run");
    return { f, input: { controlId: "barrier-command", expectedRevision: stored.receipt.revision, barrierId: "wait-one", generation: 1,
      kind: "child_wait" as const, acknowledgedSequence: stored.events.at(-1)!.sequence } };
  }
  it("parks a tool-acknowledged coordinator without fabricating a question and replays once", async () => {
    const { f, input } = await acknowledged();
    const receipt = await f.engine.barrier("task-run", input);
    expect(receipt).toMatchObject({ state: "parked", exitConfirmed: true, barrier: input, snapshot: { nativeSessionId: "native-checkpoint" } });
    expect(receipt.pending ?? []).toEqual([]);
    expect(await f.engine.barrier("task-run", input)).toEqual(receipt);
    expect((await f.put("other-run")).status).toBe(202);
    await expect(f.engine.barrier("task-run", { ...input, generation: 2 })).rejects.toMatchObject({ code: "control_conflict" });
  });
  it("requires the matching native acknowledgement and settled concurrent tool effects", async () => {
    const { f, input } = await acknowledged();
    await expect(f.engine.barrier("task-run", { ...input, barrierId: "forged" })).rejects.toMatchObject({ code: "barrier_pending" });
    f.options()!.onEvent({ type: "tool_use", toolUseId: "write-call", toolName: "write", input: {} });
    await expect.poll(async () => (await f.journal.load("task-run")).events.length).toBe(4);
    await expect(f.engine.barrier("task-run", { ...input, expectedRevision: (await f.journal.load("task-run")).receipt.revision })).rejects.toMatchObject({ code: "barrier_pending" });
    f.options()!.onEvent({ type: "tool_result", toolUseId: "write-call", status: "completed", output: "done" });
    await expect.poll(async () => (await f.journal.load("task-run")).events.length).toBe(5);
    expect((await f.engine.barrier("task-run", { ...input, expectedRevision: (await f.journal.load("task-run")).receipt.revision })).state).toBe("parked");
  });
  it("uses native settlement for tools whose private result is not in the transcript", async () => {
    const { f, input } = await acknowledged();
    f.options()!.onEvent({ type: "native_effect", id: "search", state: "started" });
    f.options()!.onEvent({ type: "tool_use", toolUseId: "search", toolName: "ToolSearch", input: {} });
    await expect.poll(async () => (await f.journal.load("task-run")).events.length).toBe(5);
    await expect(f.engine.barrier("task-run", { ...input, expectedRevision: (await f.journal.load("task-run")).receipt.revision })).rejects.toMatchObject({ code: "barrier_pending" });
    f.options()!.onEvent({ type: "native_effect", id: "search", state: "settled" });
    await expect.poll(async () => (await f.journal.load("task-run")).events.length).toBe(6);
    expect((await f.engine.barrier("task-run", { ...input, expectedRevision: (await f.journal.load("task-run")).receipt.revision })).state).toBe("parked");
  });
  it("retains capacity and the barrier when native shutdown is uncertain", async () => {
    let uncertain = true;
    const { f, input } = await acknowledged(async () => { if (uncertain) throw new Error("No exit proof"); });
    await expect(f.engine.barrier("task-run", input)).rejects.toMatchObject({ code: "exit_unconfirmed" });
    expect((await f.journal.load("task-run")).receipt).toMatchObject({ state: "parking", barrier: input });
    expect((await f.put("other-run")).status).toBe(409);
    uncertain = false;
    expect((await f.engine.barrier("task-run", input)).state).toBe("parked");
  });
  it("accepts an already completed native turn with its exact retained checkpoint", async () => {
    const { f, input } = await acknowledged();
    f.options()!.onEvent({ type: "result", status: "success" });
    await expect.poll(async () => (await f.journal.load("task-run")).receipt.state).toBe("completed");
    expect((await f.engine.barrier("task-run", { ...input, expectedRevision: (await f.journal.load("task-run")).receipt.revision })).state).toBe("parked");
  });
});

describe("coordinator stop boundaries", () => {
  it("parks a budget stop without impersonating a model tool acknowledgement", async () => {
    const f = await setup(); await f.put("budget-run"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-context" });
    await expect.poll(async () => (await f.journal.load("budget-run")).receipt.snapshot?.nativeSessionId).toBe("native-context");
    const input = { controlId: "budget-stop", expectedRevision: (await f.journal.load("budget-run")).receipt.revision,
      kind: "limits" as const, origin: "coordinator" as const, barrierId: "budget", generation: 1, acknowledgedSequence: 0 };
    await expect(f.engine.barrier("budget-run", { ...input, kind: "task_adoption" })).rejects.toMatchObject({ code: "invalid_barrier" });
    expect((await f.engine.barrier("budget-run", input)).state).toBe("parked");
  });
  it("does not release capacity if an external effect starts during native shutdown", async () => {
    let effectStarted = false;
    const f = await setup(async () => {
      if (effectStarted) return;
      effectStarted = true;
      f.options()!.onEvent({ type: "native_effect", id: "late-write", state: "started" });
    });
    await f.put("source-run"); await expect.poll(f.starts).toBe(1);
    f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-context" });
    await expect.poll(async () => (await f.journal.load("source-run")).receipt.snapshot?.nativeSessionId).toBe("native-context");
    const input = { controlId: "source-stop", expectedRevision: (await f.journal.load("source-run")).receipt.revision,
      kind: "source_rebind" as const, origin: "coordinator" as const, barrierId: "source", generation: 1, acknowledgedSequence: 0 };
    await expect(f.engine.barrier("source-run", input)).rejects.toMatchObject({ code: "exit_unconfirmed" });
    expect((await f.journal.load("source-run")).receipt).toMatchObject({ state: "parking", effects: { "late-write": "started" } });
    expect((await f.put("other-run")).status).toBe(409);
    f.options()!.onEvent({ type: "native_effect", id: "late-write", state: "settled" });
    await expect.poll(async () => Object.keys((await f.journal.load("source-run")).receipt.effects ?? {})).toEqual([]);
    expect((await f.engine.barrier("source-run", input)).state).toBe("parked");
  });
});

it("recovers a legacy Local receipt atomically after explicit exit confirmation, without replaying work", async () => {
  const f = await setup();
  await f.journal.accept("legacy", request()); await f.journal.update("legacy", "running");
  const restarted = new WorkerJournal(path.join(f.root, "journal")); await restarted.initialize();
  const before = await restarted.load("legacy");
  const input = { requestId: "96247241-d236-4db5-b065-055f9481f3e2", generation: before.receipt.generation,
    expectedRevision: before.receipt.revision, consumerExitConfirmed: true as const, actorId: "owner" };
  const recover = (body: unknown, auth = f.headers) => fetch(`${f.base}/v1/runs/legacy/recover`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  expect((await recover(input, {} as typeof f.headers)).status).toBe(401);
  expect((await recover({ ...input, consumerExitConfirmed: false })).status).toBe(400);
  expect((await recover({ ...input, expectedRevision: 0 })).status).toBe(409);
  expect((await recover({ ...input, generation: "another" })).status).toBe(409);
  expect((await f.journal.load("legacy")).receipt).toEqual(before.receipt);
  const response = await recover(input); expect(response.status).toBe(200);
  const receipt = await response.json(); expect(receipt).toMatchObject({ state: "cancelled", exitConfirmed: true, recovery: { actorId: "owner", requestId: input.requestId } });
  const again = new WorkerJournal(path.join(f.root, "journal")); await again.initialize();
  expect(await again.recover("legacy", input)).toEqual(receipt);
  expect((await recover({ ...input, actorId: "other" })).status).toBe(409);
  expect((await f.put("legacy")).status).toBe(202); expect(f.starts()).toBe(0);
  expect((await again.load("legacy")).events).toEqual(before.events);
});
