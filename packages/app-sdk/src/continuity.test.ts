// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configureAppContinuity, ensureAppContinuity, APP_CONTINUITY_UPDATED } from "./continuity-browser";
import { readAppContinuity } from "./continuity";
import { appFetch, APP_ACTIVITY_RENEWED } from "./browser-auth";

let cleanup: (() => void) | undefined;
afterEach(async () => { cleanup?.(); cleanup = undefined; await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const authority = { version: 1 as const, mode: "browser" as const, grantId: "public-reference", expiresAt: "2030-01-01T00:00:00Z", checkAfterSeconds: 300 };
function reply(status = "maintained", origin = "http://core.localhost", wrongSource = false) {
  const frame = document.querySelector("iframe")!;
  window.dispatchEvent(new MessageEvent("message", { origin, source: wrongSource ? window : frame.contentWindow,
    data: { type: "hosty:continuity-result", status, state: new URL(frame.src).searchParams.get("state") } }));
}

it("coalesces checks, authenticates frame replies and does not emit explicit recovery events", async () => {
  vi.useFakeTimers();
  const probe = vi.fn().mockResolvedValue(true);
  const updates = vi.fn(); const renewals = vi.fn();
  window.addEventListener(APP_CONTINUITY_UPDATED, updates); window.addEventListener(APP_ACTIVITY_RENEWED, renewals);
  cleanup = configureAppContinuity({ coreOrigin: "http://core.localhost", authority, probe });
  const first = ensureAppContinuity(); const second = ensureAppContinuity();
  reply("maintained", "http://wrong.localhost"); reply("maintained", "http://core.localhost", true);
  expect(probe).not.toHaveBeenCalled();
  reply(); expect(await first).toBe(true); expect(await second).toBe(true);
  expect(probe).toHaveBeenCalledTimes(1); expect(updates).toHaveBeenCalledTimes(1); expect(renewals).not.toHaveBeenCalled();
  expect(document.querySelector("iframe")).toBeNull();
  window.removeEventListener(APP_CONTINUITY_UPDATED, updates); window.removeEventListener(APP_ACTIVITY_RENEWED, renewals);
});

it("blocked frame transport does not turn a valid probe into logout", async () => {
  vi.useFakeTimers(); const probe = vi.fn().mockResolvedValue(true);
  cleanup = configureAppContinuity({ coreOrigin: "http://core.localhost", authority, probe });
  const pending = ensureAppContinuity();
  await vi.advanceTimersByTimeAsync(4000);
  expect(await pending).toBe(true); expect(probe).toHaveBeenCalledTimes(1);
});

it.each([true, false])("keeps one maintenance timer after concurrent wake events (probe=%s)", async result => {
  vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
  let resolve!: (value: boolean) => void;
  const first = new Promise<boolean>(done => { resolve = done; });
  const probe = vi.fn().mockReturnValueOnce(first).mockResolvedValue(result);
  cleanup = configureAppContinuity({ coreOrigin: "http://core.localhost", authority: { ...authority, mode: "native" }, probe });
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  expect(probe).toHaveBeenCalledTimes(1);
  resolve(result);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(result ? 300_000 : 30_000);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  cleanup(); cleanup = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses protected dispatch during outage and recovers without replay on network return", async () => {
  vi.useFakeTimers(); const probe = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
  const fetcher = vi.fn().mockResolvedValue(new Response("ok")); vi.stubGlobal("fetch", fetcher);
  cleanup = configureAppContinuity({ coreOrigin: "http://core.localhost", authority: { ...authority, mode: "native" }, probe });
  await ensureAppContinuity();
  expect((await appFetch("/api/write", { method: "POST", body: "draft" })).status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("online")); await ensureAppContinuity();
  expect(fetcher).not.toHaveBeenCalled();
  expect((await appFetch("/api/write", { method: "POST", body: "draft" })).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not invent continuity for old servers and clamps advertised timer values", () => {
  vi.useFakeTimers(); expect(readAppContinuity(undefined)).toBeUndefined();
  expect(readAppContinuity({ ...authority, version: 2 })).toBeUndefined();
  expect(readAppContinuity({ ...authority, checkAfterSeconds: 10000 })?.checkAfterSeconds).toBe(300);
});
