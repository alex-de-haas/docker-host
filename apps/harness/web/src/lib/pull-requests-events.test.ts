// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fetch: vi.fn(), request: vi.fn() }));
vi.mock("./event-stream", () => ({ openEventStream: mock.fetch }));
vi.mock("./pull-requests-api", () => ({ prKey: (pr: { repositoryId: string; number: number }) => `${pr.repositoryId}:${pr.number}`, prRequest: mock.request }));
import { subscribePullRequests } from "./pull-requests-events";
import { APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";
const dispose: (() => void)[] = [];
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const signals: AbortSignal[] = [];
beforeEach(() => {
  vi.useFakeTimers(); streams.length = 0; signals.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  mock.request.mockReset().mockResolvedValue({ id: "a".repeat(32) });
  mock.fetch.mockReset().mockImplementation(async (_url: string, options: RequestInit) => {
    signals.push(options.signal!);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.push(controller); options.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  });
});
afterEach(async () => { dispose.splice(0).forEach(d => d()); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });
const emit = (event: string, index = streams.length - 1) => streams[index].enqueue(new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`));
it("unions only visible consumer scopes, shares a stream and releases demand on hide/unmount", async () => {
  const sync = vi.fn(async () => {}), failed = vi.fn();
  dispose.push(subscribePullRequests("owner", { scope: { allInstalled: true, pullRequests: [{ repositoryId: "r", number: 1 }] }, sync, failed }));
  const leave = subscribePullRequests("owner", { scope: { pullRequests: [{ repositoryId: "r", number: 2 }], workspaces: ["w"] }, sync, failed }); dispose.push(leave);
  await vi.advanceTimersByTimeAsync(150);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(mock.request.mock.calls[0][1]).toEqual({ allInstalled: true, repositories: [], pullRequests: [{ repositoryId: "r", number: 1 }, { repositoryId: "r", number: 2 }], workspaces: ["w"] });
  const reads = sync.mock.calls.length;
  emit("stream.ping"); await vi.advanceTimersByTimeAsync(30_000); expect(sync).toHaveBeenCalledTimes(reads);
  leave(); await vi.advanceTimersByTimeAsync(150); expect(signals[0].aborted).toBe(true);
  expect(mock.request.mock.calls.at(-1)![1].pullRequests).toHaveLength(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange"));
  expect(signals.at(-1)!.aborted).toBe(true); const starts = mock.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(300_000); expect(mock.fetch).toHaveBeenCalledTimes(starts);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(150); expect(mock.fetch).toHaveBeenCalledTimes(starts + 1);
});
it("isolates owners and re-reads authoritative state on ready, change and revoked events", async () => {
  const first = vi.fn(async () => {}), second = vi.fn(async () => {}), failed = vi.fn();
  dispose.push(subscribePullRequests("one", { scope: { allInstalled: true }, sync: first, failed }));
  dispose.push(subscribePullRequests("two", { scope: { allInstalled: true }, sync: second, failed }));
  await vi.advanceTimersByTimeAsync(150); expect(mock.fetch).toHaveBeenCalledTimes(2);
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  emit("stream.ready", 0); await vi.advanceTimersByTimeAsync(0);
  const initial = second.mock.calls.length;
  emit("stream.ready"); await vi.advanceTimersByTimeAsync(0); expect(second).toHaveBeenCalledTimes(initial + 1);
  emit("pull-requests.changed"); await vi.advanceTimersByTimeAsync(4999); expect(second).toHaveBeenCalledTimes(initial + 1);
  await vi.advanceTimersByTimeAsync(1); expect(second).toHaveBeenCalledTimes(initial + 2);
  emit("stream.revoked"); await vi.advanceTimersByTimeAsync(0); expect(second).toHaveBeenCalledTimes(initial + 3); expect(failed).toHaveBeenCalled();
  expect(first).toHaveBeenCalledTimes(1);
});

it("bounds a sustained notification burst to one snapshot per five seconds and preserves its final state", async () => {
  let latest = 0, rendered = 0;
  const sync = vi.fn(async () => { rendered = latest; });
  dispose.push(subscribePullRequests("burst", { scope: { allInstalled: true }, sync, failed: vi.fn() }));
  await vi.advanceTimersByTimeAsync(150); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  expect(sync).toHaveBeenCalledTimes(1);
  for (let i = 1; i <= 120; i++) {
    latest = i; emit("pull-requests.changed"); await vi.advanceTimersByTimeAsync(500);
  }
  expect(sync.mock.calls.length).toBeLessThanOrEqual(13);
  await vi.advanceTimersByTimeAsync(5000);
  expect(rendered).toBe(120);
  const reads = sync.mock.calls.length;
  emit("stream.ping"); await vi.advanceTimersByTimeAsync(15000);
  expect(sync).toHaveBeenCalledTimes(reads);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
it("does not overlap slow snapshots or immediately drain queued hints after a slow response", async () => {
  let complete!: () => void;
  const sync = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  dispose.push(subscribePullRequests("slow", { scope: { allInstalled: true }, sync, failed: vi.fn() }));
  await vi.advanceTimersByTimeAsync(150); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) { emit("pull-requests.changed"); await vi.advanceTimersByTimeAsync(1000); }
  expect(sync).toHaveBeenCalledTimes(1);
  complete(); await vi.advanceTimersByTimeAsync(4999); expect(sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(sync).toHaveBeenCalledTimes(2);
  complete(); await vi.advanceTimersByTimeAsync(0);
});
it("cancels a queued read while hidden and reconciles only once on restoration", async () => {
  const sync = vi.fn(async () => {});
  dispose.push(subscribePullRequests("hidden", { scope: { allInstalled: true }, sync, failed: vi.fn() }));
  await vi.advanceTimersByTimeAsync(150); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  emit("pull-requests.changed"); await vi.advanceTimersByTimeAsync(100);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60000); expect(sync).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(150);
  expect(sync).toHaveBeenCalledTimes(1); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  expect(sync).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED)); await vi.advanceTimersByTimeAsync(150);
  expect(sync).toHaveBeenCalledTimes(2); emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  expect(sync).toHaveBeenCalledTimes(3);
});
it("does not read for a hidden subscriber or after the last subscriber leaves", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  const sync = vi.fn(async () => {});
  const leave = subscribePullRequests("initial-hidden", { scope: { allInstalled: true }, sync, failed: vi.fn() });
  dispose.push(leave); await vi.advanceTimersByTimeAsync(60000);
  expect(sync).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(150);
  emit("stream.ready"); await vi.advanceTimersByTimeAsync(0);
  emit("pull-requests.changed"); await vi.advanceTimersByTimeAsync(100); leave();
  await vi.advanceTimersByTimeAsync(60000); expect(sync).toHaveBeenCalledTimes(1);
});
