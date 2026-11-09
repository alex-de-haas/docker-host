import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolActivityReporter } from "./tool-activity-server";

const options = { appId: "test.app", installationId: "installation-one", serviceToken: "test-service", coreOrigin: "http://core.test" };
let reporter: ToolActivityReporter;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}"))); });
afterEach(async () => { await reporter?.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const bodies = () => vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string));

it("reports without a browser and re-reports retained decisions after Core loses memory", async () => {
  reporter = new ToolActivityReporter(options);
  reporter.set("user-one", "assistant", { state: "needs-you", count: 3 });
  await reporter.flush();
  expect(bodies()).toEqual([{ userId: "user-one", installationId: "installation-one", panelId: "assistant", state: "needs-you", count: 3 }]);
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer test-service" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(bodies()).toHaveLength(2);
  expect(bodies()[1]).toEqual(bodies()[0]);
  reporter.set("user-one", "assistant", { state: "idle" });
  await reporter.flush();
  expect(bodies().at(-1).state).toBe("idle");
  const count = bodies().length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(bodies()).toHaveLength(count);
});

it("retries disconnection, retains installation identity and renews short presence before TTL", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
  reporter = new ToolActivityReporter(options);
  reporter.set("user-one", "assistant", { state: "working", ttlSeconds: 3 });
  await reporter.flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(bodies()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(bodies()).toHaveLength(3);
  expect(bodies().every(b => b.installationId === "installation-one")).toBe(true);
});

it("does not acknowledge a newer value when an older in-flight clear finishes", async () => {
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  reporter = new ToolActivityReporter(options);
  reporter.set("user-one", "assistant", { state: "idle" });
  reporter.set("user-one", "assistant", { state: "failed", count: 1 });
  finish(new Response("{}"));
  await reporter.flush();
  await vi.advanceTimersByTimeAsync(250);
  expect(bodies().at(-1)).toMatchObject({ state: "failed", count: 1 });
});

it("keeps users and panels separate and bounds unsupported input", async () => {
  reporter = new ToolActivityReporter(options);
  reporter.set("one", "assistant", { state: "working" });
  reporter.set("two", "assistant", { state: "failed" });
  reporter.set("one", "terminal", { state: "needs-you" });
  await reporter.flush();
  expect(bodies()).toHaveLength(3);
  expect(() => reporter.set("one", "assistant", { state: "working", ttlSeconds: 301 })).toThrow();
  expect(() => reporter.set("one", "assistant", { state: "failed", count: -1 })).toThrow();
  expect(() => reporter.set("one", "assistant", { state: "failed", label: "x".repeat(121) })).toThrow();
  await reporter.dispose();
  const count = bodies().length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(bodies()).toHaveLength(count);
});

it("retries a failed durable acknowledgement before forgetting an idle clear", async () => {
  const acknowledge = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
  reporter = new ToolActivityReporter({ ...options, onReported: acknowledge });
  reporter.set("one", "assistant", { state: "idle" });
  await reporter.flush();
  expect(acknowledge).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(acknowledge).toHaveBeenCalledTimes(2);
  const count = bodies().length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(bodies()).toHaveLength(count);
});

it("retains a new state while a successful clear acknowledgement is in flight", async () => {
  let finish!: () => void;
  const acknowledge = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  reporter = new ToolActivityReporter({ ...options, onReported: acknowledge });
  reporter.set("one", "assistant", { state: "idle" });
  await vi.advanceTimersByTimeAsync(1);
  reporter.set("one", "assistant", { state: "needs-you", count: 1 });
  finish();
  await reporter.flush();
  await vi.advanceTimersByTimeAsync(250);
  expect(bodies().at(-1)).toMatchObject({ state: "needs-you", count: 1 });
  expect(acknowledge).toHaveBeenLastCalledWith("one", "assistant", { state: "needs-you", count: 1 });
});

it("does not acknowledge a rejected Core report", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response("denied", { status: 403 }));
  const acknowledge = vi.fn();
  reporter = new ToolActivityReporter({ ...options, onReported: acknowledge });
  reporter.set("one", "assistant", { state: "idle" });
  await reporter.flush();
  expect(acknowledge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(acknowledge).toHaveBeenCalledOnce();
});
