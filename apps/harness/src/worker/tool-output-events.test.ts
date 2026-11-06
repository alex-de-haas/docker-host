import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerJournal } from "./journal.js";
import { WorkerClient } from "./client.js";
import type { HarnessEvent } from "../harness/adapter.js";
import { MAX_TOOL_OUTPUT_CHARS } from "../harness/tool-result.js";
import type { WorkerEvent, WorkerReceipt, WorkerRunRequest } from "./contracts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (): WorkerRunRequest => ({ conversationId: "chat-1", binding: { connectionId: "account-1", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat-1" }, input: "test", options: {}, autoAllowedPrefixes: [] });
const result = (extra: Record<string, unknown> = {}): HarnessEvent => ({ type: "tool_result", toolUseId: "tool-1", status: "completed", output: "tool output", ...extra } as HarnessEvent);
async function fixture(maxBytes?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-tool-output-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new WorkerJournal(directory, undefined, maxBytes); await journal.initialize(); await journal.accept("run-1", request());
  return { directory, journal, file: path.join(directory, "run-1.json") };
}
const receipt = (extra: Partial<WorkerReceipt> = {}): WorkerReceipt => ({ runId: "run-1", conversationId: "chat-1", generation: "generation-1", state: "completed", revision: 5,
  selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });
const frame = (sequence: number, event: HarnessEvent, extra = {}): WorkerEvent => ({ runId: "run-1", generation: "generation-1", sequence, event, ...extra });
const sse = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const client = () => new WorkerClient("http://127.0.0.1:9000", { version: 1, installation: "installation-1", secret: "fixture-service-secret" });
it("bounds tool content before Worker retention accounting and never persists envelope fields", async () => {
  const f = await fixture(MAX_TOOL_OUTPUT_CHARS + 2048);
  const written = await f.journal.append("run-1", result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS * 3), credential: "transport-secret", _meta: { token: "transport-secret" } }));
  expect(written?.event).toEqual(result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS), truncated: true }));
  expect(await readFile(f.file, "utf8")).not.toContain("transport-secret");
  const record = await f.journal.load("run-1"); expect(record.events).toEqual([written]); expect(record.receipt.pending).toBeUndefined(); expect(record.receipt.snapshot?.result).toBeUndefined();
});
it.each([{ output: null }, { output: {} }, { toolUseId: "bad\nid" }, { status: "unexpected" }, { truncated: false }])("rejects malformed tool results without advancing the durable cursor: %j", async invalid => {
  const f = await fixture(); expect(await f.journal.append("run-1", result(invalid))).toBeNull();
  expect((await f.journal.load("run-1")).receipt.revision).toBe(0);
});
it("normalizes retained output at journal read and recovery without restoring it as a pending or final result", async () => {
  const f = await fixture(), raw = JSON.parse(await readFile(f.file, "utf8"));
  const unsafe = frame(1, result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1), credential: "transport-secret" }), { providerToken: "transport-secret" });
  raw.events = [unsafe, frame(2, result({ output: null })), { ...frame(3, result()), sequence: "3" }];
  raw.receipt.revision = 3; raw.receipt.pending = [unsafe]; raw.receipt.snapshot = { result: unsafe.event, contextUsage: unsafe };
  await writeFile(f.file, JSON.stringify(raw));
  const loaded = await f.journal.load("run-1"); expect(loaded.events).toEqual([frame(1, result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS), truncated: true }))]);
  expect(loaded.receipt.pending).toEqual([]); expect(loaded.receipt.snapshot).toEqual({}); expect(loaded.receipt.revision).toBe(3);
  expect(JSON.stringify(loaded)).not.toContain("transport-secret");
  await new WorkerJournal(f.directory).initialize(); expect(await readFile(f.file, "utf8")).not.toContain("transport-secret");
});
it("validates client frames, consumes invalid payload cursors and deduplicates tool replay", async () => {
  const values = [frame(1, result({ credential: "transport-secret" }), { headers: { authorization: "transport-secret" } }), frame(1, result({ status: "failed" })),
    frame(2, result({ output: null })), frame(3, result({ output: "" })), frame(4, result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1) }))];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(values.map(value => sse("run", value)).join("") + sse("state", receipt()))));
  const events: WorkerEvent[] = []; await client().events("run-1", event => { events.push(event); }, AbortSignal.timeout(2000));
  expect(events).toEqual([frame(1, result()), frame(3, result({ output: "" })), frame(4, result({ output: "x".repeat(MAX_TOOL_OUTPUT_CHARS), truncated: true }))]);
  expect(JSON.stringify(events)).not.toContain("transport-secret");
});
it.each([{ sequence: "1" }, { sequence: 0 }, { generation: "bad\ngeneration" }, { runId: "bad run" }])("rejects malformed tool frame envelopes: %j", async altered => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse("run", frame(1, result(), altered)))));
  await expect(client().events("run-1", () => {}, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: "invalid_tool_frame" });
});
it.each(["state", "resync"])("does not relay misplaced tool output from a %s receipt", async type => {
  const unsafe = frame(1, result());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse(type, receipt({ pending: [unsafe], snapshot: { result: unsafe.event, contextUsage: unsafe } })))));
  const events: WorkerEvent[] = [], returned = await client().events("run-1", event => { events.push(event); }, AbortSignal.timeout(2000));
  expect(events).toEqual([]); expect(returned.pending).toEqual([]); expect(returned.snapshot).toEqual({});
});
it("retries output delivery before acknowledging its durable cursor", async () => {
  const body = sse("run", frame(1, result())) + sse("state", receipt());
  const fetch = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response(body)); vi.stubGlobal("fetch", fetch);
  let attempts = 0; const persisted: WorkerEvent[] = [];
  await client().events("run-1", event => { if (++attempts === 1) throw new Error("temporary persistence failure"); persisted.push(event); }, AbortSignal.timeout(3000));
  expect(attempts).toBe(2); expect(persisted).toEqual([frame(1, result())]); expect(fetch.mock.calls[1]?.[0]).toContain("after=0");
});

it("preserves producer timing through durable journal reload and client replay", async () => {
  const f = await fixture();
  const timed = result({ status: "failed", durationMs: 1234 });
  const written = await f.journal.append("run-1", timed);
  expect(written?.event).toEqual(timed);
  const loaded = await new WorkerJournal(f.directory).load("run-1");
  expect(loaded.events[0]?.event).toEqual(timed);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse("run", loaded.events[0]) + sse("state", receipt({ generation: loaded.receipt.generation })))));
  const events: WorkerEvent[] = [];
  await client().events("run-1", event => { events.push(event); }, AbortSignal.timeout(2000));
  expect(events[0]?.event).toEqual(timed);
});
