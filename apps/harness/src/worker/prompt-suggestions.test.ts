import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerEngine } from "./engine.js";
import { WorkerJournal } from "./journal.js";
import { validateRun, type WorkerRunRequest } from "./contracts.js";
import { suggestionText } from "../harness/prompt-suggestion.js";
import type { HarnessStartOptions } from "../harness/adapter.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (): WorkerRunRequest => ({ conversationId: "chat", operation: "chat", binding: { connectionId: "account", connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: "chat" }, input: "hello", options: { promptSuggestions: true }, autoAllowedPrefixes: [] });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "suggestions-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new WorkerJournal(root); await journal.initialize();
  let stopFailure = false, stopped = 0, released = 0;
  const runs: HarnessStartOptions[] = [];
  const engine = new WorkerEngine(journal, { validateSelection: async () => {}, cwd: async () => root,
    reserve: async () => () => { released++; }, adapter: async () => ({ name: "fixture", capabilities: {
      questions: true, appMcp: true, autoAllow: true, denyReason: true, liveReconfigure: false, promptSuggestions: true }, probe: async () => ({ available: true }),
      start: options => { runs.push(options); return { send() {}, interrupt: async () => {}, stop: async () => {},
        stopAndWait: async () => { if (stopFailure) throw new Error("still alive"); stopped++; },
        resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false }; } }) }, 1);
  cleanups.push(async () => { stopFailure = false; await engine.close(); });
  await engine.submit("run1", request()); await vi.waitFor(() => expect(runs.length).toBe(1));
  const answer = async () => { runs[0]!.onEvent({ type: "result", status: "success" }); await vi.waitFor(async () => expect((await journal.load("run1")).receipt.state).toBe("suggesting")); };
  return { engine, journal, runs, answer, failStop: () => { stopFailure = true; }, released: () => released, stopped: () => stopped };
}
it("separates answer, optional collection and confirmed exit; ignores late tools and duplicate output", async () => {
  const f = await fixture(); await f.answer();
  expect(f.stopped()).toBe(0); expect(f.released()).toBe(0);
  f.runs[0]!.onEvent({ type: "assistant_text", text: "must not enter transcript" });
  f.runs[0]!.onEvent({ type: "prompt_suggestion", text: "  Next step?  " });
  f.runs[0]!.onEvent({ type: "prompt_suggestion", text: "duplicate" });
  await vi.waitFor(async () => expect((await f.journal.load("run1")).receipt.state).toBe("completed"));
  const record = await f.journal.load("run1");
  expect(record.events.map(frame => frame.event.type)).toEqual(["result", "answer_complete", "prompt_suggestion"]);
  expect(record.events.at(-1)?.event).toEqual({ type: "prompt_suggestion", text: "Next step?" });
  expect(f.stopped()).toBe(1); expect(f.released()).toBe(1);
});
it.each(["cancel", "foreground", "close", "provider-error"])("%s ends prediction without changing the successful answer", async action => {
  const f = await fixture(); await f.answer();
  if (action === "cancel") await f.engine.cancel("run1", "cancel1");
  if (action === "foreground") await f.engine.submit("run2", { ...request(), conversationId: "another", resource: { kind: "conversation", id: "another" }, binding: { ...request().binding, connectionId: "other" } });
  if (action === "close") await f.engine.close();
  if (action === "provider-error") f.runs[0]!.onEvent({ type: "error", message: "prediction unavailable" });
  await vi.waitFor(async () => expect((await f.journal.load("run1")).receipt).toMatchObject({ state: "completed", exitConfirmed: true, snapshot: { result: { type: "result", status: "success" } } }));
  expect(f.stopped()).toBeGreaterThanOrEqual(1);
});
it("times out after thirty seconds without regenerating", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f.runs[0]!.onEvent({ type: "result", status: "success" });
  // File IO remains real; wait for the serialized state before advancing the deadline.
  while ((await f.journal.load("run1")).receipt.state !== "suggesting") await new Promise(resolve => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(30000); vi.useRealTimers();
  await vi.waitFor(async () => expect((await f.journal.load("run1")).receipt.state).toBe("completed"));
  expect((await f.journal.load("run1")).events.at(-1)?.event).toMatchObject({ type: "prompt_suggestion", text: null, reason: "timeout" });
  expect(f.runs).toHaveLength(1);
});
it("disables predictions mid-answer without cancelling the primary run", async () => {
  const f = await fixture();
  await f.engine.disableSuggestions("run1", "disable1");
  expect((await f.journal.load("run1")).receipt.state).toBe("running"); expect(f.stopped()).toBe(0);
  f.runs[0]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.journal.load("run1")).receipt.state).toBe("completed"));
  expect((await f.journal.load("run1")).events.some(frame => frame.event.type === "answer_complete")).toBe(false);
});
it("retains capacity and connection ownership when native exit is unconfirmed", async () => {
  const f = await fixture(); await f.answer(); f.failStop();
  await f.engine.cancel("run1", "cancel1");
  expect((await f.journal.load("run1")).receipt.state).toBe("interrupted");
  expect(f.released()).toBe(0);
  await expect(f.engine.submit("run2", request())).rejects.toMatchObject({ code: "worker_busy" });
});
it("rejects suggestions for tasks and translations and accepts legacy callers", () => {
  for (const operation of ["task", "translation"] as const) expect(() => validateRun({ ...request(), operation })).toThrow();
  expect(() => validateRun({ ...request(), operation: undefined, options: {} })).not.toThrow();
  expect(() => validateRun({ ...request(), options: { promptSuggestions: "true" } })).toThrow();
});
it("bounds Unicode text and refuses malformed or control payloads", () => {
  expect(suggestionText("😀".repeat(2000))).toHaveLength(4000);
  for (const value of ["😀".repeat(2001), " ", {}, "bad\u0000text", "a".repeat(2001)]) expect(suggestionText(value)).toBeNull();
});

it("disables a collecting prediction durably and idempotently", async () => {
  const f = await fixture(); await f.answer();
  const first = await f.engine.disableSuggestions("run1", "disable1");
  expect(first.state).toBe("completed"); expect(first.exitConfirmed).toBe(true);
  expect(await f.engine.disableSuggestions("run1", "disable1")).toEqual(first);
  expect(f.stopped()).toBe(1);
});
