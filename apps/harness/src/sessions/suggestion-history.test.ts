import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, type SessionRecord } from "./store.js";
import { SuggestionHistory, legacyCompatibleSuggestion } from "./suggestion-history.js";
import { LEGACY_SUGGESTION_WINDOW_MS } from "../harness/prompt-suggestion.js";
import { project } from "../history/projection.js";

let root: string, store: SessionStore, record: SessionRecord, history: SuggestionHistory, now: number;
const build = () => new SuggestionHistory(store, async (id, payload) => {
  const seq = ++record.lastEventSeq;
  await store.appendEvent(id, { seq, ts: new Date(now).toISOString(), ...payload });
  await store.saveRecord(record);
  return seq;
});
const create = (attemptId = "attempt") => history.create(record, { attemptId, text: "Review @app literally <script>hello</script>", contextKey: "context-one" });
const action = (extra = {}) => ({ requestId: randomUUID(), expectedRevision: 1, action: "selected-for-draft", ...extra });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hosty-suggestion-history-")); now = Date.parse("2026-11-09T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  store = new SessionStore(root);
  record = { id: randomUUID(), createdBy: "owner", title: null, context: null, status: "idle", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), harnessSessionId: null, lastEventSeq: 1 };
  await store.createSession(record); await store.appendEvent(record.id, { seq: 1, ts: record.createdAt, type: "assistant_text", text: "Completed answer." });
  history = build();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("retains literal correlated predictions once across duplicate delivery and restart", async () => {
  const first = await create(); history = build();
  expect(await create()).toEqual(first);
  expect(first).toMatchObject({ answerSeq: 1, state: "available", revision: 1, text: "Review @app literally <script>hello</script>" });
  expect((await store.readEvents(record.id)).map(event => event.type)).toEqual(["assistant_text", "prompt_suggestion_created"]);
});
it("returns the exact recorded choice after lost replies/restart and rejects competing choices", async () => {
  const value = await create(), input = action();
  const selected = await history.action(record, "owner", value.suggestionId, input, "context-one");
  now += 20 * 60_000; history = build();
  expect(await history.action(record, "owner", value.suggestionId, input, "different-context")).toEqual(selected);
  await expect(history.action(record, "owner", value.suggestionId, { ...input, action: "dismissed" }, "context-one")).rejects.toMatchObject({ code: "suggestion_request_conflict" });
  await expect(history.action(record, "owner", value.suggestionId, action({ action: "dismissed" }), "context-one")).rejects.toMatchObject({ code: "suggestion_changed" });
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(1);
});
it("keeps terminal compatibility deadlines stable across same-UUID retries and restart", async () => {
  const value = await create(), input = action();
  const selected = await history.action(record, "owner", value.suggestionId, input, "context-one");
  const firstResponse = legacyCompatibleSuggestion(selected);
  expect(firstResponse.expiresAt).toBe(Date.parse(selected.resolvedAt!) + LEGACY_SUGGESTION_WINDOW_MS);
  now += 1234; history = build();
  const replay = await history.action(record, "owner", value.suggestionId, input, "different-context");
  expect(legacyCompatibleSuggestion(replay)).toEqual(firstResponse);
  now += 30 * 24 * 60 * 60_000; history = build();
  expect(legacyCompatibleSuggestion((await history.read(record)).get(value.suggestionId)!)).toEqual(firstResponse);
  const legacy = { ...selected, resolvedAt: undefined };
  const legacyResponse = legacyCompatibleSuggestion(legacy);
  expect(legacyResponse.expiresAt).toBe(Date.parse(selected.createdAt) + LEGACY_SUGGESTION_WINDOW_MS);
  now += 1000;
  expect(legacyCompatibleSuggestion(legacy)).toEqual(legacyResponse);
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(1);
});
it("checks owner and UUID/revision before writing any explicit choice", async () => {
  const value = await create();
  await expect(history.action(record, "other", value.suggestionId, action(), "context-one")).rejects.toMatchObject({ status: 403 });
  await expect(history.action(record, "owner", value.suggestionId, action({ requestId: "bad" }), "context-one")).rejects.toMatchObject({ status: 400 });
  await expect(history.action(record, "owner", value.suggestionId, action({ expectedRevision: 7 }), "context-one")).rejects.toMatchObject({ status: 409 });
  expect((await history.read(record)).get(value.suggestionId)?.state).toBe("available");
});
it("keeps suggestions available after long waits and restart, while superseding changed context", async () => {
  const first = await create(); now += 30 * 24 * 60 * 60_000; history = build();
  await history.reconcile(record, "context-one");
  expect((await history.read(record)).get(first.suggestionId)?.state).toBe("available");
  expect((await store.readEvents(record.id)).find(event => event.type === "prompt_suggestion_created")).toHaveProperty("expiresAt");
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(0);
  expect((await history.action(record, "owner", first.suggestionId, action(), "context-one")).state).toBe("selected-for-draft");
  const second = await create("second"); await history.reconcile(record, "context-two");
  expect((await history.read(record)).get(second.suggestionId)?.state).toBe("superseded");
  await history.reconcile(record, "context-two");
  expect((await store.readEvents(record.id)).filter(event => event.type === "prompt_suggestion_resolved")).toHaveLength(2);
  await expect(history.action(record, "owner", second.suggestionId, action(), "context-two")).rejects.toMatchObject({ code: "suggestion_changed" });
});
it("ignores old deadline fields when reading and selecting unresolved suggestions", async () => {
  await store.appendEvent(record.id, { type: "prompt_suggestion_created", seq: ++record.lastEventSeq, ts: new Date(now).toISOString(),
    suggestionId: "legacy", sessionId: record.id, userId: "owner", attemptId: "legacy", answerSeq: 1, text: "Continue", contextKey: "context-one", expiresAt: now - 1 });
  history = build(); await history.reconcile(record, "context-one");
  const restored = (await history.read(record)).get("legacy")!;
  expect(restored).toMatchObject({ state: "available" });
  expect(legacyCompatibleSuggestion(restored).expiresAt).toBeGreaterThan(now);
  expect((await history.action(record, "owner", "legacy", action(), "context-one")).state).toBe("selected-for-draft");
});
it("keeps created events and REST projections readable by old browser deadline guards", async () => {
  const value = await create();
  const created = (await store.readEvents(record.id)).find(event => event.type === "prompt_suggestion_created")!;
  // Harness 0.96.5 rejects creation events without this finite field, then schedules its timer.
  const legacyAccepts = (event: Record<string, unknown>) => event.type === "prompt_suggestion_created"
    && typeof event.suggestionId === "string" && typeof event.sessionId === "string" && typeof event.userId === "string"
    && typeof event.attemptId === "string" && typeof event.text === "string" && !!event.text.trim() && [...event.text].length <= 2000
    && typeof event.expiresAt === "number" && Number.isFinite(event.expiresAt);
  expect(legacyAccepts(created)).toBe(true);
  const delay = Number(created.expiresAt) - now;
  expect(delay).toBeGreaterThan(0); expect(delay).toBeLessThanOrEqual(2_147_483_647);
  const clientClockBehind = now - 10 * 60_000;
  expect(Number(created.expiresAt) - clientClockBehind).toBeLessThanOrEqual(2_147_483_647);
  const original = structuredClone(value), firstResponse = legacyCompatibleSuggestion(value);
  expect(Number.isFinite(firstResponse.expiresAt)).toBe(true);
  expect(firstResponse.expiresAt - now).toBe(LEGACY_SUGGESTION_WINDOW_MS);
  now += 30 * 24 * 60 * 60_000; history = build(); await history.reconcile(record, "context-one");
  const afterRestart = (await history.read(record)).get(value.suggestionId)!;
  expect(afterRestart).toEqual(original);
  const nextResponse = legacyCompatibleSuggestion(afterRestart);
  expect(nextResponse.expiresAt).toBeGreaterThan(now);
  expect(nextResponse.expiresAt - now).toBeLessThanOrEqual(2_147_483_647);
  expect(afterRestart).not.toHaveProperty("expiresAt");
});
it("reads legacy expiry receipts as terminal supersession without reviving closed choices", async () => {
  const value = await create();
  await store.appendEvent(record.id, { type: "prompt_suggestion_resolved", seq: ++record.lastEventSeq, ts: new Date(now).toISOString(),
    suggestionId: value.suggestionId, state: "expired" });
  history = build(); await history.reconcile(record, "context-one");
  expect((await history.read(record)).get(value.suggestionId)).toMatchObject({ state: "superseded", revision: 2 });
  await expect(history.action(record, "owner", value.suggestionId, action(), "context-one")).rejects.toMatchObject({ code: "suggestion_changed" });
  const entries = project(record, await store.readEvents(record.id), { appId: "unrelated.harness", installationId: "install", key: "history" });
  expect(entries[1]!.data).toMatchObject({ payload: { state: "superseded" }, fallbackText: `Suggested next message: ${value.text}\nSuperseded` });
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
