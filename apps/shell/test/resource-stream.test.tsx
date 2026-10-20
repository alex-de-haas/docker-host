import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchResources, type ResourceView } from "../src/app/shell/resources/resource-stream";
import { subscribeToCoreEvents, CoreEventNames } from "../src/app/shell/events/core-event-stream";
import type { ResourceEvent, ResourceSnapshot } from "../src/app/shell/resources/resource-data";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.fetch }));
class FakeEventSource extends EventTarget {
  static OPEN = 1; static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { super(); FakeEventSource.instances.push(this); }
  open(supported = true) {
    this.readyState = 1; this.onopen?.();
    if (supported && this.url.includes("topics=")) this.emit("stream.ready", {
      ...(this.url.includes("resources") ? { resources: 1 } : {}), ...(this.url.includes("workspaces") ? { workspaces: 1 } : {}),
    });
  }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
  error() { this.readyState = 0; this.onerror?.(); }
  close() { this.readyState = 2; }
}
const origin = "http://core.test";
const base = Date.parse("2026-10-16T12:00:00Z");
function sample(sequence: number, runId = "one"): ResourceEvent {
  const timestamp = new Date(base + sequence * 3000).toISOString();
  return { runId, sequence, timestamp, logicalProcessors: 8, frame: { sequence, timestamp, services: [
    { appId: "app", service: "web", runtime: "localCommand", timestamp, cpuPercent: sequence, memoryBytes: 1024 },
  ] } };
}
function history(sequence: number, runId = "one"): ResourceSnapshot {
  return { runId, sequence, logicalProcessors: 8, now: new Date(base + sequence * 3000).toISOString(),
    history: Array.from({ length: sequence }, (_, i) => sample(i + 1, runId).frame) };
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const respond = (snapshot: ResourceSnapshot) => new Response(JSON.stringify(snapshot));
const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
const latestSource = () => FakeEventSource.instances.at(-1)!;
let disposers: (() => void)[];
function watch() {
  const views: ResourceView[] = [];
  const stop = watchResources(origin, view => views.push(view));
  disposers.push(stop);
  return { views, stop, latest: () => views.at(-1)! };
}
function visible(value: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: value ? "visible" : "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(base);
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  FakeEventSource.instances = []; disposers = [];
  transport.fetch.mockReset().mockImplementation(() => Promise.resolve(respond(history(1))));
});
afterEach(() => { for (const dispose of disposers) dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Dashboard resource delivery", () => {
  it("subscribes before its one history read and renders two minutes of samples without another GET", async () => {
    const view = watch();
    expect(transport.fetch).not.toHaveBeenCalled();
    const source = latestSource(); expect(source.url).toContain("?topics=resources");
    source.open(); await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch.mock.calls[0][0]).toBe(`${origin}/api/core/resources?stream=true`);
    for (let sequence = 2; sequence <= 42; sequence++) {
      await vi.advanceTimersByTimeAsync(3000);
      source.emit("resources.changed", {});
      source.emit("resources.sample", sample(sequence));
    }
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(view.latest().fresh).toBe(true);
    expect(view.latest().snapshot?.history).toHaveLength(42);
    expect(view.latest().snapshot?.sequence).toBe(42);
  });
  it("buffers during HTTP, ignores covered/duplicate events and never loses a newer frame", async () => {
    const request = defer<Response>(); transport.fetch.mockReturnValueOnce(request.promise);
    const view = watch(); const source = latestSource(); source.open();
    source.emit("resources.sample", sample(2)); source.emit("resources.sample", sample(3));
    request.resolve(respond(history(2))); await settle();
    source.emit("resources.sample", sample(3));
    expect(view.latest().snapshot?.history.map(f => f.sequence)).toEqual([1, 2, 3]);
    expect(view.latest().snapshot?.sequence).toBe(3);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not queue a second read for overlapping visibility/open signals or wait for an aborted generation", async () => {
    const old = defer<Response>(); const current = defer<Response>();
    transport.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = watch(); const source = latestSource(); source.open();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    source.error(); source.open();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    current.resolve(respond(history(3))); await settle();
    old.resolve(respond(history(1))); await settle();
    expect(view.latest().snapshot?.sequence).toBe(3);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });
  it("coalesces a sequence gap and overlapping hints into one recovery that fills the hole", async () => {
    const view = watch(); const source = latestSource(); source.open(); await settle();
    source.emit("resources.sample", sample(4)); source.emit("resources.sample", sample(5));
    for (let i = 0; i < 20; i++) source.emit("resources.changed", {});
    expect(view.latest().fresh).toBe(false);
    transport.fetch.mockResolvedValueOnce(respond(history(5)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(view.latest().snapshot?.history.map(f => f.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(view.latest().fresh).toBe(true);
  });
  it("recovers bounded-buffer overflow once instead of fetching for each queued sample", async () => {
    const request = defer<Response>(); transport.fetch.mockReturnValueOnce(request.promise);
    const view = watch(); const source = latestSource(); source.open();
    for (let seq = 1; seq <= 200; seq++) source.emit("resources.sample", sample(seq));
    request.resolve(respond(history(200))); await settle();
    expect(view.latest().fresh).toBe(false);
    transport.fetch.mockResolvedValueOnce(respond(history(200)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(view.latest().snapshot?.history).toHaveLength(101); // Five minutes at three seconds.
    expect(view.latest().fresh).toBe(true);
  });
  it("rejects HTTP history from an older run and replaces old history after Core restarts", async () => {
    const view = watch(); const source = latestSource(); source.open(); await settle();
    const request = defer<Response>(); transport.fetch.mockReturnValueOnce(request.promise);
    source.error(); source.open();
    source.emit("resources.sample", sample(1, "two"));
    request.resolve(respond(history(2))); await settle();
    expect(view.latest().fresh).toBe(false);
    transport.fetch.mockResolvedValueOnce(respond(history(2, "two")));
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.latest().snapshot?.runId).toBe("two");
    expect(view.latest().snapshot?.history).toHaveLength(2);
    expect(view.latest().fresh).toBe(true);
  });
  it("keeps failed recovery stale, backs off and never lets sample traffic bypass the backoff", async () => {
    transport.fetch.mockRejectedValue(new Error("offline"));
    const view = watch(); const source = latestSource(); source.open(); await settle();
    for (let seq = 1; seq < 10; seq++) source.emit("resources.sample", sample(seq));
    await vi.advanceTimersByTimeAsync(999); expect(transport.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(transport.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999); expect(transport.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(transport.fetch).toHaveBeenCalledTimes(3);
    expect(view.latest().fresh).toBe(false);
  });
  it("times out a stalled history read, retries once and ignores its late response", async () => {
    const old = defer<Response>(); transport.fetch.mockReturnValueOnce(old.promise);
    const view = watch(); latestSource().open();
    const signal = transport.fetch.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal.aborted).toBe(true);
    expect(view.latest().fresh).toBe(false);
    transport.fetch.mockResolvedValueOnce(respond(history(5)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    old.resolve(respond(history(1))); await settle();
    expect(view.latest().snapshot?.sequence).toBe(5);
  });
  it("marks silent data stale using only a local deadline", async () => {
    const view = watch(); latestSource().open(); await settle();
    expect(view.latest().fresh).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(view.latest().fresh).toBe(false);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
  it("releases hidden interest, aborts history and restores once without disrupting notifications", async () => {
    const notification = vi.fn();
    disposers.push(subscribeToCoreEvents(origin, { names: [CoreEventNames.notification], onSync: vi.fn(), onEvent: notification }));
    const request = defer<Response>(); transport.fetch.mockReturnValueOnce(request.promise);
    const view = watch(); const source = latestSource(); source.open();
    const signal = transport.fetch.mock.calls[0][1].signal as AbortSignal;
    visible(false);
    expect(source.readyState).toBe(2); expect(signal.aborted).toBe(true);
    expect(latestSource().url).not.toContain("topics");
    latestSource().open(); await settle(); latestSource().emit("notification", { title: "Still listening" });
    expect(notification).toHaveBeenCalledTimes(1);
    request.resolve(respond(history(20))); await settle();
    expect(view.latest().snapshot).toBeNull();
    visible(true); latestSource().open(); await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(view.latest().snapshot?.sequence).toBe(1);
    view.stop();
    expect(latestSource().url).not.toContain("topics");
  });
  it("does not subscribe or fetch for a Dashboard mounted hidden", async () => {
    visible(false); watch();
    expect(FakeEventSource.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(120_000); expect(transport.fetch).not.toHaveBeenCalled();
    visible(true); latestSource().open(); await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
  it("shares the stream across viewers and keeps resource interest until the last leaves", async () => {
    const one = watch(); latestSource().open(); await settle();
    const source = latestSource(); const two = watch(); await settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    one.stop(); expect(source.readyState).toBe(1);
    source.emit("resources.sample", sample(2)); expect(two.latest().snapshot?.sequence).toBe(2);
    two.stop(); expect(source.readyState).toBe(2);
  });
  it("restores a page from the back/forward cache with one new subscription and history read", async () => {
    watch(); latestSource().open(); await settle();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(latestSource().readyState).toBe(2);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    latestSource().open(); await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });
  it("requests workspace hints only for visible workspace consumers and shares the resource connection", async () => {
    const notification = subscribeToCoreEvents(origin, { names: [CoreEventNames.notification], onSync: vi.fn() });
    disposers.push(notification);
    expect(latestSource().url).not.toContain("topics");
    const workspace = () => subscribeToCoreEvents(origin, { names: [CoreEventNames.workspaceChanged], topic: "workspaces", onSync: vi.fn() });
    const one = workspace(); disposers.push(one);
    expect(latestSource().url).toContain("topics=workspaces");
    const source = latestSource(); source.open(); await settle();
    const two = workspace(); disposers.push(two);
    expect(latestSource()).toBe(source);
    const resources = watch(); latestSource().open(); await settle();
    expect(latestSource().url).toContain("topics=resources,workspaces");
    one(); expect(latestSource().url).toContain("workspaces");
    visible(false);
    expect(latestSource().url).not.toContain("topics");
    visible(true); latestSource().open(); await settle();
    expect(latestSource().url).toContain("topics=resources,workspaces");
    two(); expect(latestSource().url).toContain("topics=resources");
    expect(latestSource().url).not.toContain("workspaces");
    resources.stop(); expect(latestSource().url).not.toContain("topics");
  });
  it("uses legacy hint/lease reads only for an open stream without resource capability", async () => {
    watch(); const source = latestSource(); source.open(false);
    await vi.advanceTimersByTimeAsync(1999); expect(transport.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch.mock.calls[0][0]).toBe(`${origin}/api/core/resources`);
    await vi.advanceTimersByTimeAsync(10_000); expect(transport.fetch).toHaveBeenCalledTimes(2);
    source.error(); await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    source.open(); await settle();
    expect(transport.fetch.mock.calls[2][0]).toContain("stream=true");
    await vi.advanceTimersByTimeAsync(30_000); expect(transport.fetch).toHaveBeenCalledTimes(3);
  });
  it("reopens a stream closed by a proxy error with capped backoff and cancels retries on unmount", async () => {
    const view = watch(); latestSource().open(); await settle();
    const failClosed = () => { latestSource().readyState = 2; latestSource().onerror?.(); };
    failClosed();
    await vi.advanceTimersByTimeAsync(999); expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(FakeEventSource.instances).toHaveLength(2);
    failClosed();
    await vi.advanceTimersByTimeAsync(2999); expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(FakeEventSource.instances).toHaveLength(3);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    latestSource().open(); await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    failClosed(); view.stop();
    await vi.advanceTimersByTimeAsync(120_000); expect(FakeEventSource.instances).toHaveLength(3);
  });
  it("does not interpret a failed connection as an unsupported Core", async () => {
    watch(); const source = latestSource(); source.open(false); source.error();
    await vi.advanceTimersByTimeAsync(120_000); expect(transport.fetch).not.toHaveBeenCalled();
    source.open(); await settle(); expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
});
