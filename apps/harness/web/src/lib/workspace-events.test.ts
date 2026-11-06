// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./event-stream", () => ({ openEventStream: mock.fetch }));
import { subscribeWorkspaceEvents } from "./workspace-events";

describe("shared workspace event stream", () => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const cleanup: (() => void)[] = [];
  const emit = (event: string, index = streams.length - 1) => streams[index].enqueue(new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`));
  beforeEach(() => {
    vi.useFakeTimers(); streams.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    mock.fetch.mockReset().mockImplementation(async (_url: string, options: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        streams.push(controller);
        options.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} }, { once: true });
      } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
  });
  afterEach(async () => { for (const dispose of cleanup.splice(0)) dispose(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

  it("shares one connection, synchronizes after ready and does no periodic reads", async () => {
    const first = vi.fn(async () => {}), second = vi.fn(async () => {});
    cleanup.push(subscribeWorkspaceEvents("/events", first, vi.fn()), subscribeWorkspaceEvents("/events", second, vi.fn()));
    await vi.advanceTimersByTimeAsync(0); expect(mock.fetch).toHaveBeenCalledTimes(1);
    emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) { emit("stream.ping"); await vi.advanceTimersByTimeAsync(20_000); }
    expect(first).toHaveBeenCalledTimes(1); expect(mock.fetch).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) emit("workspace.changed");
    await vi.advanceTimersByTimeAsync(200); expect(first).toHaveBeenCalledTimes(2);
  });

  it("keeps an event arriving during synchronization and coalesces the follow-up", async () => {
    let finish!: () => void;
    const sync = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    cleanup.push(subscribeWorkspaceEvents("/events", sync, vi.fn()));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    emit("workspace.changed"); emit("workspace.changed"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(1); finish(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4999); expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(sync).toHaveBeenCalledTimes(2);
  });

  it("bounds sustained hints, retains the trailing change and stops when quiet", async () => {
    const sync = vi.fn(async () => {});
    cleanup.push(subscribeWorkspaceEvents("/burst", sync, vi.fn()));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 120; i++) { emit("workspace.changed"); await vi.advanceTimersByTimeAsync(250); }
    expect(sync).toHaveBeenCalledTimes(7);
    // A change after the last snapshot remains pending, even if no further event arrives.
    emit("workspace.changed"); await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(8);
    emit("stream.ping"); await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(8);
  });

  it("does not let hints bypass failure backoff or retain work after unsubscribe", async () => {
    const sync = vi.fn(async () => false), unavailable = vi.fn();
    const dispose = subscribeWorkspaceEvents("/failed-burst", sync, unavailable); cleanup.push(dispose);
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 24; i++) { emit("workspace.changed"); await vi.advanceTimersByTimeAsync(250); }
    expect(sync).toHaveBeenCalledTimes(3); // 0, 1, 3 seconds; next retry is at 7.
    dispose(); await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("drops a hidden page's queued work and immediately resynchronizes on return", async () => {
    const sync = vi.fn(async () => {});
    cleanup.push(subscribeWorkspaceEvents("/hidden-burst", sync, vi.fn()));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
    emit("workspace.changed"); await vi.advanceTimersByTimeAsync(200);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1000); expect(sync).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); expect(sync).toHaveBeenCalledTimes(2);
  });

  it("clears data on a lost stream and resynchronizes after reconnect and visibility return", async () => {
    const sync = vi.fn(async () => {}), unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/events", sync, unavailable));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    streams[0].close(); await vi.advanceTimersByTimeAsync(0); expect(unavailable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000); expect(mock.fetch).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(3); expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("loads older Core snapshots without periodic reads and adopts SSE after an upgrade", async () => {
    const supported = mock.fetch.getMockImplementation()!;
    mock.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    const sync = vi.fn(async () => {}), unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/legacy", sync, unavailable));
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.fetch).toHaveBeenCalledTimes(3); expect(sync).toHaveBeenCalledTimes(1);
    const refreshed = vi.fn(async () => {});
    cleanup.push(subscribeWorkspaceEvents("/legacy", refreshed, unavailable));
    await vi.advanceTimersByTimeAsync(0); expect(refreshed).toHaveBeenCalledTimes(1);
    mock.fetch.mockImplementation(supported);
    await vi.advanceTimersByTimeAsync(30_000); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(2); expect(refreshed).toHaveBeenCalledTimes(2);
  });

  it("retains snapshot compatibility after unsupported socket hints and probes without periodic reads", async () => {
    const sync = vi.fn(async () => {}), unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/legacy-socket", sync, unavailable));
    await vi.advanceTimersByTimeAsync(0); emit("stream.unsupported"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); emit("stream.unsupported"); await vi.advanceTimersByTimeAsync(200);
    expect(mock.fetch).toHaveBeenCalledTimes(2); expect(sync).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
    const entered = vi.fn(async () => {});
    cleanup.push(subscribeWorkspaceEvents("/legacy-socket", entered, unavailable));
    await vi.advanceTimersByTimeAsync(0); expect(entered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(2); expect(entered).toHaveBeenCalledTimes(2);
    expect(mock.fetch).toHaveBeenCalledTimes(3); expect(unavailable).not.toHaveBeenCalled();
  });

  it("never treats a forbidden stream as legacy compatibility", async () => {
    mock.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    const sync = vi.fn(async () => {}), unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/forbidden", sync, unavailable));
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).not.toHaveBeenCalled(); expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it.each([403, 500, 200].flatMap(status => [false, true].map(cancelFails => ({ status, cancelFails }))))(
    "closes rejected browser responses and reconnects (status $status, cancellation fails $cancelFails)",
    async ({ status, cancelFails }) => {
      const cancel = vi.fn(() => cancelFails ? Promise.reject(new Error("cleanup failed")) : Promise.resolve());
      const rejected = new Response(new ReadableStream({ cancel }), { status, headers: { "content-type": "text/plain" } });
      mock.fetch.mockResolvedValueOnce(rejected);
      const sync = vi.fn(async () => {}), unavailable = vi.fn();
      cleanup.push(subscribeWorkspaceEvents("/rejected-body", sync, unavailable));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1); expect(sync).not.toHaveBeenCalled();
      expect(unavailable).toHaveBeenCalledTimes(1); expect(mock.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mock.fetch).toHaveBeenCalledTimes(2);
      emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
      expect(sync).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 405])("retains legacy compatibility when response cancellation fails (%i)", async status => {
    const cancel = vi.fn(async () => { throw new Error("cleanup failed"); });
    mock.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    const sync = vi.fn(async () => {}), unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/legacy-cleanup", sync, unavailable));
    await vi.advanceTimersByTimeAsync(200);
    expect(cancel).toHaveBeenCalledTimes(1); expect(sync).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("retries failed snapshots without requiring a new workspace event", async () => {
    const sync = vi.fn<() => Promise<void | boolean>>().mockResolvedValueOnce(false).mockResolvedValue(undefined);
    const unavailable = vi.fn();
    const dispose = subscribeWorkspaceEvents("/snapshot-retry", sync, unavailable); cleanup.push(dispose);
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(200);
    expect(unavailable).toHaveBeenCalledTimes(1); expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(2); expect(mock.fetch).toHaveBeenCalledTimes(1);
    sync.mockRejectedValue(new Error("temporary failure")); emit("workspace.changed"); await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(3);
    dispose(); await vi.advanceTimersByTimeAsync(5000); expect(sync).toHaveBeenCalledTimes(3);
  });

  it("detects a silent connection and removes source when access is revoked", async () => {
    const unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/events", vi.fn(async () => {}), unavailable));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(45_100);
    expect(unavailable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); emit("stream.revoked"); await vi.advanceTimersByTimeAsync(0);
    expect(unavailable).toHaveBeenCalledTimes(2);
  });
});
