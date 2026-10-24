import { afterEach, expect, it, vi } from "vitest";
import { openEventStream } from "./event-stream";
import { streamEvents, type StreamConnection, type AssistantEvent } from "./assistant-api";

vi.mock("./event-stream", () => ({ openEventStream: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
  vi.mocked(openEventStream).mockResolvedValueOnce(new Response(first)).mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
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
  expect(vi.mocked(openEventStream).mock.calls[1]?.[0]).toBe("/api/sessions/session/events?after=4");
  expect(events.filter(e => e.type === "session_activity")).toHaveLength(2);
});

it("does not retry a terminal access failure", async () => {
  const states: StreamConnection[] = [], events: AssistantEvent[] = [];
  vi.mocked(openEventStream).mockResolvedValue(new Response(null, { status: 403 }));
  await streamEvents("session", event => events.push(event), new AbortController().signal, state => states.push(state));
  expect(states).toEqual(["connecting", "disconnected"]);
  expect(events[0]?.type).toBe("error");
  expect(openEventStream).toHaveBeenCalledTimes(1);
});

it("leaves a silent but open heartbeat stream connected and cancels the retry timer on unmount", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const states: StreamConnection[] = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(openEventStream).mockResolvedValue(new Response(new ReadableStream({ start(stream) {
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
  expect(openEventStream).toHaveBeenCalledTimes(1);
});

it("waits for the authoritative snapshot across chunks containing historical statuses", async () => {
  const controller = new AbortController();
  const states: StreamConnection[] = [], events: AssistantEvent[] = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(openEventStream).mockResolvedValue(new Response(new ReadableStream({ start(stream) { source = stream; } })));
  const task = streamEvents("session", event => events.push(event), controller.signal, state => states.push(state));
  source.enqueue(frame({ type: "session_status", seq: 1, status: "idle", historical: true }));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(states).toEqual(["connecting"]);
  source.enqueue(frame({ type: "session_status", seq: 2, status: "running", historical: true }));
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(states).toEqual(["connecting"]);
  source.enqueue(frame({ type: "session_status", seq: 3, status: "awaiting_approval" }));
  await vi.waitFor(() => expect(states).toEqual(["connecting", "connected"]));
  controller.abort(); await task;
});


function visibilityDocument(initial: "visible" | "hidden" = "visible") {
  const target = Object.assign(new EventTarget(), { visibilityState: initial });
  vi.stubGlobal("document", target);
  return (state: "visible" | "hidden") => {
    target.visibilityState = state;
    target.dispatchEvent(new Event("visibilitychange"));
  };
}

function heldResponse(events: unknown[] = [], status = 200) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(stream) { source = stream; for (const event of events) stream.enqueue(frame(event)); },
    cancel,
  });
  return { response: new Response(body, { status }), body, cancel, close: () => { try { source.close(); } catch {} } };
}

it("does not open while initially hidden and removes visibility listeners when aborted there", async () => {
  vi.useFakeTimers();
  visibilityDocument("hidden");
  const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
  const abort = new AbortController(), held = heldResponse();
  vi.mocked(openEventStream).mockResolvedValue(held.response);
  const task = streamEvents("session", () => {}, abort.signal);
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openEventStream).not.toHaveBeenCalled();
    abort.abort(); await task;
    const handler = add.mock.calls.find(([event]) => event === "visibilitychange")?.[1];
    expect(handler).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("visibilitychange", handler);
    expect(vi.getTimerCount()).toBe(0);
  } finally { abort.abort(); held.close(); await task; }
});

