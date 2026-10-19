// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: mock.fetch }));
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
    expect(sync).toHaveBeenCalledTimes(2);
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

  it("detects a silent connection and removes source when access is revoked", async () => {
    const unavailable = vi.fn();
    cleanup.push(subscribeWorkspaceEvents("/events", vi.fn(async () => {}), unavailable));
    await vi.advanceTimersByTimeAsync(0); emit("stream.ready"); await vi.advanceTimersByTimeAsync(45_100);
    expect(unavailable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); emit("stream.revoked"); await vi.advanceTimersByTimeAsync(0);
    expect(unavailable).toHaveBeenCalledTimes(2);
  });
});
