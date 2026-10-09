import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { streamEvents, type StreamConnection, type AssistantEvent } from "./assistant-api";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

it("reports disconnect/replay readiness and keeps the durable cursor separate from activity revisions", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const states: StreamConnection[] = [], events: AssistantEvent[] = [];
  const first = new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(frame({ type: "user_message", seq: 4, text: "test" }));
    stream.enqueue(frame({ type: "session_activity", seq: -1, revision: 999, activity: { phase: "thinking" } }));
    stream.enqueue(frame({ type: "session_status", seq: 4, status: "running" }));
    stream.close();
  } });
  vi.mocked(appFetch).mockResolvedValueOnce(new Response(first)).mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
    stream.enqueue(frame({ type: "session_activity", seq: -1, revision: 1000, activity: null }));
    stream.enqueue(frame({ type: "session_status", seq: 4, status: "idle" }));
    stream.close();
  } })));
  const task = streamEvents("session", event => {
    events.push(event);
    if (event.type === "session_status" && event.status === "idle") controller.abort();
  }, controller.signal, state => states.push(state));
  await vi.advanceTimersByTimeAsync(2000);
  await task;
  expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);
  expect(vi.mocked(appFetch).mock.calls[1]?.[0]).toBe("/api/sessions/session/events?after=4");
  expect(events.filter(e => e.type === "session_activity")).toHaveLength(2);
});

it("does not retry a terminal access failure", async () => {
  const states: StreamConnection[] = [], events: AssistantEvent[] = [];
  vi.mocked(appFetch).mockResolvedValue(new Response(null, { status: 403 }));
  await streamEvents("session", event => events.push(event), new AbortController().signal, state => states.push(state));
  expect(states).toEqual(["connecting", "disconnected"]);
  expect(events[0]?.type).toBe("error");
  expect(appFetch).toHaveBeenCalledTimes(1);
});

it("leaves a silent but open heartbeat stream connected and cancels the retry timer on unmount", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const states: StreamConnection[] = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(appFetch).mockResolvedValue(new Response(new ReadableStream({ start(stream) {
    source = stream;
    stream.enqueue(frame({ type: "session_status", seq: 1, status: "running" }));
    stream.enqueue(new TextEncoder().encode(":hb\n\n"));
  } })));
  const task = streamEvents("session", () => {}, controller.signal, state => states.push(state));
  await vi.advanceTimersByTimeAsync(60000);
  expect(states).toEqual(["connecting", "connected"]);
  source.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toBe("reconnecting");
  controller.abort();
  await task;
  expect(appFetch).toHaveBeenCalledTimes(1);
});