it("pauses a hidden document and resumes immediately from the same durable cursor", async () => {
  vi.useFakeTimers();
  const visibility = visibilityDocument();
  const first = heldResponse([{ type: "user_message", seq: 7, text: "retained transcript" }, { type: "session_status", seq: 7, status: "running" }]);
  const second = heldResponse([{ type: "session_activity", seq: -1, revision: 90, activity: null }, { type: "session_status", seq: 7, status: "idle" }]);
  vi.mocked(openEventStream).mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  const abort = new AbortController(), states: StreamConnection[] = [], events: AssistantEvent[] = [];
  const task = streamEvents("session", event => events.push(event), abort.signal, state => states.push(state));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("connected");
    visibility("hidden"); await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(openEventStream).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(first.cancel).toHaveBeenCalledOnce(); expect(first.body.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000); expect(openEventStream).toHaveBeenCalledTimes(1);
    visibility("visible"); await vi.advanceTimersByTimeAsync(0);
    expect(openEventStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openEventStream).mock.calls[1]?.[0]).toBe("/api/sessions/session/events?after=7");
    expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    expect(events.filter(event => event.type === "user_message")).toHaveLength(1);
    expect(events.at(-1)?.status).toBe("idle");
  } finally { abort.abort(); first.close(); second.close(); await task; }
});

it.each([401, 403, 404, 410])("cancels a terminal refusal body without retrying (%i)", async status => {
  const held = heldResponse([], status), events: AssistantEvent[] = [];
  vi.mocked(openEventStream).mockResolvedValue(held.response);
  await streamEvents("session", event => events.push(event), new AbortController().signal);
  expect(held.cancel).toHaveBeenCalledOnce(); expect(held.body.locked).toBe(false);
  expect(events[0]?.type).toBe("error"); expect(openEventStream).toHaveBeenCalledOnce();
});

it("cancels and releases a reader when a terminal deletion arrives before EOF", async () => {
  const held = heldResponse([{ type: "session_deleted", seq: 8 }]);
  vi.mocked(openEventStream).mockResolvedValue(held.response);
  await streamEvents("session", () => {}, new AbortController().signal);
  expect(held.cancel).toHaveBeenCalledOnce(); expect(held.body.locked).toBe(false);
  expect(openEventStream).toHaveBeenCalledOnce();
});

it("cancels a rejected response body before retrying", async () => {
  vi.useFakeTimers();
  const refused = heldResponse([], 500), next = heldResponse();
  vi.mocked(openEventStream).mockResolvedValueOnce(refused.response).mockResolvedValueOnce(next.response);
  const abort = new AbortController(), task = streamEvents("session", () => {}, abort.signal);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(refused.cancel).toHaveBeenCalledOnce(); expect(refused.body.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); expect(openEventStream).toHaveBeenCalledTimes(2);
  } finally { abort.abort(); refused.close(); next.close(); await task; }
});

it("cancels a pending reader on caller abort even before another chunk arrives", async () => {
  vi.useFakeTimers();
  const held = heldResponse(), abort = new AbortController();
  vi.mocked(openEventStream).mockResolvedValue(held.response);
  const task = streamEvents("session", () => {}, abort.signal);
  try {
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(held.cancel).toHaveBeenCalledOnce(); expect(held.body.locked).toBe(false);
    await task; expect(vi.getTimerCount()).toBe(0);
  } finally { held.close(); await task; }
});


it("discards a response that arrives after a visibility abort without replacing the resumed attempt", async () => {
  vi.useFakeTimers();
  const visibility = visibilityDocument(), late = heldResponse([{ type: "user_message", seq: 99 }]), resumed = heldResponse([{ type: "session_status", seq: 1, status: "idle" }]);
  let finish!: (response: Response) => void;
  vi.mocked(openEventStream).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(resumed.response);
  const abort = new AbortController(), events: AssistantEvent[] = [];
  const task = streamEvents("session", event => events.push(event), abort.signal);
  try {
    await vi.advanceTimersByTimeAsync(0);
    visibility("hidden"); visibility("visible"); finish(late.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.cancel).toHaveBeenCalledOnce(); expect(late.body.locked).toBe(false);
    expect(openEventStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openEventStream).mock.calls[1]?.[0]).toBe("/api/sessions/session/events?after=0");
    expect(vi.mocked(openEventStream).mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(events.map(event => event.seq)).toEqual([1]);
  } finally { abort.abort(); late.close(); resumed.close(); await task; }
});

