// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./api";
import { feedbackCardForEvent, feedbackReferenceForEvent, useFeedbackTranscript, type FeedbackTranscriptCard } from "./feedback-transcript";
import type { AssistantEvent } from "./assistant-api";

vi.mock("./api", () => ({ call: vi.fn() }));
const dispatchId = randomUUID();
const card = (extra: Partial<FeedbackTranscriptCard> = {}): FeedbackTranscriptCard => ({
  version: 1, dispatchId, messageSequence: 7, instruction: "Reviewed instruction",
  reports: [{ id: "report-one", appId: "independent.app", appName: "Example", version: "1.2.3", comment: "Reviewed snapshot",
    annotations: [{ id: "note-one", text: "Move this control", route: "/original", hasImage: true }] }], ...extra,
});
const message = (extra: Partial<AssistantEvent> = {}): AssistantEvent => ({ seq: 7, ts: "", type: "user_message", clientRequestId: dispatchId, text: "Original provider prompt", ...extra });
const referenced = (extra: Partial<AssistantEvent> = {}) => message({ feedback: { version: 1, dispatchId }, ...extra });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("feedback transcript admission matching", () => {
  it("uses exact request and accepted event sequence for legacy and referenced history without interpreting text", () => {
    const snapshot = card();
    expect(feedbackCardForEvent(message(), [snapshot])).toBe(snapshot);
    expect(feedbackCardForEvent(referenced(), [snapshot])).toBe(snapshot);
    expect(feedbackCardForEvent(message({ text: "Completely different display text" }), [snapshot])).toBe(snapshot);
    expect(feedbackCardForEvent(message({ seq: 8 }), [snapshot])).toBeUndefined();
    expect(feedbackCardForEvent(message({ clientRequestId: randomUUID() }), [snapshot])).toBeUndefined();
    expect(feedbackCardForEvent(message({ clientRequestId: undefined, text: "Address the following administrator-selected feedback\n" + JSON.stringify(snapshot) }), [snapshot])).toBeUndefined();
    expect(feedbackCardForEvent(message({ type: "assistant_text" }), [snapshot])).toBeUndefined();
    expect(feedbackCardForEvent(message(), [snapshot, { ...snapshot }])).toBeUndefined();
  });

  it("rejects invalid, mismatched or unsupported explicit references instead of treating them as legacy", () => {
    for (const feedback of [null, [], {}, { version: 2, dispatchId }, { version: 1, dispatchId: randomUUID() }, { version: 1, dispatchId: "not-a-uuid" }]) {
      const event = message({ feedback });
      expect(feedbackReferenceForEvent(event)).toBeUndefined();
      expect(feedbackCardForEvent(event, [card()])).toBeUndefined();
    }
    expect(feedbackReferenceForEvent(referenced({ clientRequestId: undefined }))).toBeUndefined();
    expect(feedbackReferenceForEvent(referenced({ type: "assistant_text" }))).toBeUndefined();
  });

  it("compares UUID spelling case-insensitively while preserving reviewed snapshot data", () => {
    const snapshot = card(), before = JSON.stringify(snapshot);
    const event = message({ clientRequestId: dispatchId.toUpperCase(), feedback: { version: 1, dispatchId: dispatchId.toUpperCase() } });
    expect(feedbackReferenceForEvent(event)?.dispatchId).toBe(dispatchId.toUpperCase());
    expect(feedbackCardForEvent(event, [snapshot])).toBe(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

type Observation = ReturnType<typeof useFeedbackTranscript>;
let root: Root, container: HTMLDivElement, latest: Observation, mounted: boolean;
const observations: { sessionId?: string; cards: readonly FeedbackTranscriptCard[] }[] = [];
function Probe({ sessionId, events, ready }: { sessionId?: string; events: readonly AssistantEvent[]; ready: boolean }) {
  const observation = useFeedbackTranscript(sessionId, events, ready);
  useEffect(() => {
    latest = observation;
    observations.push({ sessionId, cards: observation.cards });
  }, [sessionId, observation]);
  return null;
}
const render = (sessionId: string | undefined = "session-one", events: readonly AssistantEvent[] = [message()], ready = true) =>
  act(async () => root.render(<Probe sessionId={sessionId} events={events} ready={ready} />));
const focus = () => act(async () => window.dispatchEvent(new Event("focus")));

beforeEach(() => {
  vi.clearAllMocks(); observations.length = 0; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(call).mockImplementation(async () => Response.json({ cards: [card()] }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove(); vi.unstubAllGlobals();
});

describe("feedback transcript observations", () => {
  it("loads legacy history after replay is ready even without trusted reference metadata", async () => {
    await render("session-one", [message()], false);
    expect(call).not.toHaveBeenCalled(); expect(latest.cards).toEqual([]); expect(latest.loading).toBe(false);
    await render();
    expect(call).toHaveBeenCalledExactlyOnceWith("/feedback/transcript?sessionId=session-one", { signal: expect.any(AbortSignal) });
    expect(latest.cards).toEqual([card()]); expect(latest.loading).toBe(false);
  });

  it("waits for a session and user history, then refreshes for new trusted feedback without polling prose or tools", async () => {
    await act(async () => root.render(<Probe events={[message()]} ready />));
    await render("session-one", [], true);
    expect(call).not.toHaveBeenCalled();
    await render("session-one", [message()]); expect(call).toHaveBeenCalledTimes(1);
    const ordinary = message({ seq: 11, clientRequestId: randomUUID(), text: "Ordinary next prompt" });
    const changes = [message(), ordinary, { seq: 12, ts: "", type: "tool_use", toolName: "Read" }, { seq: 13, ts: "", type: "assistant_text", text: "Streamed response" }];
    await render("session-one", changes);
    await render("session-one", [...changes, { seq: 14, ts: "", type: "assistant_delta", text: "More prose" }]);
    expect(call).toHaveBeenCalledTimes(1);
    const nextId = randomUUID(), next = card({ dispatchId: nextId, messageSequence: 15 });
    vi.mocked(call).mockResolvedValueOnce(Response.json({ cards: [card(), next] }));
    await render("session-one", [...changes, referenced({ seq: 15, clientRequestId: nextId, feedback: { version: 1, dispatchId: nextId } })]);
    expect(call).toHaveBeenCalledTimes(2); expect(latest.cards).toEqual([card(), next]);
  });

  it("reports initial loading while a read is pending and exposes its reviewed result", async () => {
    const read = deferred<Response>(); vi.mocked(call).mockReturnValueOnce(read.promise);
    await render(); expect(latest.cards).toEqual([]); expect(latest.loading).toBe(true);
    await act(async () => read.resolve(Response.json({ cards: [card()] })));
    expect(latest.cards).toEqual([card()]); expect(latest.loading).toBe(false);
  });

  it.each([new Error("Network unavailable"), Object.assign(new Error("Feedback permission revoked"), { status: 403 })])(
    "clears retained cards on a failed authorized refresh and recovers on focus", async error => {
      await render(); expect(latest.cards).toHaveLength(1);
      vi.mocked(call).mockRejectedValueOnce(error); await focus();
      expect(latest.cards).toEqual([]); expect(latest.loading).toBe(false);
      await focus(); expect(latest.cards).toEqual([card()]); expect(call).toHaveBeenCalledTimes(3);
    },
  );

  it.each([{ cards: null }, {}, null])("falls back safely when the cards envelope is unavailable %#", async value => {
    vi.mocked(call).mockResolvedValueOnce(Response.json(value)); await render();
    expect(latest.cards).toEqual([]); expect(latest.loading).toBe(false);
  });

  it("ignores an older focus response after a newer refresh finishes", async () => {
    await render();
    const old = deferred<Response>(), fresh = card({ instruction: "Newest reviewed instruction" });
    vi.mocked(call).mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ cards: [fresh] }));
    await focus(); await focus(); expect(latest.cards).toEqual([fresh]);
    await act(async () => old.resolve(Response.json({ cards: [card({ instruction: "Stale result" })] })));
    expect(latest.cards).toEqual([fresh]);
  });

  it("never exposes one session's cards while another session is selected and ignores its late read", async () => {
    await render(); expect(latest.cards).toEqual([card()]);
    const old = deferred<Response>(); vi.mocked(call).mockReturnValueOnce(old.promise); await focus();
    const oldSignal = vi.mocked(call).mock.calls[1][1]!.signal as AbortSignal;
    const next = deferred<Response>(), nextCard = card({ dispatchId: randomUUID(), instruction: "Other chat" });
    vi.mocked(call).mockReturnValueOnce(next.promise); await render("session-two", [message({ clientRequestId: nextCard.dispatchId })]);
    expect(oldSignal.aborted).toBe(true); expect(latest.cards).toEqual([]); expect(latest.loading).toBe(true);
    expect(observations.filter(item => item.sessionId === "session-two").every(item => item.cards.length === 0)).toBe(true);
    await act(async () => next.resolve(Response.json({ cards: [nextCard] })));
    await act(async () => old.resolve(Response.json({ cards: [card({ instruction: "Late old chat" })] })));
    expect(latest.cards).toEqual([nextCard]);
  });

  it("hides cards when history becomes unavailable and aborts pending reads on disable and unmount", async () => {
    const read = deferred<Response>(); vi.mocked(call).mockReturnValueOnce(read.promise);
    await render(); const signal = vi.mocked(call).mock.calls[0][1]!.signal as AbortSignal;
    await render("session-one", [message()], false);
    expect(signal.aborted).toBe(true); expect(latest.cards).toEqual([]); expect(latest.loading).toBe(false);
    await act(async () => read.resolve(Response.json({ cards: [card()] })));
    expect(latest.cards).toEqual([]);
    const pending = deferred<Response>(); vi.mocked(call).mockReturnValueOnce(pending.promise); await render();
    const finalSignal = vi.mocked(call).mock.calls[1][1]!.signal as AbortSignal;
    await act(async () => root.unmount()); mounted = false;
    expect(finalSignal.aborted).toBe(true);
    const renderCount = observations.length;
    await act(async () => pending.resolve(Response.json({ cards: [card()] })));
    await focus(); expect(observations).toHaveLength(renderCount); expect(call).toHaveBeenCalledTimes(2);
  });
});
