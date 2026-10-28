import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchSandboxEvents } from "../src/app/shell/events/sandbox-events";
import { CoreEventNames, subscribeToCoreEvents, type CoreStreamState } from "../src/app/shell/events/core-event-stream";

class Source extends EventTarget {
  static OPEN = 1; static CLOSED = 2; static instances: Source[] = [];
  readyState = 0; onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { super(); Source.instances.push(this); }
  open(capabilities: Record<string, number> | null = { sandboxes: 1 }) {
    this.readyState = 1; this.onopen?.(); if (capabilities) this.emit("stream.ready", capabilities);
  }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
  close() { this.readyState = 2; }
  error() { this.readyState = 0; this.onerror?.(); }
}
const origin = "https://sandbox-stream.test";
const empty = { environments: [], instances: [] };
let stops: (() => void)[];
const latest = () => Source.instances.at(-1)!;
function visibility(value: string) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value }); document.dispatchEvent(new Event("visibilitychange"));
}
function watch() {
  const refresh = vi.fn(async () => {}), render = vi.fn();
  stops.push(watchSandboxEvents(origin, refresh, render)); return { refresh, render };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("EventSource", Source); Source.instances = []; stops = []; visibility("visible");
});
afterEach(() => { for (const stop of stops) stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("applies complete data for two idle minutes without inventory HTTP reads", async () => {
  const view = watch(); latest().open(); latest().emit("sandbox.snapshot", empty);
  latest().emit("sandbox.snapshot", { ...empty, environments: [{ id: "one", state: "starting" }] });
  latest().emit("sandbox.snapshot", { ...empty, environments: [{ id: "one", state: "running" }] });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(view.render).toHaveBeenCalledTimes(3); expect(view.refresh).not.toHaveBeenCalled();
  expect(Source.instances.filter(source => source.readyState !== 2)).toHaveLength(1);
});
it("replaces state on reconnect and visibility return without periodic fetches", async () => {
  const view = watch(); latest().open(); latest().emit("sandbox.snapshot", empty);
  latest().error(); await vi.advanceTimersByTimeAsync(5000); expect(view.refresh).toHaveBeenCalledTimes(1);
  latest().open(); latest().emit("sandbox.snapshot", empty); view.refresh.mockClear();
  visibility("hidden"); await vi.advanceTimersByTimeAsync(60_000); expect(view.refresh).not.toHaveBeenCalled();
  visibility("visible"); latest().open(); latest().emit("sandbox.snapshot", empty);
  await vi.advanceTimersByTimeAsync(60_000); expect(view.refresh).not.toHaveBeenCalled();
});
it("polls on legacy Core and stops its fallback after capability recovery", async () => {
  const view = watch(); latest().open(null); await vi.advanceTimersByTimeAsync(12_000);
  expect(view.refresh).toHaveBeenCalledTimes(3);
  latest().error(); latest().open(); latest().emit("sandbox.snapshot", empty); view.refresh.mockClear();
  await vi.advanceTimersByTimeAsync(60_000); expect(view.refresh).not.toHaveBeenCalled();
});
it("keeps resources streamed when the same older Core lacks sandbox support", async () => {
  const states: CoreStreamState[] = [];
  stops.push(subscribeToCoreEvents(origin, { topic: "resources", names: [CoreEventNames.resourcesSample], onSync() {}, onStreamState: state => states.push(state) }));
  const view = watch(); latest().open({ resources: 1 }); await vi.advanceTimersByTimeAsync(10_000);
  expect(states.at(-1)).toBe("stream"); expect(view.refresh).toHaveBeenCalledTimes(3);
  expect(Source.instances.filter(source => source.readyState !== 2)).toHaveLength(1);
});
it("bounds recovery for missing or malformed initial snapshots", async () => {
  const view = watch(); latest().open(); await vi.advanceTimersByTimeAsync(15_000);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  latest().emit("sandbox.snapshot", { environments: null, instances: [] });
  expect(view.refresh).toHaveBeenCalledTimes(2); expect(view.render).not.toHaveBeenCalled();
  latest().emit("sandbox.snapshot", { environments: null, coreError: "Unavailable", instances: [] });
  expect(view.render).toHaveBeenCalledTimes(1);
});