it("retains a terminal authority refusal when response cleanup fails", async () => {
  const held = heldResponse([], 403), states: StreamConnection[] = [];
  held.cancel.mockRejectedValue(new Error("cancel failed"));
  vi.mocked(openEventStream).mockResolvedValue(held.response);
  await streamEvents("session", () => {}, new AbortController().signal, state => states.push(state));
  expect(states).toEqual(["connecting", "disconnected"]);
  expect(openEventStream).toHaveBeenCalledOnce(); expect(held.body.locked).toBe(false);
});

it("waits for verified identity recovery after 401 and resumes from the retained cursor", async () => {
  vi.useFakeTimers();
  const identity = new EventTarget(); vi.stubGlobal("window", identity);
  const visibility = visibilityDocument();
  const first = heldResponse([{ type: "user_message", seq: 7, text: "already accepted" }, { type: "session_status", seq: 7, status: "idle" }]);
  const expired = heldResponse([], 401), resumed = heldResponse([{ type: "session_status", seq: 7, status: "idle" }]);
  vi.mocked(openEventStream).mockResolvedValueOnce(first.response).mockResolvedValueOnce(expired.response).mockResolvedValueOnce(resumed.response);
  const abort = new AbortController(), events: AssistantEvent[] = [], states: StreamConnection[] = [];
  const task = streamEvents("session", event => events.push(event), abort.signal, state => states.push(state));
  try {
    await vi.advanceTimersByTimeAsync(0); first.close(); await vi.advanceTimersByTimeAsync(2000);
    expect(states.at(-1)).toBe("disconnected"); expect(expired.cancel).toHaveBeenCalledOnce();
    visibility("hidden"); visibility("visible");
    await vi.advanceTimersByTimeAsync(60_000); expect(openEventStream).toHaveBeenCalledTimes(2);
    identity.dispatchEvent(new Event("hosty:app-session-restored"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openEventStream).toHaveBeenCalledTimes(3);
    expect(vi.mocked(openEventStream).mock.calls[2]?.[0]).toBe("/api/sessions/session/events?after=7");
    expect(states.at(-1)).toBe("connected");
    expect(events.filter(event => event.type === "user_message")).toHaveLength(1);
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
  } finally { abort.abort(); first.close(); expired.close(); resumed.close(); await task; }
});

it("does not miss identity recovery while the old stream refusal is in flight", async () => {
  vi.useFakeTimers();
  const identity = new EventTarget(); vi.stubGlobal("window", identity);
  let refuse!: (response: Response) => void;
  const expired = heldResponse([], 401), resumed = heldResponse([{ type: "session_status", seq: 1, status: "idle" }]);
  vi.mocked(openEventStream).mockImplementationOnce(() => new Promise(resolve => { refuse = resolve; })).mockResolvedValueOnce(resumed.response);
  const abort = new AbortController(), states: StreamConnection[] = [];
  const task = streamEvents("session", () => {}, abort.signal, state => states.push(state));
  try {
    await vi.advanceTimersByTimeAsync(0);
    identity.dispatchEvent(new Event("hosty:app-session-restored")); refuse(expired.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(openEventStream).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("connected");
  } finally { abort.abort(); expired.close(); resumed.close(); await task; }
});

it("removes the identity listener when an expired stream is abandoned", async () => {
  vi.useFakeTimers();
  const identity = new EventTarget(); vi.stubGlobal("window", identity);
  const add = vi.spyOn(identity, "addEventListener"), remove = vi.spyOn(identity, "removeEventListener");
  const expired = heldResponse([], 401); vi.mocked(openEventStream).mockResolvedValueOnce(expired.response);
  const abort = new AbortController(), task = streamEvents("session", () => {}, abort.signal);
  await vi.advanceTimersByTimeAsync(0); abort.abort(); await task;
  const handler = add.mock.calls.find(([type]) => type === "hosty:app-session-restored")?.[1];
  expect(handler).toBeTypeOf("function");
  expect(remove).toHaveBeenCalledWith("hosty:app-session-restored", handler);
  identity.dispatchEvent(new Event("hosty:app-session-restored"));
  await vi.advanceTimersByTimeAsync(10_000); expect(openEventStream).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
