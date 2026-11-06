import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRefreshQueue, recordSourceChange, changedRepositories } from "./refresh-queue";
let page: EventTarget & { visibilityState: string };
beforeEach(() => { vi.useFakeTimers(); page = Object.assign(new EventTarget(), { visibilityState: "visible" }); vi.stubGlobal("document", page); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("finishes an in-flight load and merges a burst into one scoped follow-up", async () => {
  let finish!: () => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const queue = createRefreshQueue(load);
  queue.request(); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 100; i++) queue.request([i % 2 ? "a" : "b"]);
  await vi.advanceTimersByTimeAsync(20000);
  expect(load).toHaveBeenCalledOnce(); expect(load.mock.calls[0][1].aborted).toBe(false);
  finish(); await vi.advanceTimersByTimeAsync(4999); expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls[1][0].repositories.sort()).toEqual(["a", "b"]);
  await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(2); queue.dispose();
});
it("manual refresh preserves in-flight work, promotes full scope and skips the interval", async () => {
  let finish!: () => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const queue = createRefreshQueue(load); queue.request(["a"]); await vi.advanceTimersByTimeAsync(0);
  queue.request(["b"]); queue.request(undefined, true); expect(load.mock.calls[0][1].aborted).toBe(false);
  finish(); await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2); expect(load.mock.calls[1][0]).toEqual({ repositories: undefined, manual: true }); queue.dispose();
});
it("hidden pages abort work, stop refreshing and resynchronize when visible", async () => {
  const load = vi.fn((_request, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
  const queue = createRefreshQueue(load); queue.request(); await vi.advanceTimersByTimeAsync(0);
  page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
  queue.request(["a"]); await vi.advanceTimersByTimeAsync(60000);
  expect(load).toHaveBeenCalledOnce(); expect(load.mock.calls[0][1].aborted).toBe(true);
  page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2); expect(load.mock.calls[1][0].repositories).toBeUndefined();
  queue.dispose(); await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(2);
});
it("retains all scoped events across a batched React render and full recovery dominates", () => {
  const initial = { revision: 0, full: 0, repositories: {} };
  const first = recordSourceChange(recordSourceChange(initial, ["a"]), ["b"]);
  expect(changedRepositories(first, 0)).toEqual(["a", "b"]);
  expect(changedRepositories(recordSourceChange(first, ["b"]), first.revision)).toEqual(["b"]);
  expect(changedRepositories(recordSourceChange(recordSourceChange(first), ["a"]), first.revision)).toBeUndefined();
});
