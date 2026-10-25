import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolActivityReporter } from "@hosty-sdk/app/tool-activity/server";
import { afterEach, expect, it, vi } from "vitest";
import { aggregateToolActivity, startHarnessToolActivity, ToolActivityOwners, type SessionToolActivity } from "./tool-activity.js";

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

it("recovers a deleted owner's failed clear after restart and removes acknowledged owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-tool-activity-"));
  const stops: (() => Promise<void>)[] = [];
  let sessions: SessionToolActivity[] = [{ userId: "one", status: "awaiting_question", pending: 1 }];
  let notify!: () => void, failClear = false, coreState = "idle";
  const source = { subscribeToolActivity: (listener: () => void) => { notify = listener; return () => {}; },
    toolActivitySnapshot: async () => sessions };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (body.state !== "idle")
      expect(JSON.parse(await readFile(path.join(root, "tool-activity-owners.json"), "utf8"))).toContain(body.userId);
    if (body.state === "idle" && failClear) throw new Error("offline");
    coreState = body.state;
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetcher);
  const start = () => {
    const owners = new ToolActivityOwners(root);
    const reporter = new ToolActivityReporter({ appId: "test.app", installationId: "one", serviceToken: "test",
      coreOrigin: "http://core.test", onReported: (userId, panelId, value) => owners.acknowledge(userId, panelId, value) });
    const stop = startHarnessToolActivity(source, reporter, owners);
    stops.push(stop);
    return stop;
  };
  try {
    const stopFirst = start();
    await vi.waitFor(() => expect(coreState).toBe("needs-you"));
    expect(JSON.parse(await readFile(path.join(root, "tool-activity-owners.json"), "utf8"))).toEqual(["one"]);
    failClear = true; sessions = []; notify();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([, init]) => JSON.parse(init!.body as string).state === "idle")).toBe(true));
    await stopFirst();
    expect(coreState).toBe("needs-you");
    failClear = false;
    const stopSecond = start();
    await vi.waitFor(() => expect(coreState).toBe("idle"));
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(root, "tool-activity-owners.json"), "utf8"))).toEqual([]));
    await stopSecond();
    expect(await new ToolActivityOwners(root).reconcile(new Map())).toEqual(new Set());
  } finally {
    for (const stop of stops) await stop();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not forget a renewed owner when an earlier clear acknowledgement arrives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-tool-activity-"));
  try {
    const owners = new ToolActivityOwners(root);
    await owners.reconcile(new Map([["one", { state: "failed" }]]));
    await owners.reconcile(new Map());
    const clearing = owners.acknowledge("one", "assistant", { state: "idle" });
    const renewed = owners.reconcile(new Map([["one", { state: "needs-you" }]]));
    await Promise.all([clearing, renewed]);
    expect(await new ToolActivityOwners(root).reconcile(new Map())).toEqual(new Set(["one"]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
