import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerJournal } from "./journal.js";
import { WorkerClient } from "./client.js";
import type { HarnessEvent } from "../harness/adapter.js";
import type { WorkerEvent, WorkerReceipt, WorkerRunRequest } from "./contracts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const request = (): WorkerRunRequest => ({ conversationId: "chat-1",
  binding: { connectionId: "account-1", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat-1" },
  input: "test", options: {}, autoAllowedPrefixes: [] });
const command = (extra: Record<string, unknown> = {}): HarnessEvent => ({ type: "command_result",
  toolUseId: "tool-1", status: "completed", exitCode: 0, durationMs: 42, summary: "3 passed · 1 failed", ...extra } as unknown as HarnessEvent);
async function journalFixture(maxBytes?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-commands-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new WorkerJournal(directory, undefined, maxBytes); await journal.initialize();
  await journal.accept("run-1", request());
  return { directory, journal, file: path.join(directory, "run-1.json") };
}
const receipt = (extra: Partial<WorkerReceipt> = {}): WorkerReceipt => ({ runId: "run-1", conversationId: "chat-1",
  generation: "generation-1", state: "completed", revision: 5, selection: { model: null, reasoningEffort: null },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });
const frame = (sequence: number, event: HarnessEvent, extra = {}): WorkerEvent =>
  ({ runId: "run-1", generation: "generation-1", sequence, event, ...extra });
const sse = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const client = () => new WorkerClient("http://127.0.0.1:9000", { version: 1, installation: "installation-1", secret: "service-fixture-secret" });

it("writes only bounded command metadata before Worker retention limits and disk persistence", async () => {
  const f = await journalFixture(1024);
  const written = await f.journal.append("run-1", command({ stdout: "fixture-raw-secret".repeat(100000),
    stderr: "another-secret", credential: "provider-secret", nested: { accessToken: "private-token" } }));
  expect(written?.event).toEqual(command());
  expect(Object.keys(written!.event).sort()).toEqual(["type", "toolUseId", "status", "exitCode", "durationMs", "summary"].sort());
  const stored = await readFile(f.file, "utf8");
  expect(stored).not.toContain("secret"); expect(stored).not.toContain("stdout"); expect(stored).not.toContain("accessToken");
  expect((await f.journal.load("run-1")).bytes).toBeLessThan(1024);
});

it.each([
  { toolUseId: "" }, { toolUseId: "tool\nprivate" }, { toolUseId: { token: "secret" } },
  { status: "unexpected" }, { status: ["completed"] }, { status: { toString: "completed", output: "secret" } },
  { durationMs: -1 }, { exitCode: 1.5 },
])("drops malformed command metadata without changing its durable cursor: %j", async invalid => {
  const f = await journalFixture();
  expect(await f.journal.append("run-1", command(invalid))).toBeNull();
  const stored = await f.journal.load("run-1");
  expect(stored.events).toEqual([]); expect(stored.receipt.revision).toBe(0);
  expect(await readFile(f.file, "utf8")).not.toContain("command_result");
});

it("drops arbitrary, multiline and oversized summaries while retaining command status", async () => {
  const f = await journalFixture();
  for (const summary of ["password=fixture-secret", "2 passed\nprivate-token", "3 passed\u001b[31m", "x".repeat(100000)])
    expect((await f.journal.append("run-1", command({ summary })))?.event).toEqual(command({ summary: undefined }));
  const stored = await readFile(f.file, "utf8");
  expect(stored).not.toContain("fixture-secret"); expect(stored).not.toContain("private-token");
  expect(stored).not.toContain("\\u001b"); expect(stored.length).toBeLessThan(4096);
});

it("normalizes retained command replay and purges its old raw fields on Worker recovery", async () => {
  const f = await journalFixture();
  const raw = JSON.parse(await readFile(f.file, "utf8"));
  const unsafe = frame(1, command({ summary: "password=fixture-secret", stdout: "fixture-secret" }), { providerToken: "fixture-secret" });
  raw.events = [unsafe, frame(2, command({ status: "unexpected", stderr: "fixture-secret" })),
    { ...frame(3, command({ stdout: "fixture-secret" })), sequence: "3" },
    { ...frame(4, command({ stdout: "fixture-secret" })), generation: "bad\ngeneration" }];
  raw.receipt.revision = 2; raw.receipt.pending = [unsafe]; raw.receipt.snapshot = { result: unsafe.event };
  raw.bytes = 123456;
  await writeFile(f.file, JSON.stringify(raw));
  const loaded = await f.journal.load("run-1");
  expect(loaded.events).toEqual([frame(1, command({ summary: undefined }))]);
  expect(loaded.receipt.pending).toEqual([]); expect(loaded.receipt.snapshot?.result).toBeUndefined();
  expect(loaded.receipt.revision).toBe(2); expect(JSON.stringify(loaded)).not.toContain("fixture-secret");
  const restarted = new WorkerJournal(f.directory); await restarted.initialize();
  expect(await readFile(f.file, "utf8")).not.toContain("fixture-secret");
  expect((await restarted.accept("run-1", request())).fresh).toBe(false);
});

