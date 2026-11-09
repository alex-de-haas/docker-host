import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, type SessionRecord } from "./store.js";
import { SuggestionHistory } from "./suggestion-history.js";
import { project } from "../history/projection.js";

let root: string, store: SessionStore, record: SessionRecord, history: SuggestionHistory, now: number;
const build = () => new SuggestionHistory(store, async (id, payload) => {
  const seq = ++record.lastEventSeq;
  await store.appendEvent(id, { seq, ts: new Date(now).toISOString(), ...payload });
  await store.saveRecord(record);
  return seq;
}, () => now);
const create = (attemptId = "attempt") => history.create(record, { attemptId, text: "Review @app literally <script>hello</script>", contextKey: "context-one" });
const action = (extra = {}) => ({ requestId: randomUUID(), expectedRevision: 1, action: "selected-for-draft", ...extra });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hosty-suggestion-history-")); now = Date.parse("2026-11-09T12:00:00Z");
  store = new SessionStore(root);
  record = { id: randomUUID(), createdBy: "owner", title: null, context: null, status: "idle", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), harnessSessionId: null, lastEventSeq: 1 };
  await store.createSession(record); await store.appendEvent(record.id, { seq: 1, ts: record.createdAt, type: "assistant_text", text: "Completed answer." });
  history = build();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("retains literal correlated predictions once across duplicate delivery and restart", async () => {
  const first = await create(); history = build();
  expect(await create()).toEqual(first);
  expect(first).toMatchObject({ answerSeq: 1, state: "available", revision: 1, text: "Review @app literally <script>hello</script>" });
  expect((await store.readEvents(record.id)).map(event => event.type)).toEqual(["assistant_text", "prompt_suggestion_created"]);
});
it("returns the exact recorded choice after lost replies/restart/expiry and rejects competing choices", async () => {
  const value = await create(), input = action();
  const selected = await history.action(record, "owner", value.suggestionId, input, "context-one");
  now += 20 * 60_000; history = build();
  expect(await history.action(record, "owner", value.suggestionId, input, "different-context")).toEqual(selected);
  await expect(history.action(record, "owner", value.suggestionId, { ...input, action: "dismissed" }, "context-one")).rejects.toMatchObject({ code: "suggestion_request_conflict" });
  await expect(history.action(record, "owner", value.suggestionId, action({ action: "dismissed" }), "context-one")).rejects.toMatchObject({ code: "suggestion_changed" });
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(1);
});
it("checks owner and UUID/revision before writing any explicit choice", async () => {
  const value = await create();
  await expect(history.action(record, "other", value.suggestionId, action(), "context-one")).rejects.toMatchObject({ status: 403 });
  await expect(history.action(record, "owner", value.suggestionId, action({ requestId: "bad" }), "context-one")).rejects.toMatchObject({ status: 400 });
  await expect(history.action(record, "owner", value.suggestionId, action({ expectedRevision: 7 }), "context-one")).rejects.toMatchObject({ status: 409 });
  expect((await history.read(record)).get(value.suggestionId)?.state).toBe("available");
});
it("reconciles unresolved deadlines on restart and separates automatic context supersession", async () => {
  const first = await create(); now += 16 * 60_000; history = build();
  await history.reconcile(record, "context-one");
  expect((await history.read(record)).get(first.suggestionId)?.state).toBe("expired");
  const second = await create("second"); await history.reconcile(record, "context-two");
  expect((await history.read(record)).get(second.suggestionId)?.state).toBe("superseded");
  await history.reconcile(record, "context-two");
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(2);
  await expect(history.action(record, "owner", second.suggestionId, action(), "context-two")).rejects.toMatchObject({ code: "suggestion_changed" });
});
it("exports one extension with original text and chosen action without manufacturing a model turn", async () => {
  const value = await create(); now += 1000;
  await history.action(record, "owner", value.suggestionId, action({ action: "dismissed" }), "context-one");
  const entries = project(record, await store.readEvents(record.id), { appId: "unrelated.harness", installationId: "install", key: "history" });
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ actor: { kind: "system" }, updatedAt: new Date(now).toISOString(), data: { kind: "extension", name: "hosty.harness/prompt-suggestion", version: 1,
    payload: { text: value.text, state: "dismissed", answerSeq: 1 }, fallbackText: `Suggested next message: ${value.text}\nDismissed` } });
  expect(entries.filter(entry => entry.data.kind === "message")).toHaveLength(1);
});
