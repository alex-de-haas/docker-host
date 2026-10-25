import { afterEach, expect, it, vi } from "vitest";
import { aggregateToolActivity, startHarnessToolActivity, type SessionToolActivity } from "./tool-activity.js";

afterEach(() => vi.useRealTimers());

it("aggregates by owner with failure before decisions before work", () => {
  const sessions: SessionToolActivity[] = [
    { userId: "one", status: "running", pending: 0 },
    { userId: "one", status: "awaiting_approval", pending: 2 },
    { userId: "one", status: "awaiting_question", pending: 1 },
    { userId: "one", status: "failed", pending: 0 },
    { userId: "two", status: "running", pending: 0 },
  ];
  expect(aggregateToolActivity(sessions).get("one")).toEqual({ state: "failed", count: 1 });
  expect(aggregateToolActivity(sessions.filter(s => s.status !== "failed")).get("one")).toEqual({ state: "needs-you", count: 3 });
  expect(aggregateToolActivity(sessions).get("two")).toEqual({ state: "working", count: 1 });
  expect(aggregateToolActivity([{ userId: "one", status: "cancelled", pending: 2 }]).get("one")).toEqual({ state: "idle" });
});

it("observes unopened sessions, clears removed owners and detaches on shutdown", async () => {
  vi.useFakeTimers();
  let notify!: () => void;
  const unsubscribe = vi.fn();
  const source = { subscribeToolActivity: vi.fn((listener: () => void) => { notify = listener; return unsubscribe; }),
    toolActivitySnapshot: vi.fn().mockResolvedValue([{ userId: "one", status: "awaiting_question", pending: 2 }]) };
  const reporter = { set: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
  const stop = startHarnessToolActivity(source, reporter);
  await vi.advanceTimersByTimeAsync(1);
  expect(reporter.set).toHaveBeenLastCalledWith("one", "assistant", { state: "needs-you", count: 2 });
  source.toolActivitySnapshot.mockResolvedValue([]);
  notify();
  await vi.advanceTimersByTimeAsync(50);
  expect(reporter.set).toHaveBeenLastCalledWith("one", "assistant", { state: "idle" });
  await stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(reporter.dispose).toHaveBeenCalledOnce();
});

it("retries failed reads without a browser event and processes a change during a snapshot read", async () => {
  vi.useFakeTimers();
  let notify!: () => void, finish!: (value: SessionToolActivity[]) => void;
  const source = { subscribeToolActivity: (listener: () => void) => { notify = listener; return () => {}; },
    toolActivitySnapshot: vi.fn().mockRejectedValueOnce(new Error("temporary")).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue([{ userId: "one", status: "running", pending: 0 }]) };
  const reporter = { set: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
  const stop = startHarnessToolActivity(source, reporter);
  await vi.advanceTimersByTimeAsync(1001);
  notify(); finish([]);
  await vi.advanceTimersByTimeAsync(1001);
  expect(reporter.set).toHaveBeenLastCalledWith("one", "assistant", { state: "working", count: 1 });
  await stop();
});
