// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reduceSuggestion, usePromptSuggestions, type PromptSuggestion } from "./prompt-suggestions";
import { SuggestionInsertion, insertionScope } from "./suggestion-insertion";
import { AssistantApiError, getPromptSuggestions, resolvePromptSuggestion } from "./assistant-api";
import type { AssistantEvent, AssistantSession } from "./assistant-api";
vi.mock("./assistant-api", () => ({
  getSuggestionPreference: vi.fn(async () => ({ enabled: true, revision: 0 })), setSuggestionPreference: vi.fn(),
  getPromptSuggestions: vi.fn(async () => []), resolvePromptSuggestion: vi.fn(),
  AssistantApiError: class extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
const session: AssistantSession = { id: "chat", createdBy: "owner", status: "idle", title: null, createdAt: "" };
const created: AssistantEvent = { type: "prompt_suggestion_created", seq: 2, ts: "2026-11-09T12:00:00Z", suggestionId: "suggestion", sessionId: "chat", userId: "owner", attemptId: "attempt", text: "Review @app literally", answerSeq: 1 };
const result = (state: PromptSuggestion["state"] = "selected-for-draft"): PromptSuggestion => ({ suggestionId: "suggestion", sessionId: "chat", userId: "owner", attemptId: "attempt", text: String(created.text), answerSeq: 1, createdAt: created.ts, revision: 2, state });
let root: Root, container: HTMLDivElement, hook: ReturnType<typeof usePromptSuggestions>, occupied: boolean;
const insert = vi.fn(() => true);
function Probe() {
  const value = usePromptSuggestions(session, true, occupied, { insert, scope: "installation" });
  useLayoutEffect(() => { hook = value; });
  return null;
}
const render = () => act(async () => { root.render(<Probe />); });
const receive = (event = created) => act(async () => { hook.receive(event); });
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); vi.clearAllMocks(); occupied = false;
  vi.mocked(resolvePromptSuggestion).mockResolvedValue(result());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render(); await receive();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("records selection before inserting literal draft text and never inserts on a competing choice", async () => {
  vi.mocked(resolvePromptSuggestion).mockImplementation(async () => { expect(insert).not.toHaveBeenCalled(); return result(); });
  await act(async () => { await hook.select("suggestion"); });
  expect(insert).toHaveBeenCalledExactlyOnceWith(created.text); expect(hook.cards.get("suggestion")?.state).toBe("selected-for-draft");
  expect(localStorage.getItem("hosty.assistant.draft.chat")).toBe(created.text);
});
it("refreshes a conflicting choice without overwriting the draft", async () => {
  vi.mocked(resolvePromptSuggestion).mockRejectedValue(new AssistantApiError("suggestion_changed", "Changed", 409));
  vi.mocked(getPromptSuggestions).mockResolvedValue([result("dismissed")]);
  await act(async () => { await hook.select("suggestion"); });
  expect(insert).not.toHaveBeenCalled(); expect(hook.cards.get("suggestion")?.state).toBe("dismissed");
});
it("retains the same dismissal UUID after an uncertain reply", async () => {
  vi.mocked(resolvePromptSuggestion).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result("dismissed"));
  await act(async () => { await hook.dismiss("suggestion"); });
  const original = vi.mocked(resolvePromptSuggestion).mock.calls[0][2];
  expect(hook.insertionError).toContain("not confirmed");
  await act(async () => { await hook.retryInsertion(); });
  expect(vi.mocked(resolvePromptSuggestion).mock.calls[1][2]).toEqual(original);
  expect(original.action).toBe("dismissed"); expect(insert).not.toHaveBeenCalled();
});
it("does not insert after an edit and clear while the server choice is pending", async () => {
  let resolve!: (value: PromptSuggestion) => void;
  vi.mocked(resolvePromptSuggestion).mockReturnValue(new Promise(done => { resolve = done; }));
  let selecting!: Promise<void>;
  await act(async () => { selecting = hook.select("suggestion"); });
  await act(async () => { hook.interact(); hook.interact(); resolve(result()); await selecting; });
  expect(insert).not.toHaveBeenCalled(); expect(hook.insertionError).toContain("draft changed");
  expect(localStorage.getItem("hosty.assistant.draft.chat")).toBeNull();
});
it("retains historical cards during draft interactions and suppresses selection while occupied", async () => {
  occupied = true; await render();
  await act(async () => { hook.interact(); await hook.select("suggestion"); });
  expect(hook.cards.get("suggestion")?.state).toBe("available"); expect(resolvePromptSuggestion).not.toHaveBeenCalled();
  await receive({ ...created, type: "prompt_suggestion_resolved", state: "dismissed", seq: 3 });
  expect(hook.cards.get("suggestion")?.state).toBe("dismissed");
  await receive(created); expect(hook.cards.get("suggestion")?.state).toBe("dismissed");
});

it("recovers a lost selection reply after reload using its original operation identity", async () => {
  vi.mocked(resolvePromptSuggestion).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result());
  await act(async () => { await hook.select("suggestion"); });
  const original = vi.mocked(resolvePromptSuggestion).mock.calls[0][2];
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(vi.mocked(resolvePromptSuggestion).mock.calls[1][2]).toEqual(original);
  expect(insert).toHaveBeenCalledExactlyOnceWith(created.text);
});

it("recovers the saved-draft crash window without another insertion or recreating cleared text", async () => {
  const controller = new SuggestionInsertion(insertionScope(`${location.origin}/installation`, "owner", "chat"), "chat");
  controller.selected(controller.stage({ suggestionId: "suggestion", revision: 1, text: String(created.text) }));
  localStorage.setItem("hosty.assistant.draft.chat", String(created.text)); occupied = true;
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(insert).not.toHaveBeenCalled(); expect(hook.insertionError).toBeNull(); expect(controller.read()).toBeNull();
  localStorage.setItem("hosty.assistant.draft.chat", ""); occupied = false; await render();
  await receive(); await receive({ type: "prompt_suggestion_resolved", seq: 3, ts: "", suggestionId: "suggestion", state: "selected-for-draft" });
  expect(insert).not.toHaveBeenCalled();
});

it("keeps the hint and accepts its original text after waiting beyond the old time limit", async () => {
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); });
  expect(hook.suggestion?.text).toBe(created.text);
  expect(hook.cards.get("suggestion")?.state).toBe("available");
  await act(async () => { await hook.select("suggestion"); });
  expect(insert).toHaveBeenCalledExactlyOnceWith(created.text);
});
it("replays legacy expiry as supersession while preserving the terminal revision", () => {
  const cards = reduceSuggestion(new Map(), created);
  const closed = reduceSuggestion(cards, { type: "prompt_suggestion_resolved", seq: 3, ts: "", suggestionId: "suggestion", state: "expired" });
  expect(closed.get("suggestion")).toMatchObject({ state: "superseded", revision: 2 });
  expect(reduceSuggestion(closed, created).get("suggestion")).toMatchObject({ state: "superseded", revision: 2 });
});