it("sanitizes command transport, consumes invalid cursors and ignores duplicate replay frames", async () => {
  const frames = [frame(1, command({ stdout: "fixture-secret", summary: "1 passed" }), { providerToken: "fixture-secret" }),
    frame(1, command({ status: "failed" })), frame(2, command({ toolUseId: null, stdout: "fixture-secret" })),
    frame(3, command({ toolUseId: "tool-2", summary: "2 passed\nfixture-secret", stderr: "fixture-secret" }))];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frames.map(value => sse("run", value)).join("") + sse("state", receipt()))));
  const received: WorkerEvent[] = [];
  await client().events("run-1", event => { received.push(event); }, AbortSignal.timeout(2000));
  expect(received).toEqual([frame(1, command({ summary: "1 passed" })), frame(3, command({ toolUseId: "tool-2", summary: undefined }))]);
  expect(JSON.stringify(received)).not.toContain("fixture-secret");
});

it.each([
  { sequence: "2" }, { sequence: null }, { sequence: 0 }, { sequence: -1 }, { sequence: 1.5 },
  { sequence: Number.MAX_SAFE_INTEGER + 1 }, { generation: "bad\ngeneration" },
  { generation: "x".repeat(101) }, { runId: "bad\nrun" },
])("rejects malformed command envelopes without acknowledging their cursor: %j", async altered => {
  const fetch = vi.fn().mockResolvedValue(new Response(sse("run", { ...frame(1, command()), ...altered })));
  vi.stubGlobal("fetch", fetch);
  const received: WorkerEvent[] = [];
  await expect(client().events("run-1", event => { received.push(event); }, AbortSignal.timeout(2000)))
    .rejects.toMatchObject({ code: "invalid_command_frame" });
  expect(received).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
});

it("reconnects using the original command cursor without relaying its metadata twice", async () => {
  const first = frame(1, command({ stdout: "fixture-secret" }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sse("run", first)));
    setTimeout(() => controller.error(new Error("temporary stream interruption")), 0);
  } });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(new Response(
    sse("run", first) + sse("run", frame(2, command({ toolUseId: "tool-2" }))) + sse("state", receipt())));
  vi.stubGlobal("fetch", fetch);
  const received: WorkerEvent[] = [];
  await client().events("run-1", event => { received.push(event); }, AbortSignal.timeout(3000));
  expect(received.map(event => event.sequence)).toEqual([1, 2]);
  expect(fetch.mock.calls[1]?.[0]).toContain("after=1"); expect(JSON.stringify(received)).not.toContain("fixture-secret");
});

it("retries sanitized command delivery when persistence fails before acknowledging its cursor", async () => {
  const unsafe = frame(1, command({ stdout: "fixture-secret" }));
  const body = sse("run", unsafe) + sse("state", receipt());
  const fetch = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response(body));
  vi.stubGlobal("fetch", fetch);
  let attempts = 0;
  const persisted: WorkerEvent[] = [];
  await client().events("run-1", event => {
    expect(JSON.stringify(event)).not.toContain("fixture-secret");
    if (++attempts === 1) throw new Error("temporary command persistence failure");
    persisted.push(event);
  }, AbortSignal.timeout(3000));
  expect(attempts).toBe(2); expect(persisted).toEqual([frame(1, command())]);
  expect(fetch.mock.calls[1]?.[0]).toContain("after=0");
});

it.each(["state", "resync"])("does not treat command metadata in a malformed %s receipt as a decision or final result", async type => {
  const unsafe = frame(1, command({ stdout: "fixture-secret" }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse(type,
    receipt({ pending: [unsafe], snapshot: { result: unsafe.event } })))));
  const events: WorkerEvent[] = [];
  const result = await client().events("run-1", event => { events.push(event); }, AbortSignal.timeout(2000));
  expect(result.pending).toEqual([]); expect(result.snapshot?.result).toBeUndefined();
  expect(events).toEqual([]); expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
