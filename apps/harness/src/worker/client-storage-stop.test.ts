import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as persistence from "../persistence.js";
import { ensureServiceIdentity } from "./auth.js";
import { WorkerClient } from "./client.js";
import { WorkerApiError } from "./contracts.js";
import { WorkerEngine } from "./engine.js";
import { createWorkerServer } from "./http.js";
import { WorkerJournal } from "./journal.js";
import type { HarnessStartOptions } from "../harness/adapter.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-client-storage-stop-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(path.join(root, "runs")); await journal.initialize();
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  let options: HarnessStartOptions | undefined, allowStop = true, starts = 0, sends = 0, stops = 0, releases = 0;
  const capabilities = { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false };
  const engine = new WorkerEngine(journal, { validateSelection: async () => {}, cwd: async () => root,
    reserve: async () => () => { releases++; }, adapter: async () => ({ name: "storage-stop-fixture", capabilities,
      probe: async () => ({ available: true }), start: value => { options = value; starts++; return {
        send() { sends++; }, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {
          stops++; if (!allowStop) throw new Error("Native execution remains active");
        }, resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => false,
      }; } }) }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({}), configure: async () => ({}), connection: async () => ({}), models: async () => ({}) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { allowStop = true; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.close(); });
  const client = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const calls: Array<{ pathname: string; method: string; body?: Record<string, unknown> }> = [], fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === client.origin) calls.push({ pathname: url.pathname, method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    return fetch(input, init);
  });
  const run = client.adapter({ connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" }, capabilities, "storage-stop-fixture")
    .start({ sessionId: "conversation", workerRunId: "retained-run", cwd: root, onEvent() {} });
  cleanup.push(() => run.detach!());
  run.send("retained synthetic input"); await run.waitForAdmission!();
  await expect.poll(() => starts).toBe(1); await expect.poll(async () => (await journal.load("retained-run")).receipt.state).toBe("running");
  return { root, journal, engine, client, run, calls, options: () => options!, counts: () => ({ starts, sends, stops, releases }),
    allowStop: (allowed: boolean) => { allowStop = allowed; } };
}

it.each(["uncertain", "unavailable"] as const)("reaches explicit Stop through a %s Worker receipt without replaying input or claiming saved exit", async mode => {
  const f = await fixture(), file = path.join(f.root, "runs", "retained-run.json"), code = `run_storage_${mode}`;
  f.allowStop(false); vi.spyOn(console, "warn").mockImplementation(() => {});
  if (mode === "uncertain") {
    const write = persistence.durableWriteFile; let fail = true;
    vi.spyOn(persistence, "durableWriteFile").mockImplementation(async (target, bytes) => {
      await write(target, bytes);
      if (target === file && fail) { fail = false; throw new persistence.DurableWriteError(target, new Error("Lost fixture publication acknowledgement")); }
    });
  } else await writeFile(file, Buffer.alloc(16));
  f.options().onEvent({ type: "assistant_text", text: "Output whose persistence failed" });
  await expect.poll(() => f.counts().stops).toBe(1);
  await expect(f.journal.load("retained-run")).rejects.toMatchObject({ status: 503, code });
  const retained = await readFile(file);
  f.allowStop(true); f.calls.length = 0;
  await expect(f.run.stopAndWait!()).rejects.toMatchObject({ status: 503, code });
  const cancels = f.calls.filter(call => call.pathname === "/v1/runs/retained-run/cancel");
  expect(cancels).toHaveLength(3);
  expect(cancels.every(call => call.method === "POST")).toBe(true);
  expect(cancels[0]!.body?.controlId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  expect(new Set(cancels.map(call => call.body?.controlId)).size).toBe(1);
  expect(f.calls.filter(call => call.method === "PUT")).toEqual([]);
  expect(f.counts()).toEqual({ starts: 1, sends: 1, stops: 2, releases: 1 });
  expect(await readFile(file)).toEqual(retained);
  await expect(f.journal.load("retained-run")).rejects.toMatchObject({ status: 503, code });
});

it.each([[401, "run_storage_uncertain"], [503, "worker_error"]] as const)("does not bypass a preliminary %s %s refusal", async (status, code) => {
  const f = await fixture(), request = f.client.request.bind(f.client);
  vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    if (args[0] === "/v1/runs/retained-run" && (!args[1] || args[1] === "GET")) throw new WorkerApiError(status, code, "Fixture refusal");
    return request(...args);
  });
  f.calls.length = 0;
  await expect(f.run.stopAndWait!()).rejects.toMatchObject({ status, code });
  expect(f.calls.filter(call => call.method === "POST" || call.method === "PUT")).toEqual([]);
  expect(f.counts()).toEqual({ starts: 1, sends: 1, stops: 0, releases: 0 });
});
